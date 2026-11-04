// Package agenthost serves the agent side of the AgentStudio Agent Protocol
// (docs/agent-protocol.md) for a pluggable Backend. It owns the protocol
// plumbing that every agent needs: sessions, the ordered callback queue with
// retries, and request validation. Protocol adapters (A2A, ACP) are Backends.
//
// Sessions live in memory. The agents bridge re-registers its sessions on
// startup and whenever a call returns 404, so losing them on restart is fine.
package agenthost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// Backend is one agent behind the host. Methods may block; Message and
// Decision run on the session's own goroutine, one at a time, in arrival order.
type Backend interface {
	// Info describes the agent. Called for GET /info and before each session.
	Info(ctx context.Context, r *http.Request) (agentproto.AgentInfo, error)
	// Message handles one inbound message. Results go out through s.Emit.
	Message(ctx context.Context, s *Session, msg *agentproto.InboundMessage) error
	// Decision handles the user's answer to an approval this backend requested.
	Decision(ctx context.Context, s *Session, externalID, choice string) error
	// Close releases what the backend holds for the session (processes, contexts).
	Close(s *Session)
}

// Opener is an optional Backend hook, called when a session is created or
// re-registered, with the request that created it (for path values).
type Opener interface {
	Open(r *http.Request, s *Session) error
}

// Session is one bridge session. Backends keep their per-session state in State.
type Session struct {
	ID string
	// Token is the bearer token the bridge sent when creating the session (the
	// user's agent token), for backends that forward it upstream.
	Token string

	mu     sync.Mutex // guards cb and Token
	sendMu sync.Mutex // serialises callbacks, keeping them in order
	cb     agentproto.CallbackClient
	State  any

	host *Host
	jobs chan func(ctx context.Context)
	done chan struct{}
}

// BearerToken is the user's agent token for this session, if any.
func (s *Session) BearerToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Token
}

// Emit queues an event for the bridge. Events are delivered in order.
func (s *Session) Emit(evt agentproto.AgentEvent) {
	if err := evt.Validate(); err != nil {
		s.host.log.Warn("dropping invalid event", "session_id", s.ID, "event_type", evt.Type, "err", err)
		return
	}
	s.host.send(s, evt)
}

// Context is cancelled when the session is deleted or the host closes.
func (s *Session) Context() context.Context {
	ctx, cancel := context.WithCancel(s.host.ctx)
	go func() {
		select {
		case <-s.done:
		case <-ctx.Done():
		}
		cancel()
	}()
	return ctx
}

// Host serves the protocol for one Backend.
type Host struct {
	backend Backend
	log     *slog.Logger
	http    *http.Client
	retries int

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	sessions map[string]*Session
}

type Options struct {
	Log     *slog.Logger
	HTTP    *http.Client // callbacks; default agentproto.DefaultHTTPClient
	Retries int          // per callback; default 3
}

func New(b Backend, opts Options) *Host {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Retries == 0 {
		opts.Retries = 3
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Host{backend: b, log: opts.Log, http: opts.HTTP, retries: opts.Retries, ctx: ctx, cancel: cancel, sessions: map[string]*Session{}}
}

// Close ends every session.
func (h *Host) Close() {
	h.mu.Lock()
	sessions := h.sessions
	h.sessions = map[string]*Session{}
	h.mu.Unlock()
	for _, s := range sessions {
		h.end(s)
	}
	h.cancel()
}

// Register adds the protocol routes under prefix (e.g. "" or "/a2a/{target}").
func (h *Host) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/agentstudio/v0/info", h.handleInfo)
	mux.HandleFunc("POST "+prefix+"/agentstudio/v0/sessions", h.handleCreateSession)
	mux.HandleFunc("DELETE "+prefix+"/agentstudio/v0/sessions/{session_id}", h.handleDeleteSession)
	mux.HandleFunc("POST "+prefix+"/agentstudio/v0/messages", h.handleMessage)
	mux.HandleFunc("POST "+prefix+"/agentstudio/v0/approvals/{external_id}/decision", h.handleDecision)
}

