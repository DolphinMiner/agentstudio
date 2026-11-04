package agents

// Integration test against the running local stack (pnpm dev:up). Run with:
//
//	AGENTSTUDIO_IT=1 go test -tags nocrypto -run TestIntegration -v ./internal/bridges/agents/
//
// It creates a fresh Matrix user via Synapse JWT login, connects the concierge
// through the bridge's provisioning API, and walks through chat, approval,
// decision delivery and ask/drafts in the agent DM.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/DolphinMiner/agentstudio/server/internal/concierge"
)

func loadLocalEnv(t *testing.T) map[string]string {
	t.Helper()
	path := os.Getenv("AGENTSTUDIO_ENV_FILE")
	if path == "" {
		wd, _ := os.Getwd()
		path = filepath.Join(wd, "../../../../.local/env")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s (is the stack up?): %v", path, err)
	}
	defer f.Close()
	env := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if ok {
			env[k] = strings.Trim(v, `"'`)
		}
	}
	return env
}

type mx struct {
	t     *testing.T
	base  string
	token string
	since string
}

func (m *mx) call(method, path string, body any, out any) int {
	m.t.Helper()
	var r io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		r = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, m.base+path, r)
	if m.token != "" {
		req.Header.Set("Authorization", "Bearer "+m.token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		m.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if out != nil {
		_ = json.Unmarshal(data, out)
	}
	if resp.StatusCode >= 300 {
		m.t.Logf("%s %s -> %d %s", method, path, resp.StatusCode, data)
	}
	return resp.StatusCode
}

type syncEvent struct {
	Type     string         `json:"type"`
	Sender   string         `json:"sender"`
	EventID  string         `json:"event_id"`
	StateKey *string        `json:"state_key"`
	Content  map[string]any `json:"content"`
}

type syncResp struct {
	NextBatch string `json:"next_batch"`
	Rooms     struct {
		Join map[string]struct {
			Timeline struct {
				Events []syncEvent `json:"events"`
			} `json:"timeline"`
		} `json:"join"`
		Invite map[string]struct {
			InviteState struct {
				Events []syncEvent `json:"events"`
			} `json:"invite_state"`
		} `json:"invite"`
	} `json:"rooms"`
}

func (m *mx) sync() syncResp {
	var s syncResp
	q := url.Values{"timeout": {"2000"}}
	if m.since != "" {
		q.Set("since", m.since)
	}
	if code := m.call("GET", "/_matrix/client/v3/sync?"+q.Encode(), nil, &s); code != 200 {
		m.t.Fatalf("sync: %d", code)
	}
	m.since = s.NextBatch
	return s
}

// waitTimeline syncs until match returns true for an event in roomID.
func (m *mx) waitTimeline(roomID string, what string, match func(syncEvent) bool) syncEvent {
	m.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		s := m.sync()
		for _, e := range s.Rooms.Join[roomID].Timeline.Events {
			if match(e) {
				return e
			}
		}
	}
	m.t.Fatalf("timed out waiting for %s", what)
	return syncEvent{}
}

