// Command agentstudio-dev-a2a-echo is a tiny deterministic A2A agent for
// development and e2e tests (docs/agent-protocol.md, "A2A"). It listens on
// A2A_ECHO_ADDR (default 127.0.0.1:18203).
//
//   - "book ..." -> a task in input-required with a agentstudio/approval card
//     ("Book the table at Nopa for 7:30?", choices book / skip); the decision
//     completes the task with "Table booked." or "Okay, not booking.";
//   - "slow ..." -> a task that is working for ~1 s, then completes with "Done: <text>";
//   - a request for reply options -> three numbered drafts;
//   - anything else -> a Message "A2A echo: <text>".
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type part struct {
	Kind string         `json:"kind"`
	Text string         `json:"text,omitempty"`
	Data map[string]any `json:"data,omitempty"`
}

type message struct {
	Kind      string `json:"kind"`
	Role      string `json:"role"`
	Parts     []part `json:"parts"`
	MessageID string `json:"messageId"`
	ContextID string `json:"contextId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
}

type task struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	ContextID string `json:"contextId"`
	Status    struct {
		State   string   `json:"state"`
		Message *message `json:"message,omitempty"`
	} `json:"status"`
	Artifacts []map[string]any `json:"artifacts,omitempty"`
	doneAt    time.Time
	doneText  string
}

var (
	mu    sync.Mutex
	tasks = map[string]*task{}
	seq   int
)

func nextID(prefix string) string {
	seq++
	return fmt.Sprintf("%s-%d", prefix, seq)
}

func text(parts []part) string {
	var out []string
	for _, p := range parts {
		if p.Kind == "text" {
			out = append(out, p.Text)
		}
	}
	return strings.Join(out, "\n")
}

func agentMsg(ctx, t string) *message {
	return &message{Kind: "message", Role: "agent", Parts: []part{{Kind: "text", Text: t}}, MessageID: nextID("m"), ContextID: ctx}
}

func main() {
	addr := os.Getenv("A2A_ECHO_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18203"
	}
	base := "http://" + addr
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"ok":true}`)) })
	mux.HandleFunc("GET /.well-known/agent-card.json", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"name": "A2A Echo", "description": "A tiny A2A test agent.", "url": base + "/rpc",
			"version": "1.0.0", "protocolVersion": "0.3.0", "capabilities": map[string]any{"streaming": false},
			"defaultInputModes": []string{"text/plain"}, "defaultOutputModes": []string{"text/plain"}, "skills": []any{},
		})
	})
	mux.HandleFunc("POST /rpc", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad json", 400)
			return
		}
		result, rerr := handle(req.Method, req.Params)
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if rerr != "" {
			resp["error"] = map[string]any{"code": -32600, "message": rerr}
		} else {
			resp["result"] = result
		}
		json.NewEncoder(w).Encode(resp)
	})
	slog.Info("agentstudio-dev-a2a-echo listening", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func handle(method string, raw json.RawMessage) (any, string) {
	mu.Lock()
	defer mu.Unlock()
	switch method {
	case "message/send":
		var p struct {
			Message message `json:"message"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return nil, "invalid params"
		}
		m := p.Message
		ctx := m.ContextID
		if ctx == "" {
			ctx = nextID("ctx")
		}
		in := strings.TrimSpace(text(m.Parts))
		if m.TaskID != "" {
			t := tasks[m.TaskID]
			if t == nil {
				return nil, "unknown task"
			}
			choice := ""
			for _, pt := range m.Parts {
				if d, ok := pt.Data["agentstudio/decision"].(map[string]any); ok {
					choice, _ = d["choice"].(string)
				}
			}
			t.Status.State = "completed"
			if choice == "book" {
				t.Status.Message = agentMsg(ctx, "Table booked.")
			} else {
				t.Status.Message = agentMsg(ctx, "Okay, not booking.")
			}
			return t, ""
		}
		lower := strings.ToLower(in)
		switch {
		case strings.HasPrefix(lower, "book"):
			t := &task{Kind: "task", ID: nextID("task"), ContextID: ctx}
			t.Status.State = "input-required"
			t.Status.Message = &message{Kind: "message", Role: "agent", MessageID: nextID("m"), ContextID: ctx, Parts: []part{
				{Kind: "text", Text: "Book the table at Nopa for 7:30?"},
				{Kind: "data", Data: map[string]any{"agentstudio/approval": map[string]any{
					"title":   "Book the table at Nopa for 7:30?",
					"details": []map[string]string{{"label": "Party", "value": "2 people"}},
					"choices": []map[string]string{{"key": "book", "label": "Book", "category": "approve"}, {"key": "skip", "label": "Not now", "category": "deny"}},
				}}},
			}}
			tasks[t.ID] = t
			return t, ""
		case strings.HasPrefix(lower, "slow"):
			t := &task{Kind: "task", ID: nextID("task"), ContextID: ctx, doneAt: time.Now().Add(time.Second), doneText: "Done: " + in}
			t.Status.State = "working"
			tasks[t.ID] = t
			return t, ""
		case strings.Contains(lower, "numbered list"):
			return agentMsg(ctx, "1. Sounds great!\n2. Let me check and get back to you.\n3. Can we do 8 instead?"), ""
		default:
			return agentMsg(ctx, "A2A echo: "+in), ""
		}
	case "tasks/get":
		var p struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &p)
		t := tasks[p.ID]
		if t == nil {
			return nil, "unknown task"
		}
		if t.Status.State == "working" && time.Now().After(t.doneAt) {
			t.Status.State = "completed"
			t.Artifacts = []map[string]any{{"artifactId": "a1", "parts": []part{{Kind: "text", Text: t.doneText}}}}
		}
		return t, ""
	}
	return nil, "method not found"
}
