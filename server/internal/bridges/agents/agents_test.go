package agents

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

const testSecret = "internal-secret"

// fakeAPI records internal API calls.
type fakeAPI struct {
	mu    sync.Mutex
	calls []apiCall
	fail  map[string]int // "METHOD /path" -> status to answer with
}

type apiCall struct {
	Method, Path string
	Body         map[string]any
}

func newFakeAPI(t *testing.T) (*fakeAPI, *httptest.Server) {
	fa := &fakeAPI{fail: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if agentproto.BearerToken(r) != testSecret {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		key := r.Method + " " + r.URL.EscapedPath()
		fa.mu.Lock()
		fa.calls = append(fa.calls, apiCall{r.Method, r.URL.EscapedPath(), body})
		status := fa.fail[key]
		fa.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		if key == "POST /internal/v1/approvals" {
			agentproto.WriteJSON(w, 200, map[string]any{"id": "apr_" + body["external_id"].(string), "version": 1})
			return
		}
		agentproto.WriteJSON(w, 200, map[string]any{})
	}))
	t.Cleanup(srv.Close)
	return fa, srv
}

func (fa *fakeAPI) get() []apiCall {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	return append([]apiCall(nil), fa.calls...)
}

type sent struct {
	Content *event.MessageEventContent
	Extra   map[string]any
	ReplyTo string
	TS      time.Time
	// File is set for SendFile.
	File []byte
}

// fakeSession is a callbackSession with an in-memory room.
type fakeSession struct {
	mu        sync.Mutex
	hash      []byte
	msgs      []sent
	approvals map[string]approvalRef
	sendErr   error
}

func newFakeSession(token string) *fakeSession {
	h := agentproto.HashToken(token)
	return &fakeSession{hash: h[:], approvals: map[string]approvalRef{}}
}

func (fs *fakeSession) tokenHash() []byte { return fs.hash }

func (fs *fakeSession) target() *eventTarget {
	return &eventTarget{
		AgentID:   "agentstudio-agents:agent-abc",
		OwnerMXID: "@u_x:agentstudio.local",
		Send: func(_ context.Context, c *event.MessageEventContent, extra map[string]any, replyTo string, ts time.Time) (id.EventID, id.RoomID, error) {
			fs.mu.Lock()
			defer fs.mu.Unlock()
			if fs.sendErr != nil {
				return "", "", fs.sendErr
			}
			fs.msgs = append(fs.msgs, sent{Content: c, Extra: extra, ReplyTo: replyTo, TS: ts})
			return id.EventID("$e" + string(rune('0'+len(fs.msgs)))), "!room:agentstudio.local", nil
		},
		SendFile: func(_ context.Context, data []byte, name, mimeType string, extra map[string]any, ts time.Time) (id.EventID, error) {
			fs.mu.Lock()
			defer fs.mu.Unlock()
			msgType := event.MsgFile
			if strings.HasPrefix(mimeType, "image/") {
				msgType = event.MsgImage
			}
			fs.msgs = append(fs.msgs, sent{Content: &event.MessageEventContent{MsgType: msgType, Body: name, Info: &event.FileInfo{MimeType: mimeType}}, Extra: extra, TS: ts, File: data})
			return id.EventID("$f" + string(rune('0'+len(fs.msgs)))), nil
		},
		GetApproval: func(ext string) *approvalRef {
			fs.mu.Lock()
			defer fs.mu.Unlock()
			if r, ok := fs.approvals[ext]; ok {
				return &r
			}
			return nil
		},
		PutApproval: func(ref approvalRef) {
			fs.mu.Lock()
			defer fs.mu.Unlock()
			fs.approvals[ref.ExternalID] = ref
		},
	}
}

func setupConnector(t *testing.T) (*Connector, *fakeAPI, *httptest.Server, *fakeSession) {
	t.Helper()
	fa, apiSrv := newFakeAPI(t)
	c := NewConnector()
	c.Config = Config{APIURL: apiSrv.URL, InternalSecret: testSecret, PublicURL: "http://bridge"}
	c.api = &APIClient{BaseURL: apiSrv.URL, Secret: testSecret}
	fs := newFakeSession("cbtok")
	c.setCallback("key1", fs)
	mux := http.NewServeMux()
	c.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return c, fa, srv, fs
}