func (h *Host) handleInfo(w http.ResponseWriter, r *http.Request) {
	info, err := h.backend.Info(r.Context(), r)
	if err != nil {
		h.log.Warn("info failed", "err", err)
		agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	info.Protocol = agentproto.ProtocolVersion
	agentproto.WriteJSON(w, http.StatusOK, info)
}

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,100}$`)

func newSessionID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "ses_" + hex.EncodeToString(b)
}

func (h *Host) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req agentproto.CreateSessionRequest
	if err := agentproto.ReadJSON(r, 64<<10, &req); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if _, err := agentproto.NormalizeBaseURL(req.CallbackURL); err != nil || req.CallbackToken == "" {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "callback_url and callback_token are required")
		return
	}
	// Fail the handshake early when the upstream agent is unreachable.
	if _, err := h.backend.Info(r.Context(), r); err != nil {
		agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	id := req.SessionID
	if !sessionIDPattern.MatchString(id) {
		id = newSessionID()
	}
	h.mu.Lock()
	s, ok := h.sessions[id]
	if !ok {
		s = &Session{ID: id, host: h, jobs: make(chan func(context.Context), 64), done: make(chan struct{})}
		h.sessions[id] = s
		go h.worker(s)
	}
	h.mu.Unlock()
	s.mu.Lock()
	s.cb = agentproto.CallbackClient{URL: req.CallbackURL, Token: req.CallbackToken, HTTP: h.http}
	s.Token = agentproto.BearerToken(r)
	s.mu.Unlock()
	if o, isOpener := h.backend.(Opener); isOpener {
		if err := o.Open(r, s); err != nil {
			if !ok { // don't keep a half-created session around
				h.mu.Lock()
				delete(h.sessions, id)
				h.mu.Unlock()
				h.end(s)
			}
			agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", err.Error())
			return
		}
	}
	h.log.Info("session registered", "session_id", id, "resumed", ok)
	agentproto.WriteJSON(w, http.StatusOK, agentproto.CreateSessionResponse{SessionID: id})
}

func (h *Host) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session_id")
	h.mu.Lock()
	s, ok := h.sessions[id]
	delete(h.sessions, id)
	h.mu.Unlock()
	if !ok {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	h.end(s)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Host) end(s *Session) {
	select {
	case <-s.done:
	default:
		close(s.done)
		h.backend.Close(s)
	}
}

func (h *Host) session(r *http.Request, id string) *Session {
	if id == "" {
		id = r.Header.Get(agentproto.HeaderSession)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[id]
	if s != nil {
		// Keep the latest token: users can reconnect with a new one.
		if tok := agentproto.BearerToken(r); tok != "" {
			s.mu.Lock()
			s.Token = tok
			s.mu.Unlock()
		}
	}
	return s
}

func (h *Host) handleMessage(w http.ResponseWriter, r *http.Request) {
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
	s := h.session(r, msg.SessionID)
	if s == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	if !h.enqueue(s, func(ctx context.Context) {
		if err := h.backend.Message(ctx, s, &msg); err != nil {
			h.log.Warn("message failed", "session_id", s.ID, "err", err)
			if msg.Ask != nil {
				// Tell the user instead of leaving the task pending forever.
				s.Emit(agentproto.NewMessage("Sorry, I couldn't answer that: " + err.Error()))
			} else {
				s.Emit(agentproto.NewMessage("⚠️ " + err.Error()))
			}
		}
	}) {
		agentproto.WriteError(w, http.StatusServiceUnavailable, "busy", "session queue is full")
		return
	}
	agentproto.WriteJSON(w, http.StatusAccepted, map[string]any{})
}

func (h *Host) handleDecision(w http.ResponseWriter, r *http.Request) {
	s := h.session(r, "")
	if s == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	var req agentproto.DecisionRequest
	if err := agentproto.ReadJSON(r, 64<<10, &req); err != nil || req.Choice == "" {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	externalID := r.PathValue("external_id")
	// Decisions are delivered synchronously so the bridge (and the user) learn
	// whether the agent got it. They bypass the message queue: an ACP agent
	// waiting for permission is blocking that very queue.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := h.backend.Decision(ctx, s, externalID, req.Choice); err != nil {
		if errors.Is(err, ErrUnknownApproval) {
			agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown approval")
			return
		}
		agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", err.Error())
		return
	}
	agentproto.WriteJSON(w, http.StatusOK, map[string]any{})
}

// ErrUnknownApproval is returned by backends for decisions they didn't ask for.
var ErrUnknownApproval = errors.New("unknown approval")

func (h *Host) enqueue(s *Session, job func(context.Context)) bool {
	select {
	case s.jobs <- job:
		return true
	default:
		return false
	}
}

func (h *Host) worker(s *Session) {
	ctx := s.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-s.jobs:
			job(ctx)
		}
	}
}

// send delivers one event with retries. Sends for a session are serialised by
// sendMu, which keeps them in order across goroutines.
func (h *Host) send(s *Session, evt agentproto.AgentEvent) {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	var err error
	for attempt := 1; attempt <= h.retries; attempt++ {
		s.mu.Lock()
		cb := s.cb
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
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
		case <-h.ctx.Done():
			return
		case <-s.done:
			return
		case <-time.After(time.Duration(attempt) * 300 * time.Millisecond):
		}
	}
	h.log.Warn("callback failed", "session_id", s.ID, "event_type", evt.Type, "err", err)
}
