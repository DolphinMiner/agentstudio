// Package concierge implements the deterministic reference agent described in
// docs/agent-protocol.md ("Reference agent: concierge"). It keeps sessions in
// memory; the agents bridge re-registers its sessions on startup and when a call
// returns 404, so losing them on restart is fine.
package concierge

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// Fixed texts from docs/agent-protocol.md. Tests rely on them verbatim.
const (
	Name             = "Concierge"
	Description      = "AgentStudio's reference agent. Ask it about flights, or ask it to draft replies."
	FlightStatusText = "Searching flights"
	FlightFound      = "Found a nonstop to Toronto on Friday at 6:00 PM for $412."
	FlightTitle      = "Book the 6pm flight to Toronto for $412?"
	FlightExpiry     = 2700
	BookedText       = "Booked. Seat 14A, confirmation PCH412."
	SkippedText      = "Okay, I won't book it."
	ChoiceBook       = "book"
	ChoiceSkip       = "skip"
	flightPrefix     = "flight-"
)

// Drafts are the three canned replies for an ask, in order.
var Drafts = []string{
	"Sounds good, see you then!",
	"Thanks! Let me check and get back to you.",
	"Got it 👍",
}

// Config tunes the agent. The zero value is usable.
type Config struct {
	// Delay before each callback event, so clients see the conversation unfold. Default 150 ms.
	Delay time.Duration
	// HTTP client for callbacks. Default agentproto.DefaultHTTPClient.
	HTTP *http.Client
	Log  *slog.Logger
	// Retries for a callback that fails with a network error or 5xx. Default 3.
	Retries int
}

// Agent is the concierge. Create it with New and serve Handler().
type Agent struct {
	cfg      Config
	log      *slog.Logger
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	sessions map[string]*session
}

type session struct {
	id      string
	mu      sync.Mutex
	cb      agentproto.CallbackClient
	decided map[string]bool
	jobs    chan []agentproto.AgentEvent
	done    chan struct{}
}

func New(cfg Config) *Agent {
	if cfg.Delay == 0 {
		cfg.Delay = 150 * time.Millisecond
	}
	if cfg.Delay < 0 {
		cfg.Delay = 0
	}
	if cfg.Retries == 0 {
		cfg.Retries = 3
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Agent{cfg: cfg, log: cfg.Log, ctx: ctx, cancel: cancel, sessions: make(map[string]*session)}
}

// Close stops all session workers. Pending callbacks are dropped.
func (a *Agent) Close() {
	a.cancel()
}

// Handler returns the HTTP routes of the agent, including GET /health.
func (a *Agent) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		agentproto.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /agentstudio/v0/info", a.handleInfo)
	mux.HandleFunc("POST /agentstudio/v0/sessions", a.handleCreateSession)
	mux.HandleFunc("DELETE /agentstudio/v0/sessions/{session_id}", a.handleDeleteSession)
	mux.HandleFunc("POST /agentstudio/v0/messages", a.handleMessage)
	mux.HandleFunc("POST /agentstudio/v0/approvals/{external_id}/decision", a.handleDecision)
	return mux
}

