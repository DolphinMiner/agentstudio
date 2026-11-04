// Command agentstudio-dev-acp-echo is a tiny deterministic ACP agent (JSON-RPC over
// stdio) for development and e2e tests (docs/agent-protocol.md, "ACP").
//
//   - a prompt containing "delete" asks for permission (allow once / reject)
//     before "Deleted notes.txt." or "Okay, I left it alone.";
//   - a request for reply options -> three numbered drafts;
//   - anything else -> "ACP echo: <text>", streamed in two chunks.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"sync"
)

var (
	out   = json.NewEncoder(os.Stdout)
	outMu sync.Mutex
	next  = 1000
	wait  = map[int]chan json.RawMessage{}
	mu    sync.Mutex
)

func send(m map[string]any) {
	m["jsonrpc"] = "2.0"
	outMu.Lock()
	defer outMu.Unlock()
	_ = out.Encode(m)
}

func chunk(session, text string) {
	send(map[string]any{"method": "session/update", "params": map[string]any{
		"sessionId": session,
		"update":    map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}},
	}})
}

func request(method string, params any) json.RawMessage {
	mu.Lock()
	next++
	id := next
	ch := make(chan json.RawMessage, 1)
	wait[id] = ch
	mu.Unlock()
	send(map[string]any{"id": id, "method": method, "params": params})
	return <-ch
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		var m struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		if m.Method == "" && m.ID != nil { // response to our request
			mu.Lock()
			ch := wait[*m.ID]
			delete(wait, *m.ID)
			mu.Unlock()
			if ch != nil {
				ch <- m.Result
			}
			continue
		}
		switch m.Method {
		case "initialize":
			send(map[string]any{"id": *m.ID, "result": map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{}, "authMethods": []any{}}})
		case "session/new":
			send(map[string]any{"id": *m.ID, "result": map[string]any{"sessionId": "acp-echo-session"}})
		case "session/prompt":
			id := *m.ID
			var p struct {
				SessionID string `json:"sessionId"`
				Prompt    []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			}
			_ = json.Unmarshal(m.Params, &p)
			var b strings.Builder
			for _, c := range p.Prompt {
				b.WriteString(c.Text)
			}
			go prompt(id, p.SessionID, strings.TrimSpace(b.String()))
		case "session/cancel":
		default:
			if m.ID != nil {
				send(map[string]any{"id": *m.ID, "error": map[string]any{"code": -32601, "message": "not found"}})
			}
		}
	}
}

func prompt(id int, session, text string) {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "numbered list"):
		chunk(session, "1. Sounds good!\n2. I'll get back to you soon.\n")
		chunk(session, "3. Let's talk tomorrow.")
	case strings.Contains(lower, "delete"):
		send(map[string]any{"method": "session/update", "params": map[string]any{"sessionId": session,
			"update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "Delete notes.txt", "kind": "delete", "status": "pending"}}})
		res := request("session/request_permission", map[string]any{
			"sessionId": session,
			"toolCall":  map[string]any{"toolCallId": "call-1", "title": "Delete notes.txt", "kind": "delete", "locations": []map[string]string{{"path": "notes.txt"}}},
			"options": []map[string]string{
				{"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
				{"optionId": "reject", "name": "Reject", "kind": "reject_once"},
			},
		})
		var r struct {
			Outcome struct {
				Outcome  string `json:"outcome"`
				OptionID string `json:"optionId"`
			} `json:"outcome"`
		}
		_ = json.Unmarshal(res, &r)
		if r.Outcome.Outcome == "selected" && r.Outcome.OptionID == "allow" {
			chunk(session, "Deleted notes.txt.")
		} else {
			chunk(session, "Okay, I left it alone.")
		}
	default:
		r := []rune(text) // split on a rune boundary to exercise chunk joining
		half := len(r) / 2
		chunk(session, "ACP echo: "+string(r[:half]))
		chunk(session, string(r[half:]))
	}
	send(map[string]any{"id": id, "result": map[string]any{"stopReason": "end_turn"}})
}