func TestIntegration(t *testing.T) {
	if os.Getenv("AGENTSTUDIO_IT") != "1" {
		t.Skip("set AGENTSTUDIO_IT=1 to run against the local stack")
	}
	env := loadLocalEnv(t)
	api := &mx{t: t, base: env["AGENTSTUDIO_SERVER_URL"]}
	m := &mx{t: t, base: env["SYNAPSE_URL"]}
	var userID string
	// agentstudio-api only accepts agents and approvals for its own users, so prefer an
	// email-code sign-in through the API; fall back to a bare Synapse JWT user.
	apiUp := apiInternalAvailable(env)
	if apiUp {
		email := fmt.Sprintf("agit-%d@example.com", time.Now().UnixNano())
		if code := api.call("POST", "/v1/auth/email/start", map[string]any{"email": email}, nil); code != 204 {
			t.Fatalf("email start: %d", code)
		}
		var outbox struct {
			Messages []struct {
				Code string `json:"code"`
			} `json:"messages"`
		}
		api.call("GET", "/v1/dev/outbox?email="+url.QueryEscape(email), nil, &outbox)
		if len(outbox.Messages) == 0 {
			t.Fatal("no sign-in code in the dev outbox")
		}
		var session struct {
			AccessToken string `json:"access_token"`
			Matrix      struct {
				HomeserverURL string `json:"homeserver_url"`
				UserID        string `json:"user_id"`
				AccessToken   string `json:"access_token"`
			} `json:"matrix"`
		}
		if code := api.call("POST", "/v1/auth/email/verify", map[string]any{"email": email, "code": outbox.Messages[0].Code, "device_name": "agents-it"}, &session); code != 200 {
			t.Fatalf("email verify: %d", code)
		}
		api.token = session.AccessToken
		userID = session.Matrix.UserID
		m.base, m.token = session.Matrix.HomeserverURL, session.Matrix.AccessToken
	} else {
		t.Log("agentstudio-api internal routes are not available: using a Synapse JWT user, no approval card is expected")
		localpart := fmt.Sprintf("u_agit%d", time.Now().UnixNano())
		userID = "@" + localpart + ":" + env["MATRIX_SERVER_NAME"]
		tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": localpart}).SignedString([]byte(env["SYNAPSE_JWT_SECRET"]))
		if err != nil {
			t.Fatal(err)
		}
		var login struct {
			AccessToken string `json:"access_token"`
			UserID      string `json:"user_id"`
		}
		if code := m.call("POST", "/_matrix/client/v3/login", map[string]any{"type": "org.matrix.login.jwt", "token": tok}, &login); code != 200 || login.UserID != userID {
			t.Fatalf("jwt login: %d %+v", code, login)
		}
		m.token = login.AccessToken
	}
	t.Logf("user %s", userID)
	m.sync() // initial sync, so later syncs only show new events

	// 2. Connect the concierge through the provisioning API.
	prov := &mx{t: t, base: env["AGENTS_BRIDGE_URL"], token: env["AGENTS_PROVISION_SECRET"]}
	var step struct {
		Type     string `json:"type"`
		Complete struct {
			UserLoginID string `json:"user_login_id"`
		} `json:"complete"`
	}
	if code := prov.call("POST", "/_matrix/provision/v3/login/start/concierge?user_id="+url.QueryEscape(userID), map[string]any{}, &step); code != 200 || step.Type != "complete" {
		t.Fatalf("login: %d %+v", code, step)
	}
	loginID := step.Complete.UserLoginID
	agentID := AgentIDPrefix + loginID
	ghost := "@agents_" + loginID + ":" + env["MATRIX_SERVER_NAME"]
	t.Logf("login %s, agent %s, ghost %s", loginID, agentID, ghost)

	// 3. The user is invited to the DM with the agent ghost; join it.
	var roomID string
	deadline := time.Now().Add(30 * time.Second)
	for roomID == "" && time.Now().Before(deadline) {
		for rid := range m.sync().Rooms.Invite {
			roomID = rid
		}
	}
	if roomID == "" {
		t.Fatal("no invite to the agent room")
	}
	if code := m.call("POST", "/_matrix/client/v3/join/"+url.PathEscape(roomID), map[string]any{}, nil); code != 200 {
		t.Fatalf("join: %d", code)
	}
	var state []syncEvent
	m.call("GET", "/_matrix/client/v3/rooms/"+url.PathEscape(roomID)+"/state", nil, &state)
	var protocolID string
	for _, e := range state {
		if e.Type == "m.bridge" {
			if p, ok := e.Content["protocol"].(map[string]any); ok {
				protocolID, _ = p["id"].(string)
			}
		}
	}
	if protocolID != "agentstudio-agents" {
		t.Fatalf("m.bridge protocol.id = %q", protocolID)
	}

	txn := 0
	send := func(content map[string]any) string {
		txn++
		var resp struct {
			EventID string `json:"event_id"`
		}
		path := fmt.Sprintf("/_matrix/client/v3/rooms/%s/send/m.room.message/it%d", url.PathEscape(roomID), txn)
		if code := m.call("PUT", path, content, &resp); code != 200 {
			t.Fatalf("send: %d", code)
		}
		return resp.EventID
	}
	fromGhostWithBody := func(body string) func(syncEvent) bool {
		return func(e syncEvent) bool {
			return e.Type == "m.room.message" && e.Sender == ghost && e.Content["body"] == body
		}
	}

	// 4. Plain chat.
	send(map[string]any{"msgtype": "m.text", "body": "hello concierge"})
	m.waitTimeline(roomID, "echo", fromGhostWithBody("You said: hello concierge"))

	// 5. Flight: message, then an approval card (needs agentstudio-api's internal routes).
	flightEvent := send(map[string]any{"msgtype": "m.text", "body": "find me a flight to Toronto"})
	m.waitTimeline(roomID, "flight result", fromGhostWithBody(concierge.FlightFound))
	approvalID := "apr_it_unregistered"
	if apiUp {
		card := m.waitTimeline(roomID, "approval card", func(e syncEvent) bool {
			return e.Sender == ghost && e.Content["com.agentstudio.approval"] != nil
		})
		ap := card.Content["com.agentstudio.approval"].(map[string]any)
		approvalID, _ = ap["approval_id"].(string)
		if card.Content["body"] != "Approval needed: "+concierge.FlightTitle || ap["v"] != float64(1) || approvalID == "" {
			t.Fatalf("approval card: %+v", card.Content)
		}
		t.Logf("approval card %s for approval %s", card.EventID, approvalID)
		var agents struct {
			Agents []struct {
				ID     string `json:"id"`
				RoomID string `json:"room_id"`
				Name   string `json:"name"`
			} `json:"agents"`
		}
		api.call("GET", "/v1/agents", nil, &agents)
		// Bridge state (status_endpoint) reaches the API as a connection.
		var conns struct {
			Connections []struct {
				ID         string `json:"id"`
				State      string `json:"state"`
				RemoteName string `json:"remote_name"`
			} `json:"connections"`
		}
		for i := 0; i < 50; i++ {
			api.call("GET", "/v1/connections", nil, &conns)
			if len(conns.Connections) == 1 && conns.Connections[0].State == "connected" {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if len(conns.Connections) != 1 || conns.Connections[0].ID != agentID || conns.Connections[0].State != "connected" {
			t.Fatalf("GET /v1/connections: %+v", conns)
		}
		if len(agents.Agents) != 1 || agents.Agents[0].ID != agentID || agents.Agents[0].RoomID != roomID || agents.Agents[0].Name != "Concierge" {
			t.Fatalf("GET /v1/agents: %+v", agents)
		}
	}

	// 6. Decision -> bridge hook -> agent -> "Booked..." in the room. With the real API the
	// decision goes through POST /v1/approvals/{id}/decision; otherwise the hook is called directly.
	hook := &mx{t: t, base: env["AGENTS_BRIDGE_URL"], token: env["AGENTSTUDIO_INTERNAL_SECRET"]}
	if apiUp {
		var apr struct {
			Version       int    `json:"version"`
			State         string `json:"state"`
			DeliveryState string `json:"delivery_state"`
			EventID       string `json:"event_id"`
		}
		api.call("GET", "/v1/approvals/"+approvalID, nil, &apr)
		if apr.State != "pending" || apr.EventID == "" {
			t.Fatalf("approval before decision: %+v", apr)
		}
		code := api.call("POST", "/v1/approvals/"+approvalID+"/decision", map[string]any{
			"choice": "book", "version": apr.Version, "idempotency_key": fmt.Sprintf("it-%d", time.Now().UnixNano()),
		}, &apr)
		if code != 200 || apr.State != "decided" || apr.DeliveryState != "delivered" {
			t.Fatalf("decision via API: %d %+v", code, apr)
		}
	} else if code := hook.call("POST", "/agentstudio/internal/v1/approval-decisions", map[string]any{
		"approval_id": approvalID, "agent_id": agentID, "external_id": concierge.FlightExternalID(flightEvent), "choice": "book",
	}, nil); code != 200 {
		t.Fatalf("decision hook: %d", code)
	}
	m.waitTimeline(roomID, "booked message", fromGhostWithBody(concierge.BookedText))
	if code := hook.call("POST", "/agentstudio/internal/v1/approval-decisions", map[string]any{
		"approval_id": approvalID, "agent_id": AgentIDPrefix + "agent-000000000000", "external_id": "flight-x", "choice": "book",
	}, nil); code != 404 {
		t.Fatalf("decision for unknown agent: %d", code)
	}

	// 7. Ask -> drafts notice.
	taskID := fmt.Sprintf("tsk_it_%d", time.Now().UnixNano())
	if apiUp {
		var task struct {
			ID string `json:"id"`
		}
		code := api.call("POST", "/v1/tasks", map[string]any{
			"agent_id": agentID, "idempotency_key": taskID, "request_text": "Draft a reply",
			"origin": map[string]any{"room_id": roomID, "network": "demo", "chat_name": "Leo Park", "anchor_event_id": flightEvent},
		}, &task)
		if code != 200 && code != 201 || task.ID == "" {
			t.Fatalf("create task: %d %+v", code, task)
		}
		taskID = task.ID
	}
	send(map[string]any{
		"msgtype": "m.text",
		"body":    "Ask: Draft a reply\n\nFrom Leo Park in Demo:\n> Leo Park: Are we still on for 7:15?",
		"com.agentstudio.ask": map[string]any{
			"v": 1, "task_id": taskID, "app": "Demo", "chat": "Leo Park", "request": "Draft a reply",
			"lines": []any{map[string]any{"speaker": "Leo Park", "own": false, "ts": 1762070000000, "text": "Are we still on for 7:15?"}},
		},
	})
	notice := m.waitTimeline(roomID, "drafts notice", func(e syncEvent) bool {
		return e.Sender == ghost && e.Content["com.agentstudio.drafts"] != nil
	})
	d := notice.Content["com.agentstudio.drafts"].(map[string]any)
	drafts, _ := d["drafts"].([]any)
	if notice.Content["msgtype"] != "m.notice" || d["task_id"] != taskID || d["v"] != float64(1) || len(drafts) != 3 ||
		drafts[0].(map[string]any)["text"] != "Leo, sounds good, see you then!" ||
		!strings.HasPrefix(notice.Content["body"].(string), "Here are 3 drafts:\n1. Leo, sounds good, see you then!") {
		t.Fatalf("drafts notice: %+v", notice.Content)
	}
	t.Logf("drafts notice %s", notice.EventID)
	if apiUp {
		var task struct {
			State  string `json:"state"`
			Answer *struct {
				EventID string `json:"event_id"`
				Drafts  []any  `json:"drafts"`
			} `json:"answer"`
		}
		var tasks struct {
			Tasks []json.RawMessage `json:"tasks"`
		}
		api.call("GET", "/v1/tasks?state=all", nil, &tasks)
		for _, raw := range tasks.Tasks {
			var probe struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(raw, &probe)
			if probe.ID == taskID {
				_ = json.Unmarshal(raw, &task)
			}
		}
		if task.State != "answered" || task.Answer == nil || task.Answer.EventID != notice.EventID || len(task.Answer.Drafts) != 3 {
			t.Fatalf("task after drafts: %+v", task)
		}
		var agents struct {
			Agents []struct {
				Status string `json:"status"`
			} `json:"agents"`
		}
		api.call("GET", "/v1/agents", nil, &agents)
		if len(agents.Agents) != 1 || agents.Agents[0].Status != "idle" {
			t.Fatalf("agent status: %+v", agents)
		}
	}

	// 8. Optional: survive restarts of the concierge (sessions lost) and of the bridge (sessions re-registered).
	if os.Getenv("AGENTSTUDIO_IT_RESTART") == "1" {
		restart := func(svc string) {
			cmd := exec.Command("node", "dev/stack.mjs", "restart", svc)
			cmd.Dir = filepath.Join(filepath.Dir(env["AGENTSTUDIO_LOCAL_DIR"]))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("restart %s: %v\n%s", svc, err, out)
			}
		}
		restart("concierge")
		send(map[string]any{"msgtype": "m.text", "body": "after concierge restart"})
		m.waitTimeline(roomID, "echo after concierge restart", fromGhostWithBody("You said: after concierge restart"))
		restart("agents")
		send(map[string]any{"msgtype": "m.text", "body": "after bridge restart"})
		m.waitTimeline(roomID, "echo after bridge restart", fromGhostWithBody("You said: after bridge restart"))
	}
}

// apiInternalAvailable reports whether agentstudio-api serves the internal approval routes yet:
// an implemented POST /internal/v1/approvals rejects an empty body with 400, the skeleton answers 404.
func apiInternalAvailable(env map[string]string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", env["AGENTSTUDIO_SERVER_URL"]+"/internal/v1/approvals", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+env["AGENTSTUDIO_INTERNAL_SECRET"])
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed
}
