// Package a2a adapts agents that speak A2A (the Agent2Agent protocol, JSON-RPC
// binding, v0.3) to the AgentStudio Agent Protocol, so they show up as AgentStudio
// contacts. Mapping:
//
//   - an AgentStudio session is one A2A context (contextId);
//   - user messages and asks are message/send calls; asks become a prompt
//     asking for numbered drafts (agenthost.AskPrompt);
//   - agent Messages, task status messages and text artifacts become chat messages;
//   - a task in state input-required whose status message carries a DataPart
//     {"agentstudio/approval": {...}} becomes an approval card; the decision is sent
//     back on that task as a DataPart {"agentstudio/decision": {"choice": ...}} plus
//     the choice label as text. Any other input-required just asks in chat, and
//     the user's next message continues that task.
//
// The upstream agent is named by the URL path: /a2a/{target}, where target is
// the base64url (no padding) of the agent's base URL. The user's agent token,
// if any, is forwarded as a bearer token.
package a2a

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/agenthost"
	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// Wire types (A2A v0.3, only the fields AgentStudio uses).

type Part struct {
	Kind string         `json:"kind"` // "text" | "data" | "file"
	Text string         `json:"text,omitempty"`
	Data map[string]any `json:"data,omitempty"`
}

type Message struct {
	Kind      string `json:"kind"` // "message"
	Role      string `json:"role"` // "user" | "agent"
	Parts     []Part `json:"parts"`
	MessageID string `json:"messageId"`
	ContextID string `json:"contextId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
}

type TaskStatus struct {
	State   string   `json:"state"`
	Message *Message `json:"message,omitempty"`
}

type Artifact struct {
	ArtifactID string `json:"artifactId"`
	Name       string `json:"name,omitempty"`
	Parts      []Part `json:"parts"`
}

type Task struct {
	Kind      string     `json:"kind"` // "task"
	ID        string     `json:"id"`
	ContextID string     `json:"contextId"`
	Status    TaskStatus `json:"status"`
	Artifacts []Artifact `json:"artifacts,omitempty"`
}

type AgentCard struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	IconURL     string `json:"iconUrl,omitempty"`
}

// Task states.
const (
	StateSubmitted     = "submitted"
	StateWorking       = "working"
	StateInputRequired = "input-required"
	StateAuthRequired  = "auth-required"
	StateCompleted     = "completed"
	StateCanceled      = "canceled"
	StateFailed        = "failed"
	StateRejected      = "rejected"
)

// AgentStudio extension keys in DataParts.
const (
	KeyApproval = "agentstudio/approval"
	KeyDecision = "agentstudio/decision"
)

func terminal(state string) bool {
	switch state {
	case StateCompleted, StateCanceled, StateFailed, StateRejected:
		return true
	}
	return false
}

// EncodeTarget is the {target} path segment for an agent base URL.
func EncodeTarget(baseURL string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strings.TrimRight(baseURL, "/")))
}

func decodeTarget(seg string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return "", errors.New("bad agent target")
	}
	return agentproto.NormalizeBaseURL(string(raw))
}

// Backend implements agenthost.Backend for A2A agents.
type Backend struct {
	HTTP *http.Client
	// PollInterval and PollTimeout bound how long a working task is followed.
	PollInterval time.Duration
	PollTimeout  time.Duration

	cardsMu sync.Mutex
	cards   map[string]cachedCard
}

type cachedCard struct {
	card    AgentCard
	fetched time.Time
}

func New() *Backend {
	return &Backend{
		HTTP:         &http.Client{Timeout: 60 * time.Second},
		PollInterval: time.Second,
		PollTimeout:  10 * time.Minute,
		cards:        map[string]cachedCard{},
	}
}

type state struct {
	mu        sync.Mutex
	base      string
	contextID string
	// openTask is a task waiting for the user (input-required without a card).
	openTask string
	// approvals maps AgentStudio external ids to the A2A task and choice labels.
	approvals map[string]pendingApproval
}

type pendingApproval struct {
	taskID string
	labels map[string]string
}

func (b *Backend) Open(r *http.Request, s *agenthost.Session) error {
	base, err := decodeTarget(r.PathValue("target"))
	if err != nil {
		return err
	}
	if st, ok := s.State.(*state); ok && st.base == base {
		return nil // re-registration: keep the conversation
	}
	s.State = &state{base: base, approvals: map[string]pendingApproval{}}
	return nil
}

func (b *Backend) Close(*agenthost.Session) {}

func (b *Backend) Info(ctx context.Context, r *http.Request) (agentproto.AgentInfo, error) {
	base, err := decodeTarget(r.PathValue("target"))
	if err != nil {
		return agentproto.AgentInfo{}, err
	}
	card, err := b.card(ctx, base, agentproto.BearerToken(r))
	if err != nil {
		return agentproto.AgentInfo{}, err
	}
	name := strings.TrimSpace(card.Name)
	if name == "" {
		name = "A2A agent"
	}
	return agentproto.AgentInfo{
		Name:        truncate(name, 100),
		Description: truncate(card.Description, 500),
		AvatarURL:   card.IconURL,
		Capabilities: []agentproto.Capability{
			agentproto.CapabilityChat, agentproto.CapabilityAsk, agentproto.CapabilityApprovals,
		},
	}, nil
}

// card fetches the agent card, trying the v0.3 path then the older one.
func (b *Backend) card(ctx context.Context, base, token string) (AgentCard, error) {
	b.cardsMu.Lock()
	c, ok := b.cards[base]
	b.cardsMu.Unlock()
	if ok && time.Since(c.fetched) < 5*time.Minute {
		return c.card, nil
	}
	var lastErr error
	for _, p := range []string{"/.well-known/agent-card.json", "/.well-known/agent.json"} {
		var card AgentCard
		if err := b.getJSON(ctx, base+p, token, &card); err != nil {
			lastErr = err
			continue
		}
		if card.URL == "" {
			card.URL = base
		}
		if _, err := agentproto.NormalizeBaseURL(card.URL); err != nil {
			lastErr = fmt.Errorf("agent card has an invalid url: %w", err)
			continue
		}
		b.cardsMu.Lock()
		b.cards[base] = cachedCard{card: card, fetched: time.Now()}
		b.cardsMu.Unlock()
		return card, nil
	}
	return AgentCard{}, fmt.Errorf("couldn't read the A2A agent card: %w", lastErr)
}

func (b *Backend) Message(ctx context.Context, s *agenthost.Session, msg *agentproto.InboundMessage) error {
	st := s.State.(*state)
	text := msg.Text
	if msg.Ask != nil {
		text = agenthost.AskPrompt(msg.Ask)
	}
	st.mu.Lock()
	taskID := st.openTask
	st.openTask = ""
	st.mu.Unlock()
	if msg.Ask != nil {
		taskID = "" // an ask is its own request, not an answer to an open question
	}
	reply, err := b.send(ctx, s, Message{Kind: "message", Role: "user", Parts: []Part{{Kind: "text", Text: text}}, TaskID: taskID})
	if err != nil {
		return err
	}
	return b.deliver(ctx, s, reply, msg.Ask)
}

func (b *Backend) Decision(ctx context.Context, s *agenthost.Session, externalID, choice string) error {
	st := s.State.(*state)
	st.mu.Lock()
	p, ok := st.approvals[externalID]
	if ok {
		delete(st.approvals, externalID)
	}
	st.mu.Unlock()
	if !ok {
		return agenthost.ErrUnknownApproval
	}
	label := p.labels[choice]
	if label == "" {
		label = choice
	}
	m := Message{Kind: "message", Role: "user", TaskID: p.taskID, Parts: []Part{
		{Kind: "data", Data: map[string]any{KeyDecision: map[string]any{"choice": choice}}},
		{Kind: "text", Text: label},
	}}
	// Send the decision now (so the bridge learns it arrived), follow the
	// task's progress in the background.
	reply, err := b.send(ctx, s, m)
	if err != nil {
		return err
	}
	go func() {
		bg, cancel := context.WithTimeout(s.Context(), b.PollTimeout)
		defer cancel()
		_ = b.deliver(bg, s, reply, nil)
	}()
	return nil
}

// reply is either a Message or a Task from message/send.
type reply struct {
	message *Message
	task    *Task
}

func (b *Backend) send(ctx context.Context, s *agenthost.Session, m Message) (reply, error) {
	st := s.State.(*state)
	card, err := b.card(ctx, st.base, s.BearerToken())
	if err != nil {
		return reply{}, err
	}
	st.mu.Lock()
	m.ContextID = st.contextID
	st.mu.Unlock()
	m.MessageID = newID()
	var raw json.RawMessage
	if err := b.rpc(ctx, card.URL, s.BearerToken(), "message/send", map[string]any{
		"message":       m,
		"configuration": map[string]any{"blocking": true, "acceptedOutputModes": []string{"text/plain", "text", "application/json"}},
	}, &raw); err != nil {
		return reply{}, err
	}
	var kind struct {
		Kind      string `json:"kind"`
		ContextID string `json:"contextId"`
	}
	_ = json.Unmarshal(raw, &kind)
	if kind.ContextID != "" {
		st.mu.Lock()
		st.contextID = kind.ContextID
		st.mu.Unlock()
	}
	if kind.Kind == "task" {
		var t Task
		if err := json.Unmarshal(raw, &t); err != nil {
			return reply{}, fmt.Errorf("bad task from agent: %w", err)
		}
		return reply{task: &t}, nil
	}
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return reply{}, fmt.Errorf("bad message from agent: %w", err)
	}
	return reply{message: &msg}, nil
}

// deliver turns a reply into AgentStudio events, following a working task until it
// finishes or needs the user.
func (b *Backend) deliver(ctx context.Context, s *agenthost.Session, r reply, ask *agentproto.Ask) error {
	if r.message != nil {
		return b.emitText(s, partsText(r.message.Parts), ask)
	}
	t := r.task
	seenArtifacts := map[string]bool{}
	deadline := time.Now().Add(b.PollTimeout)
	working := false
	for {
		if !terminal(t.Status.State) && t.Status.State != StateInputRequired && t.Status.State != StateAuthRequired {
			if !working {
				s.Emit(agentproto.NewStatus(agentproto.StateWorking, statusText(t)))
				working = true
			}
			if time.Now().After(deadline) {
				s.Emit(agentproto.NewStatus(agentproto.StateIdle, ""))
				return errors.New("the agent is still working; its answer will not be shown here")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(b.PollInterval):
			}
			next, err := b.getTask(ctx, s, t.ID)
			if err != nil {
				s.Emit(agentproto.NewStatus(agentproto.StateIdle, ""))
				return err
			}
			t = next
			continue
		}
		if working {
			s.Emit(agentproto.NewStatus(agentproto.StateIdle, ""))
		}
		break
	}
	var texts []string
	for _, a := range t.Artifacts {
		if seenArtifacts[a.ArtifactID] {
			continue
		}
		seenArtifacts[a.ArtifactID] = true
		if txt := partsText(a.Parts); txt != "" {
			texts = append(texts, txt)
		}
	}
	statusMsg := ""
	if t.Status.Message != nil {
		statusMsg = partsText(t.Status.Message.Parts)
	}
	switch t.Status.State {
	case StateInputRequired, StateAuthRequired:
		if card := approvalPart(t.Status.Message); card != nil {
			if txt := strings.Join(texts, "\n\n"); txt != "" {
				s.Emit(agentproto.NewMessage(txt))
			}
			return b.emitApproval(s, t, card, statusMsg)
		}
		st := s.State.(*state)
		st.mu.Lock()
		st.openTask = t.ID
		st.mu.Unlock()
		texts = append(texts, statusMsg)
	case StateFailed, StateRejected:
		if statusMsg == "" {
			statusMsg = "The agent couldn't complete this."
		}
		texts = append(texts, "⚠️ "+statusMsg)
	default:
		if statusMsg != "" && len(texts) == 0 {
			texts = append(texts, statusMsg)
		}
	}
	return b.emitText(s, strings.TrimSpace(strings.Join(nonEmpty(texts), "\n\n")), ask)
}

func (b *Backend) emitText(s *agenthost.Session, text string, ask *agentproto.Ask) error {
	if ask != nil {
		drafts := agenthost.ParseDrafts(text)
		if len(drafts) == 0 {
			return errors.New("the agent didn't suggest a reply")
		}
		s.Emit(agentproto.NewDrafts(ask.TaskID, drafts...))
		return nil
	}
	if text == "" {
		return nil
	}
	s.Emit(agentproto.NewMessage(truncate(text, agentproto.MaxTextLength)))
	return nil
}

type approvalCard struct {
	Title   string              `json:"title"`
	Summary string              `json:"summary"`
	Details []agentproto.Detail `json:"details"`
	Choices []agentproto.Choice `json:"choices"`
	Expires int                 `json:"expires_in_seconds"`
}

func approvalPart(m *Message) *approvalCard {
	if m == nil {
		return nil
	}
	for _, p := range m.Parts {
		if p.Kind != "data" || p.Data == nil {
			continue
		}
		raw, ok := p.Data[KeyApproval]
		if !ok {
			continue
		}
		data, _ := json.Marshal(raw)
		var c approvalCard
		if json.Unmarshal(data, &c) == nil {
			return &c
		}
	}
	return nil
}

func (b *Backend) emitApproval(s *agenthost.Session, t *Task, c *approvalCard, fallbackTitle string) error {
	if c.Title == "" {
		c.Title = fallbackTitle
	}
	if len(c.Choices) < agentproto.MinChoices {
		c.Choices = []agentproto.Choice{
			{Key: "approve", Label: "Approve", Category: agentproto.CategoryApprove},
			{Key: "deny", Label: "Deny", Category: agentproto.CategoryDeny},
		}
	}
	externalID := "a2a-" + shortHash(t.ID+"\x00"+fmt.Sprint(time.Now().UnixNano()))
	labels := map[string]string{}
	for _, ch := range c.Choices {
		labels[ch.Key] = ch.Label
	}
	st := s.State.(*state)
	st.mu.Lock()
	st.approvals[externalID] = pendingApproval{taskID: t.ID, labels: labels}
	st.mu.Unlock()
	s.Emit(agentproto.NewApprovalRequest(agentproto.ApprovalRequestEvent{
		ExternalID:       externalID,
		Title:            truncate(c.Title, 300),
		Summary:          c.Summary,
		Details:          c.Details,
		Choices:          c.Choices,
		ExpiresInSeconds: c.Expires,
	}))
	return nil
}

func (b *Backend) getTask(ctx context.Context, s *agenthost.Session, id string) (*Task, error) {
	st := s.State.(*state)
	card, err := b.card(ctx, st.base, s.BearerToken())
	if err != nil {
		return nil, err
	}
	var t Task
	if err := b.rpc(ctx, card.URL, s.BearerToken(), "tasks/get", map[string]any{"id": id}, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (b *Backend) rpc(ctx context.Context, endpoint, token, method string, params, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": newID(), "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach the agent: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("agent returned HTTP %d", resp.StatusCode)
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("agent returned invalid JSON-RPC: %w", err)
	}
	if env.Error != nil {
		return fmt.Errorf("agent error %d: %s", env.Error.Code, env.Error.Message)
	}
	return json.Unmarshal(env.Result, out)
}

func (b *Backend) getJSON(ctx context.Context, u, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", (&url.URL{Path: req.URL.Path}).String(), resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

func partsText(parts []Part) string {
	var out []string
	for _, p := range parts {
		if p.Kind == "text" && strings.TrimSpace(p.Text) != "" {
			out = append(out, p.Text)
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func statusText(t *Task) string {
	if t.Status.Message != nil {
		if txt := partsText(t.Status.Message.Parts); txt != "" {
			return truncate(txt, 80)
		}
	}
	return "Working"
}

func nonEmpty(in []string) []string {
	out := in[:0]
	for _, s := range in {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func shortHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}

func newID() string {
	b := make([]byte, 16)
	_, _ = randRead(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
