// Package acp adapts agents that speak ACP (the Agent Client Protocol:
// JSON-RPC 2.0 over stdio, newline-delimited) to the AgentStudio Agent Protocol.
//
// Each AgentStudio session runs its own agent process, started on the first
// message in a per-session working directory. Mapping:
//
//   - user messages and asks are session/prompt calls; the agent's
//     agent_message_chunk updates are collected into one chat message (or
//     parsed into drafts for an ask);
//   - tool calls update the agent's status text;
//   - session/request_permission becomes an approval card whose choices are the
//     agent's permission options (allow_* -> approve, reject_* -> deny); the
//     user's choice is the JSON-RPC response.
//
// Which commands may run is fixed by the server operator (Agents, from
// AGENTSTUDIO_ACP_AGENTS); users only pick one by id, never supply a command.
package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/agenthost"
	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// AgentSpec is one allowed ACP agent.
type AgentSpec struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Command     string            `json:"command"`
	Args        []string          `json:"args,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
}

// ParseAgents reads the AGENTSTUDIO_ACP_AGENTS JSON array.
func ParseAgents(raw string) ([]AgentSpec, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var specs []AgentSpec
	if err := json.Unmarshal([]byte(raw), &specs); err != nil {
		return nil, fmt.Errorf("AGENTSTUDIO_ACP_AGENTS: %w", err)
	}
	for _, s := range specs {
		if s.ID == "" || s.Command == "" {
			return nil, errors.New("AGENTSTUDIO_ACP_AGENTS: id and command are required")
		}
	}
	return specs, nil
}

type Backend struct {
	Agents  map[string]AgentSpec
	WorkDir string // per-session working directories are created under it
	Log     *slog.Logger
	// PermissionTimeout cancels a permission request nobody answered.
	PermissionTimeout time.Duration
}

func New(specs []AgentSpec, workDir string, log *slog.Logger) *Backend {
	m := map[string]AgentSpec{}
	for _, s := range specs {
		m[s.ID] = s
	}
	if log == nil {
		log = slog.Default()
	}
	return &Backend{Agents: m, WorkDir: workDir, Log: log, PermissionTimeout: 30 * time.Minute}
}

func (b *Backend) spec(r *http.Request) (AgentSpec, error) {
	s, ok := b.Agents[r.PathValue("agent")]
	if !ok {
		return AgentSpec{}, errors.New("unknown ACP agent")
	}
	return s, nil
}

func (b *Backend) Info(_ context.Context, r *http.Request) (agentproto.AgentInfo, error) {
	s, err := b.spec(r)
	if err != nil {
		return agentproto.AgentInfo{}, err
	}
	name := s.Name
	if name == "" {
		name = s.ID
	}
	return agentproto.AgentInfo{
		Name:        name,
		Description: s.Description,
		Capabilities: []agentproto.Capability{
			agentproto.CapabilityChat, agentproto.CapabilityAsk, agentproto.CapabilityApprovals,
		},
	}, nil
}

type state struct {
	spec AgentSpec

	mu    sync.Mutex
	proc  *process
	perms map[string]chan string // external id -> chosen option id
}

func (b *Backend) Open(r *http.Request, s *agenthost.Session) error {
	spec, err := b.spec(r)
	if err != nil {
		return err
	}
	if st, ok := s.State.(*state); ok && st.spec.ID == spec.ID {
		return nil
	}
	s.State = &state{spec: spec, perms: map[string]chan string{}}
	return nil
}

func (b *Backend) Close(s *agenthost.Session) {
	st, ok := s.State.(*state)
	if !ok {
		return
	}
	st.mu.Lock()
	p := st.proc
	st.proc = nil
	st.mu.Unlock()
	if p != nil {
		p.stop()
	}
}

func (b *Backend) Decision(_ context.Context, s *agenthost.Session, externalID, choice string) error {
	st := s.State.(*state)
	st.mu.Lock()
	ch, ok := st.perms[externalID]
	delete(st.perms, externalID)
	st.mu.Unlock()
	if !ok {
		return agenthost.ErrUnknownApproval
	}
	ch <- choice // buffered; the waiting handler answers the agent
	return nil
}

func (b *Backend) Message(ctx context.Context, s *agenthost.Session, msg *agentproto.InboundMessage) error {
	st := s.State.(*state)
	p, err := b.ensureProcess(s, st)
	if err != nil {
		return err
	}
	text := msg.Text
	if msg.Ask != nil {
		text = agenthost.AskPrompt(msg.Ask)
	}
	s.Emit(agentproto.NewStatus(agentproto.StateWorking, "Thinking"))
	defer s.Emit(agentproto.NewStatus(agentproto.StateIdle, ""))

	var out strings.Builder
	p.setUpdateHandler(func(u sessionUpdate) {
		switch u.SessionUpdate {
		case "agent_message_chunk":
			if u.Content != nil && u.Content.Type == "text" {
				out.WriteString(u.Content.Text)
			}
		case "tool_call":
			if u.Title != "" {
				s.Emit(agentproto.NewStatus(agentproto.StateWorking, truncate(u.Title, 80)))
			}
		}
	})
	p.setPermissionHandler(func(req permissionRequest) permissionOutcome {
		return b.askPermission(s, st, req)
	})
	var res struct {
		StopReason string `json:"stopReason"`
	}
	if err := p.call(ctx, "session/prompt", map[string]any{
		"sessionId": p.sessionID,
		"prompt":    []map[string]any{{"type": "text", "text": text}},
	}, &res); err != nil {
		return err
	}
	answer := strings.TrimSpace(out.String())
	if msg.Ask != nil {
		drafts := agenthost.ParseDrafts(answer)
		if len(drafts) == 0 {
			return errors.New("the agent didn't suggest a reply")
		}
		s.Emit(agentproto.NewDrafts(msg.Ask.TaskID, drafts...))
		return nil
	}
	if answer == "" {
		switch res.StopReason {
		case "refusal":
			answer = "The agent declined to do that."
		case "cancelled":
			answer = "Cancelled."
		case "max_tokens", "max_turn_requests":
			answer = "The agent stopped before finishing (" + res.StopReason + ")."
		default:
			return nil
		}
	}
	s.Emit(agentproto.NewMessage(truncate(answer, agentproto.MaxTextLength)))
	return nil
}

func (b *Backend) askPermission(s *agenthost.Session, st *state, req permissionRequest) permissionOutcome {
	externalID := fmt.Sprintf("acp-%s-%d", sanitize(req.ToolCall.ToolCallID), time.Now().UnixNano()%1e9)
	var choices []agentproto.Choice
	for _, o := range req.Options {
		cat := agentproto.CategoryApprove
		if strings.HasPrefix(o.Kind, "reject") {
			cat = agentproto.CategoryDeny
		}
		choices = append(choices, agentproto.Choice{Key: o.OptionID, Label: o.Name, Category: cat})
	}
	if len(choices) > agentproto.MaxChoices {
		choices = choices[:agentproto.MaxChoices]
	}
	title := req.ToolCall.Title
	if title == "" {
		title = "Allow the agent to continue?"
	}
	ch := make(chan string, 1)
	st.mu.Lock()
	st.perms[externalID] = ch
	st.mu.Unlock()
	evt := agentproto.NewApprovalRequest(agentproto.ApprovalRequestEvent{
		ExternalID:       externalID,
		Title:            truncate(title, 300),
		Details:          toolDetails(req.ToolCall),
		Choices:          choices,
		ExpiresInSeconds: int(b.PermissionTimeout.Seconds()),
	})
	if err := evt.Validate(); err != nil {
		// Not representable as a card (e.g. a single option): refuse safely.
		b.Log.Warn("can't show permission request", "err", err)
		return permissionOutcome{Outcome: "cancelled"}
	}
	s.Emit(evt)
	select {
	case choice := <-ch:
		return permissionOutcome{Outcome: "selected", OptionID: choice}
	case <-time.After(b.PermissionTimeout):
	case <-s.Context().Done():
	}
	st.mu.Lock()
	delete(st.perms, externalID)
	st.mu.Unlock()
	s.Emit(agentproto.NewApprovalCancel(externalID))
	return permissionOutcome{Outcome: "cancelled"}
}

func toolDetails(tc toolCall) []agentproto.Detail {
	var d []agentproto.Detail
	if tc.Kind != "" {
		d = append(d, agentproto.Detail{Label: "Action", Value: tc.Kind})
	}
	for _, l := range tc.Locations {
		if l.Path != "" && len(d) < 5 {
			d = append(d, agentproto.Detail{Label: "File", Value: l.Path})
		}
	}
	return d
}

func (b *Backend) ensureProcess(s *agenthost.Session, st *state) (*process, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.proc != nil && st.proc.alive() {
		return st.proc, nil
	}
	dir := filepath.Join(b.WorkDir, sanitize(s.ID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	p, err := startProcess(s.Context(), st.spec, dir, b.Log)
	if err != nil {
		return nil, fmt.Errorf("couldn't start the agent: %w", err)
	}
	st.proc = p
	return p, nil
}

// ---- JSON-RPC over stdio ----

type sessionUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	Content       *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content,omitempty"`
	Title string `json:"title,omitempty"`
}