func post(t *testing.T, url, token, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

func eventJSON(e agentproto.AgentEvent) string {
	data, _ := json.Marshal(e)
	return string(data)
}

func TestCallbackAuth(t *testing.T) {
	_, _, srv, fs := setupConnector(t)
	url := srv.URL + "/agentstudio/v0/callback/key1/events"
	msg := eventJSON(agentproto.NewMessage("hi"))
	if code, _ := post(t, srv.URL+"/agentstudio/v0/callback/nope/events", "cbtok", msg); code != 404 {
		t.Fatalf("unknown key: %d", code)
	}
	if code, _ := post(t, url, "wrong", msg); code != 401 {
		t.Fatalf("bad token: %d", code)
	}
	if code, _ := post(t, url, "", msg); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := post(t, url, "cbtok", `{"type":"message","text":""}`); code != 400 {
		t.Fatalf("invalid event: %d", code)
	}
	if code, _ := post(t, url, "cbtok", `not json`); code != 400 {
		t.Fatalf("bad json: %d", code)
	}
	code, body := post(t, url, "cbtok", `{"type":"message","text":"hello","reply_to":"$user"}`)
	if code != 200 || strings.TrimSpace(body) != `{"ok":true}` {
		t.Fatalf("message: %d %s", code, body)
	}
	if len(fs.msgs) != 1 || fs.msgs[0].Content.Body != "hello" || fs.msgs[0].Content.MsgType != event.MsgText || fs.msgs[0].ReplyTo != "$user" {
		t.Fatalf("sent: %+v", fs.msgs)
	}
	fs.sendErr = errors.New("matrix down")
	if code, _ := post(t, url, "cbtok", msg); code != 502 {
		t.Fatalf("send failure should be 502, got %d", code)
	}
}

func TestMessageMarkersAndAttachments(t *testing.T) {
	_, _, srv, fs := setupConnector(t)
	url := srv.URL + "/agentstudio/v0/callback/key1/events"
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chart.png" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("\x89PNG fake"))
	}))
	t.Cleanup(files.Close)

	// Said in the service's own app, imported from history, with its time.
	code, body := post(t, url, "cbtok", `{"type":"message","text":"from my phone","from_user":true,"via":"Grok Bot","history":true,"ts":"2026-11-01T10:00:00Z"}`)
	if code != 200 {
		t.Fatalf("message: %d %s", code, body)
	}
	m := fs.msgs[0]
	if m.Extra[KeyFromUser] != true || m.Extra[KeyVia] != "Grok Bot" || m.Extra[KeyHistory] != true || !m.TS.Equal(time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("markers: %+v", m)
	}

	// Attachments: an image comes over as a file; one that can't be fetched becomes a link.
	code, body = post(t, url, "cbtok", `{"type":"message","text":"here","attachments":[{"url":"`+files.URL+`/chart.png","name":"chart.png"},{"url":"`+files.URL+`/gone.pdf","name":"gone.pdf"}]}`)
	if code != 200 {
		t.Fatalf("attachments: %d %s", code, body)
	}
	if len(fs.msgs) != 4 || fs.msgs[1].Content.Body != "here" {
		t.Fatalf("sent: %+v", fs.msgs)
	}
	if img := fs.msgs[2]; img.Content.MsgType != event.MsgImage || img.Content.Body != "chart.png" || string(img.File) != "\x89PNG fake" {
		t.Fatalf("image: %+v", img)
	}
	if link := fs.msgs[3]; link.Content.MsgType != event.MsgText || !strings.Contains(link.Content.Body, "gone.pdf") {
		t.Fatalf("link: %+v", link)
	}

	// A message may be only attachments; but not more than ten, and not a future time.
	if code, _ := post(t, url, "cbtok", `{"type":"message","attachments":[{"url":"`+files.URL+`/chart.png"}]}`); code != 200 {
		t.Fatalf("attachments only: %d", code)
	}
	if code, _ := post(t, url, "cbtok", `{"type":"message","text":"x","ts":"2999-01-01T00:00:00Z"}`); code != 400 {
		t.Fatalf("future ts: %d", code)
	}
	if code, _ := post(t, url, "cbtok", `{"type":"message","text":"x","attachments":[{"url":"file:///etc/passwd"}]}`); code != 400 {
		t.Fatalf("bad attachment url: %d", code)
	}
}