func (a *Agent) handleInfo(w http.ResponseWriter, r *http.Request) {
	agentproto.WriteJSON(w, http.StatusOK, agentproto.AgentInfo{
		Name:         Name,
		Description:  Description,
		Capabilities: []agentproto.Capability{agentproto.CapabilityChat, agentproto.CapabilityAsk, agentproto.CapabilityApprovals},
		Protocol:     agentproto.ProtocolVersion,
	})
}

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,100}$`)

func newSessionID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "ses_" + hex.EncodeToString(b)
}

func (a *Agent) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req agentproto.CreateSessionRequest
	if err := agentproto.ReadJSON(r, 64<<10, &req); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if _, err := agentproto.NormalizeBaseURL(req.CallbackURL); err != nil || req.CallbackToken == "" {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "callback_url and callback_token are required")
		return
	}
	// A bridge re-registering a session after a restart sends the old id; keep it
	// so the bridge's stored session id stays valid.
	id := req.SessionID
	if !sessionIDPattern.MatchString(id) {
		id = newSessionID()
	}
	a.mu.Lock()
	s, ok := a.sessions[id]
	if !ok {
		s = &session{
			id:      id,
			decided: make(map[string]bool),
			jobs:    make(chan []agentproto.AgentEvent, 64),
			done:    make(chan struct{}),
		}
		a.sessions[id] = s
		go a.worker(s)
	}
	a.mu.Unlock()
	s.mu.Lock()
	s.cb = agentproto.CallbackClient{URL: req.CallbackURL, Token: req.CallbackToken, HTTP: a.cfg.HTTP}
	s.mu.Unlock()
	a.log.Info("session registered", "session_id", id, "resumed", ok)
	agentproto.WriteJSON(w, http.StatusOK, agentproto.CreateSessionResponse{SessionID: id})
}

func (a *Agent) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session_id")
	a.mu.Lock()
	s, ok := a.sessions[id]
	delete(a.sessions, id)
	a.mu.Unlock()
	if !ok {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	close(s.done)
	a.log.Info("session deleted", "session_id", id)
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) getSession(id string) *session {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[id]
}

func (a *Agent) handleMessage(w http.ResponseWriter, r *http.Request) {
	var msg agentproto.InboundMessage
	if err := agentproto.ReadJSON(r, 1<<20, &msg); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if hdr := r.Header.Get(agentproto.HeaderSession); hdr != "" && hdr != msg.SessionID {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "session header and body disagree")
		return
	} else if err := msg.Validate(); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s := a.getSession(msg.SessionID)
	if s == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	a.log.Info("message received", "session_id", s.id, "message_id", msg.MessageID, "ask", msg.Ask != nil)
	if !a.enqueue(s, Respond(&msg)) {
		agentproto.WriteError(w, http.StatusServiceUnavailable, "busy", "session queue is full")
		return
	}
	agentproto.WriteJSON(w, http.StatusAccepted, map[string]any{})
}

func (a *Agent) handleDecision(w http.ResponseWriter, r *http.Request) {
	s := a.getSession(r.Header.Get(agentproto.HeaderSession))
	if s == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	externalID := r.PathValue("external_id")
	if !strings.HasPrefix(externalID, flightPrefix) {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown approval")
		return
	}
	var req agentproto.DecisionRequest
	if err := agentproto.ReadJSON(r, 64<<10, &req); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	reply := DecisionReply(req.Choice)
	if reply == "" {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "unknown choice")
		return
	}
	s.mu.Lock()
	already := s.decided[externalID]
	s.decided[externalID] = true
	s.mu.Unlock()
	a.log.Info("decision received", "session_id", s.id, "external_id", externalID, "choice", req.Choice, "duplicate", already)
	// Repeated deliveries of the same decision are acknowledged without a second reply.
	if !already && !a.enqueue(s, []agentproto.AgentEvent{agentproto.NewMessage(reply)}) {
		agentproto.WriteError(w, http.StatusServiceUnavailable, "busy", "session queue is full")
		return
	}
	agentproto.WriteJSON(w, http.StatusOK, map[string]any{})
}

func (a *Agent) enqueue(s *session, events []agentproto.AgentEvent) bool {
	select {
	case s.jobs <- events:
		return true
	default:
		return false
	}
}

// worker sends a session's events one at a time, in order, with a small delay before each.
func (a *Agent) worker(s *session) {
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-s.done:
			return
		case events := <-s.jobs:
			for _, evt := range events {
				select {
				case <-a.ctx.Done():
					return
				case <-s.done:
					return
				case <-time.After(a.cfg.Delay):
				}
				a.send(s, evt)
			}
		}
	}
}

func (a *Agent) send(s *session, evt agentproto.AgentEvent) {
	var err error
	for attempt := 1; attempt <= a.cfg.Retries; attempt++ {
		s.mu.Lock()
		cb := s.cb
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
		err = cb.Send(ctx, evt)
		cancel()
		if err == nil {
			return
		}
		var he *agentproto.HTTPError
		if errors.As(err, &he) && he.Status < 500 {
			break // the bridge rejected it; retrying won't help
		}
		select {
		case <-a.ctx.Done():
			return
		case <-s.done:
			return
		case <-time.After(time.Duration(attempt) * 300 * time.Millisecond):
		}
	}
	a.log.Warn("callback failed", "session_id", s.id, "event_type", evt.Type, "err", err)
}

// Respond returns the events the concierge sends for an inbound message, in order.
func Respond(msg *agentproto.InboundMessage) []agentproto.AgentEvent {
	switch {
	case msg.Ask != nil:
		return []agentproto.AgentEvent{agentproto.NewDrafts(msg.Ask.TaskID, DraftsFor(msg.Ask)...)}
	case strings.Contains(strings.ToLower(msg.Text), "flight"):
		return []agentproto.AgentEvent{
			agentproto.NewStatus(agentproto.StateWorking, FlightStatusText),
			agentproto.NewMessage(FlightFound),
			agentproto.NewApprovalRequest(agentproto.ApprovalRequestEvent{
				ExternalID: FlightExternalID(msg.MessageID),
				Title:      FlightTitle,
				Details: []agentproto.Detail{
					{Label: "Date", Value: "Friday"},
					{Label: "Route", Value: "Nonstop"},
					{Label: "Seat", Value: "14A, carry-on only"},
				},
				Choices: []agentproto.Choice{
					{Key: ChoiceBook, Label: "Book", Category: agentproto.CategoryApprove},
					{Key: ChoiceSkip, Label: "Don't book", Category: agentproto.CategoryDeny},
				},
				ExpiresInSeconds: FlightExpiry,
			}),
			agentproto.NewStatus(agentproto.StateIdle, ""),
		}
	default:
		return []agentproto.AgentEvent{agentproto.NewMessage("You said: " + msg.Text)}
	}
}

// FlightExternalID is "flight-" + the first 12 hex chars of sha256(message_id).
func FlightExternalID(messageID string) string {
	sum := sha256.Sum256([]byte(messageID))
	return flightPrefix + hex.EncodeToString(sum[:])[:12]
}

// DecisionReply returns the message for a decision choice, or "" for an unknown choice.
func DecisionReply(choice string) string {
	switch choice {
	case ChoiceBook:
		return BookedText
	case ChoiceSkip:
		return SkippedText
	}
	return ""
}

var personPattern = regexp.MustCompile(`^Person \d+$`)

// DraftsFor returns the canned drafts, prefixed with the other speaker's first
// name when the last context line is not the user's own.
func DraftsFor(ask *agentproto.Ask) []string {
	out := append([]string(nil), Drafts...)
	if len(ask.Lines) == 0 {
		return out
	}
	last := ask.Lines[len(ask.Lines)-1]
	if last.Own {
		return out
	}
	name := strings.TrimSpace(last.Speaker)
	if !personPattern.MatchString(name) { // "Person 2" has no first name
		name, _, _ = strings.Cut(name, " ")
	}
	if name == "" {
		return out
	}
	for i, d := range out {
		out[i] = name + ", " + lowerFirst(d)
	}
	return out
}

func lowerFirst(s string) string {
	r, size := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError {
		return s
	}
	return string(unicode.ToLower(r)) + s[size:]
}