type toolCall struct {
	ToolCallID string `json:"toolCallId"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	Locations  []struct {
		Path string `json:"path"`
	} `json:"locations"`
}

type permissionRequest struct {
	SessionID string   `json:"sessionId"`
	ToolCall  toolCall `json:"toolCall"`
	Options   []struct {
		OptionID string `json:"optionId"`
		Name     string `json:"name"`
		Kind     string `json:"kind"`
	} `json:"options"`
}

type permissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

type rpcMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type process struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	log       *slog.Logger
	sessionID string

	writeMu sync.Mutex
	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]chan rpcMessage
	onUpd   func(sessionUpdate)
	onPerm  func(permissionRequest) permissionOutcome
	exited  chan struct{}
}

func startProcess(ctx context.Context, spec AgentSpec, dir string, log *slog.Logger) (*process, error) {
	cmd := exec.CommandContext(ctx, spec.Command, spec.Args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	for k, v := range spec.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = &logWriter{log: log, agent: spec.ID}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &process{cmd: cmd, stdin: stdin, log: log, pending: map[int64]chan rpcMessage{}, exited: make(chan struct{})}
	go p.read(stdout)
	go func() {
		_ = cmd.Wait()
		close(p.exited)
		p.mu.Lock()
		for id, ch := range p.pending {
			ch <- rpcMessage{Error: &rpcError{Code: -32000, Message: "agent process exited"}}
			delete(p.pending, id)
		}
		p.mu.Unlock()
	}()
	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var initRes struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if err := p.call(initCtx, "initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs":       map[string]bool{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
	}, &initRes); err != nil {
		p.stop()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	var sess struct {
		SessionID string `json:"sessionId"`
	}
	if err := p.call(initCtx, "session/new", map[string]any{"cwd": dir, "mcpServers": []any{}}, &sess); err != nil {
		p.stop()
		return nil, fmt.Errorf("session/new: %w", err)
	}
	p.sessionID = sess.SessionID
	return p, nil
}

func (p *process) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

func (p *process) stop() {
	_ = p.stdin.Close()
	select {
	case <-p.exited:
	case <-time.After(2 * time.Second):
		_ = p.cmd.Process.Kill()
	}
}

func (p *process) setUpdateHandler(fn func(sessionUpdate)) {
	p.mu.Lock()
	p.onUpd = fn
	p.mu.Unlock()
}

func (p *process) setPermissionHandler(fn func(permissionRequest) permissionOutcome) {
	p.mu.Lock()
	p.onPerm = fn
	p.mu.Unlock()
}

func (p *process) write(m any) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(append(data, '\n'))
	return err
}

func (p *process) call(ctx context.Context, method string, params, out any) error {
	id := p.nextID.Add(1)
	ch := make(chan rpcMessage, 1)
	p.mu.Lock()
	p.pending[id] = ch
	p.mu.Unlock()
	if err := p.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		// Ask the agent to stop the turn; ignore the answer.
		if method == "session/prompt" {
			_ = p.write(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": p.sessionID}})
		}
		return ctx.Err()
	case m := <-ch:
		if m.Error != nil {
			return fmt.Errorf("%s (%d)", m.Error.Message, m.Error.Code)
		}
		if out != nil && len(m.Result) > 0 {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	}
}

func (p *process) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		var m rpcMessage
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			p.log.Debug("non-JSON line from ACP agent")
			continue
		}
		switch {
		case m.Method != "" && m.ID != nil:
			go p.handleRequest(m)
		case m.Method != "":
			p.handleNotification(m)
		case m.ID != nil:
			var id int64
			if json.Unmarshal(*m.ID, &id) == nil {
				p.mu.Lock()
				ch := p.pending[id]
				delete(p.pending, id)
				p.mu.Unlock()
				if ch != nil {
					ch <- m
				}
			}
		}
	}
}

func (p *process) handleNotification(m rpcMessage) {
	if m.Method != "session/update" {
		return
	}
	var n struct {
		Update sessionUpdate `json:"update"`
	}
	if json.Unmarshal(m.Params, &n) != nil {
		return
	}
	p.mu.Lock()
	fn := p.onUpd
	p.mu.Unlock()
	if fn != nil {
		fn(n.Update)
	}
}

func (p *process) handleRequest(m rpcMessage) {
	reply := func(result any, rerr *rpcError) {
		msg := map[string]any{"jsonrpc": "2.0", "id": m.ID}
		if rerr != nil {
			msg["error"] = rerr
		} else {
			msg["result"] = result
		}
		_ = p.write(msg)
	}
	switch m.Method {
	case "session/request_permission":
		var req permissionRequest
		if json.Unmarshal(m.Params, &req) != nil {
			reply(nil, &rpcError{Code: -32602, Message: "invalid params"})
			return
		}
		p.mu.Lock()
		fn := p.onPerm
		p.mu.Unlock()
		outcome := permissionOutcome{Outcome: "cancelled"}
		if fn != nil {
			outcome = fn(req)
		}
		reply(map[string]any{"outcome": outcome}, nil)
	default:
		// We advertise no fs or terminal capabilities.
		reply(nil, &rpcError{Code: -32601, Message: "method not supported by AgentStudio"})
	}
}

type logWriter struct {
	log   *slog.Logger
	agent string
}

func (w *logWriter) Write(b []byte) (int, error) {
	// Agent stderr can contain user content; keep it at debug level only.
	w.log.Debug("acp agent stderr", "agent", w.agent, "bytes", len(b))
	return len(b), nil
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == '_' || r == '.' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "x"
	}
	return b.String()
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