func TestDraftsEvent(t *testing.T) {
	_, fa, srv, fs := setupConnector(t)
	code, _ := post(t, srv.URL+"/agentstudio/v0/callback/key1/events", "cbtok",
		eventJSON(agentproto.NewDrafts("tsk_1", "One", "Two", "Three")))
	if code != 200 {
		t.Fatalf("drafts: %d", code)
	}
	m := fs.msgs[0]
	if m.Content.MsgType != event.MsgNotice || m.Content.Body != "Here are 3 drafts:\n1. One\n2. Two\n3. Three" {
		t.Fatalf("content: %+v", m.Content)
	}
	extra, _ := json.Marshal(m.Extra)
	if string(extra) != `{"com.agentstudio.drafts":{"drafts":[{"text":"One"},{"text":"Two"},{"text":"Three"}],"task_id":"tsk_1","v":1}}` {
		t.Fatalf("extra: %s", extra)
	}
	calls := fa.get()
	if len(calls) != 1 || calls[0].Method != "POST" || calls[0].Path != "/internal/v1/tasks/tsk_1/answer" ||
		calls[0].Body["event_id"] != "$e1" || len(calls[0].Body["drafts"].([]any)) != 3 {
		t.Fatalf("api calls: %+v", calls)
	}
	// A failed answer still acknowledges the event (the drafts are in the room).
	fa.fail["POST /internal/v1/tasks/tsk_2/answer"] = 500
	if code, _ = post(t, srv.URL+"/agentstudio/v0/callback/key1/events", "cbtok", eventJSON(agentproto.NewDrafts("tsk_2", "x"))); code != 200 {
		t.Fatalf("drafts with failing API: %d", code)
	}
	if fs.msgs[1].Content.Body != "Here is a draft:\n1. x" {
		t.Fatalf("single draft body: %q", fs.msgs[1].Content.Body)
	}
}

func TestApprovalEvents(t *testing.T) {
	_, fa, srv, fs := setupConnector(t)
	url := srv.URL + "/agentstudio/v0/callback/key1/events"
	ar := agentproto.NewApprovalRequest(agentproto.ApprovalRequestEvent{
		ExternalID: "flight-1", Title: "Book it?", Summary: "s",
		Details:          []agentproto.Detail{{Label: "Date", Value: "Friday"}},
		Choices:          []agentproto.Choice{{Key: "book", Label: "Book", Category: "approve"}, {Key: "skip", Label: "No", Category: "deny"}},
		ExpiresInSeconds: 2700,
	})
	if code, body := post(t, url, "cbtok", eventJSON(ar)); code != 200 {
		t.Fatalf("approval: %d %s", code, body)
	}
	calls := fa.get()
	if len(calls) != 2 {
		t.Fatalf("calls: %+v", calls)
	}
	create := calls[0]
	if create.Path != "/internal/v1/approvals" || create.Body["owner_mxid"] != "@u_x:agentstudio.local" ||
		create.Body["agent_id"] != "agentstudio-agents:agent-abc" || create.Body["external_id"] != "flight-1" ||
		create.Body["title"] != "Book it?" || create.Body["expires_at"] == nil || len(create.Body["choices"].([]any)) != 2 {
		t.Fatalf("create: %+v", create)
	}
	m := fs.msgs[0]
	extra, _ := json.Marshal(m.Extra)
	if m.Content.Body != "Approval needed: Book it?" || m.Content.MsgType != event.MsgText ||
		string(extra) != `{"com.agentstudio.approval":{"approval_id":"apr_flight-1","v":1}}` {
		t.Fatalf("card: %+v %s", m.Content, extra)
	}
	patch := calls[1]
	if patch.Method != "PATCH" || patch.Path != "/internal/v1/approvals/apr_flight-1" ||
		patch.Body["room_id"] != "!room:agentstudio.local" || patch.Body["event_id"] != "$e1" {
		t.Fatalf("patch: %+v", patch)
	}
	// A retried approval_request does not post a second card.
	if code, _ := post(t, url, "cbtok", eventJSON(ar)); code != 200 || len(fs.msgs) != 1 {
		t.Fatalf("retry posted again: %d msgs", len(fs.msgs))
	}
	// Cancel.
	if code, _ := post(t, url, "cbtok", eventJSON(agentproto.NewApprovalCancel("flight-1"))); code != 200 {
		t.Fatalf("cancel: %d", code)
	}
	last := fa.get()[len(fa.get())-1]
	if last.Method != "PATCH" || last.Path != "/internal/v1/approvals/apr_flight-1" || last.Body["state"] != "cancelled" {
		t.Fatalf("cancel call: %+v", last)
	}
	// Cancel of an unknown approval is a no-op.
	n := len(fa.get())
	if code, _ := post(t, url, "cbtok", eventJSON(agentproto.NewApprovalCancel("nope"))); code != 200 || len(fa.get()) != n {
		t.Fatalf("unknown cancel")
	}
	// If the API can't create the approval, the agent gets 502 and no card is posted.
	fa.fail["POST /internal/v1/approvals"] = 404
	ar.ApprovalRequest.ExternalID = "flight-2"
	if code, _ := post(t, url, "cbtok", eventJSON(ar)); code != 502 || len(fs.msgs) != 1 {
		t.Fatalf("API failure: %d, %d msgs", code, len(fs.msgs))
	}
}

func TestStatusEvent(t *testing.T) {
	_, fa, srv, _ := setupConnector(t)
	if code, _ := post(t, srv.URL+"/agentstudio/v0/callback/key1/events", "cbtok",
		eventJSON(agentproto.NewStatus(agentproto.StateWorking, "Searching flights"))); code != 200 {
		t.Fatalf("status: %d", code)
	}
	c := fa.get()[0]
	if c.Method != "PATCH" || c.Path != "/internal/v1/agents/agentstudio-agents:agent-abc" ||
		c.Body["status"] != "working" || c.Body["status_text"] != "Searching flights" {
		t.Fatalf("status call: %+v", c)
	}
	// idle with no text clears the status text.
	_, _ = post(t, srv.URL+"/agentstudio/v0/callback/key1/events", "cbtok", eventJSON(agentproto.NewStatus(agentproto.StateIdle, "")))
	if c = fa.get()[1]; c.Body["status"] != "idle" || c.Body["status_text"] != "" {
		t.Fatalf("idle call: %+v", c.Body)
	}
}

type fakeReceiver struct {
	err  error
	got  agentproto.DecisionRequest
	ext  string
	seen bool
}

func (fr *fakeReceiver) deliverDecision(_ context.Context, ext string, req *agentproto.DecisionRequest) error {
	fr.seen, fr.ext, fr.got = true, ext, *req
	return fr.err
}

func TestDecisionHook(t *testing.T) {
	c, _, srv, _ := setupConnector(t)
	recv := &fakeReceiver{}
	c.findReceiver = func(_ context.Context, agentID string) (decisionReceiver, error) {
		if agentID == "agentstudio-agents:agent-abc" {
			return recv, nil
		}
		return nil, nil
	}
	url := srv.URL + "/agentstudio/internal/v1/approval-decisions"
	body := `{"approval_id":"apr_1","agent_id":"agentstudio-agents:agent-abc","external_id":"flight-1","choice":"book"}`
	if code, _ := post(t, url, "wrong", body); code != 401 {
		t.Fatalf("bad secret: %d", code)
	}
	if code, _ := post(t, url, testSecret, `{"agent_id":"x"}`); code != 400 {
		t.Fatalf("bad body: %d", code)
	}
	if code, _ := post(t, url, testSecret, strings.Replace(body, "agent-abc", "agent-zzz", 1)); code != 404 {
		t.Fatalf("unknown agent: %d", code)
	}
	if code, _ := post(t, url, testSecret, body); code != 200 || recv.ext != "flight-1" || recv.got != (agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "book"}) {
		t.Fatalf("deliver: %d %+v", code, recv)
	}
	recv.err = errors.New("agent down")
	if code, _ := post(t, url, testSecret, body); code != 502 {
		t.Fatalf("agent failure should be 502, got %d", code)
	}
}

func TestBuildInbound(t *testing.T) {
	evt := &event.Event{ID: "$m1", Timestamp: 1762070000000, Content: event.Content{Raw: map[string]any{}}}
	content := &event.MessageEventContent{MsgType: event.MsgText, Body: "find me a flight"}
	msg, err := buildInbound("ses_1", evt, content)
	if err != nil || msg.Ask != nil || msg.MessageID != "$m1" || msg.Text != "find me a flight" || msg.SessionID != "ses_1" ||
		msg.SentAt != "2025-11-02T07:53:20Z" {
		t.Fatalf("plain: %v %+v", err, msg)
	}

	lines := make([]any, 7)
	for i := range lines {
		lines[i] = map[string]any{"speaker": "Leo Park", "own": false, "ts": i, "text": strings.Repeat("x", 2500)}
	}
	evt.Content.Raw[KeyAsk] = map[string]any{"v": 1, "task_id": "tsk_1", "app": "Demo", "chat": "Leo Park", "request": "Draft a reply", "lines": lines}
	msg, err = buildInbound("ses_1", evt, content)
	if err != nil || msg.Ask == nil {
		t.Fatalf("ask: %v", err)
	}
	a := msg.Ask
	if a.TaskID != "tsk_1" || a.App != "Demo" || a.Chat != "Leo Park" || a.Request != "Draft a reply" ||
		len(a.Lines) != 5 || a.Lines[0].TS != 2 || len([]rune(a.Lines[0].Text)) != 2000 {
		t.Fatalf("ask fields: %+v", a)
	}
	data, _ := json.Marshal(msg)
	if strings.Contains(string(data), `"v"`) {
		t.Fatalf("wire ask must not carry the content version: %s", data)
	}

	evt.Content.Raw[KeyAsk] = map[string]any{"v": 1}
	if _, err = buildInbound("ses_1", evt, content); err == nil {
		t.Fatal("ask without task_id must fail")
	}
	evt.Content.Raw[KeyAsk] = "nonsense"
	if _, err = buildInbound("ses_1", evt, content); err == nil {
		t.Fatal("malformed ask must fail")
	}
}

func TestLoginIDFor(t *testing.T) {
	a := LoginIDFor("@u_1:agentstudio.local", "http://127.0.0.1:18201")
	if a != LoginIDFor("@u_1:agentstudio.local", "http://127.0.0.1:18201") || !strings.HasPrefix(string(a), "agent-") || len(a) != len("agent-")+12 {
		t.Fatalf("unstable or malformed: %s", a)
	}
	if a == LoginIDFor("@u_2:agentstudio.local", "http://127.0.0.1:18201") || a == LoginIDFor("@u_1:agentstudio.local", "http://other") {
		t.Fatal("ids must differ per user and agent")
	}
}

func TestConfigEnvFallback(t *testing.T) {
	t.Setenv("AGENTSTUDIO_CONCIERGE_URL", "http://c/")
	t.Setenv("AGENTSTUDIO_SERVER_URL", "http://api")
	t.Setenv("AGENTSTUDIO_INTERNAL_SECRET", "s")
	t.Setenv("AGENTS_BRIDGE_URL", "http://bridge/")
	c := NewConnector()
	c.Config.APIURL = "http://configured"
	if err := c.ValidateConfig(); err != nil {
		t.Fatal(err)
	}
	if c.Config.ConciergeURL != "http://c" || c.Config.APIURL != "http://configured" || c.Config.PublicURL != "http://bridge" {
		t.Fatalf("config: %+v", c.Config)
	}
	if got := c.callbackURL("k"); got != "http://bridge/agentstudio/v0/callback/k" {
		t.Fatalf("callback url %s", got)
	}
	if flows := c.GetLoginFlows(); len(flows) != 2 || flows[0].ID != "concierge" || flows[1].ID != "endpoint" {
		t.Fatalf("flows: %+v", flows)
	}
}
