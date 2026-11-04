package concierge

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// fakeBridge records callback events.
type fakeBridge struct {
	t      *testing.T
	token  string
	mu     sync.Mutex
	events []agentproto.AgentEvent
	got    chan agentproto.AgentEvent
	fail   int    // number of requests to answer with 500 first
	url    string // callback_url for sessions
}

func newFakeBridge(t *testing.T, token string) (*fakeBridge, *httptest.Server) {
	fb := &fakeBridge{t: t, token: token, got: make(chan agentproto.AgentEvent, 32)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agentstudio/v0/callback/key/events" {
			w.WriteHeader(404)
			return
		}
		if agentproto.BearerToken(r) != fb.token {
			w.WriteHeader(401)
			return
		}
		fb.mu.Lock()
		if fb.fail > 0 {
			fb.fail--
			fb.mu.Unlock()
			w.WriteHeader(500)
			return
		}
		fb.mu.Unlock()
		var evt agentproto.AgentEvent
		if err := agentproto.ReadJSON(r, agentproto.MaxEventBodySize, &evt); err != nil || evt.Validate() != nil {
			w.WriteHeader(400)
			return
		}
		fb.mu.Lock()
		fb.events = append(fb.events, evt)
		fb.mu.Unlock()
		fb.got <- evt
		agentproto.WriteJSON(w, 200, map[string]bool{"ok": true})
	}))
	t.Cleanup(srv.Close)
	fb.url = srv.URL + "/agentstudio/v0/callback/key"
	return fb, srv
}

func (fb *fakeBridge) next() agentproto.AgentEvent {
	fb.t.Helper()
	select {
	case evt := <-fb.got:
		return evt
	case <-time.After(5 * time.Second):
		fb.t.Fatal("timed out waiting for callback event")
		return agentproto.AgentEvent{}
	}
}

func (fb *fakeBridge) none() {
	fb.t.Helper()
	select {
	case evt := <-fb.got:
		fb.t.Fatalf("unexpected event %s", evt.Type)
	case <-time.After(200 * time.Millisecond):
	}
}

func setup(t *testing.T) (*fakeBridge, *httptest.Server, *agentproto.Client, string) {
	t.Helper()
	fb, _ := newFakeBridge(t, "cbtoken")
	a := New(Config{Delay: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	t.Cleanup(a.Close)
	agentSrv := httptest.NewServer(a.Handler())
	t.Cleanup(agentSrv.Close)
	c := &agentproto.Client{BaseURL: agentSrv.URL}
	sid, err := c.CreateSession(t.Context(), &agentproto.CreateSessionRequest{
		CallbackURL:   fb.url,
		CallbackToken: "cbtoken",
		User:          agentproto.SessionUser{DisplayName: "Tester"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return fb, agentSrv, c, sid
}

func TestInfo(t *testing.T) {
	_, _, c, _ := setup(t)
	info, err := c.Info(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "Concierge" || len(info.Capabilities) != 3 || info.Capabilities[0] != "chat" ||
		info.Capabilities[1] != "ask" || info.Capabilities[2] != "approvals" {
		t.Fatalf("unexpected info %+v", info)
	}
}

func TestFlightFlow(t *testing.T) {
	fb, _, c, sid := setup(t)
	err := c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$m1", Text: "Find me a FLIGHT to Toronto"})
	if err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Type != agentproto.EventStatus || e.Status.State != "working" || e.Status.Text != "Searching flights" {
		t.Fatalf("event 1: %+v", e.Status)
	}
	if e := fb.next(); e.Type != agentproto.EventMessage || e.Message.Text != "Found a nonstop to Toronto on Friday at 6:00 PM for $412." {
		t.Fatalf("event 2: %+v", e)
	}
	e := fb.next()
	ar := e.ApprovalRequest
	if e.Type != agentproto.EventApprovalRequest || ar.Title != "Book the 6pm flight to Toronto for $412?" ||
		ar.ExpiresInSeconds != 2700 || ar.ExternalID != FlightExternalID("$m1") || len(ar.ExternalID) != len("flight-")+12 {
		t.Fatalf("event 3: %+v", ar)
	}
	wantDetails := []agentproto.Detail{{Label: "Date", Value: "Friday"}, {Label: "Route", Value: "Nonstop"}, {Label: "Seat", Value: "14A, carry-on only"}}
	for i, d := range wantDetails {
		if ar.Details[i] != d {
			t.Fatalf("detail %d: %+v", i, ar.Details[i])
		}
	}
	if ar.Choices[0] != (agentproto.Choice{Key: "book", Label: "Book", Category: "approve"}) ||
		ar.Choices[1] != (agentproto.Choice{Key: "skip", Label: "Don't book", Category: "deny"}) {
		t.Fatalf("choices: %+v", ar.Choices)
	}
	if e := fb.next(); e.Type != agentproto.EventStatus || e.Status.State != "idle" {
		t.Fatalf("event 4: %+v", e)
	}

	err = c.SendDecision(t.Context(), sid, ar.ExternalID, &agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "book"})
	if err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Message == nil || e.Message.Text != "Booked. Seat 14A, confirmation PCH412." {
		t.Fatalf("decision reply: %+v", e)
	}
	// A repeated delivery is acknowledged without a second reply.
	if err = c.SendDecision(t.Context(), sid, ar.ExternalID, &agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "book"}); err != nil {
		t.Fatal(err)
	}
	fb.none()

	other := FlightExternalID("$m2")
	if err = c.SendDecision(t.Context(), sid, other, &agentproto.DecisionRequest{ApprovalID: "apr_2", Choice: "skip"}); err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Message.Text != "Okay, I won't book it." {
		t.Fatalf("skip reply: %+v", e.Message)
	}
	if err = c.SendDecision(t.Context(), sid, other, &agentproto.DecisionRequest{Choice: "maybe"}); !agentproto.IsStatus(err, 400) {
		t.Fatalf("expected 400 for unknown choice, got %v", err)
	}
	if err = c.SendDecision(t.Context(), sid, "other-1", &agentproto.DecisionRequest{Choice: "book"}); !agentproto.IsStatus(err, 404) {
		t.Fatalf("expected 404 for unknown approval, got %v", err)
	}
}

func TestEchoAndAsk(t *testing.T) {
	fb, _, c, sid := setup(t)
	if err := c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$a", Text: "hello there"}); err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Message.Text != "You said: hello there" {
		t.Fatalf("echo: %+v", e.Message)
	}
	// An ask wins over the "flight" keyword.
	ask := &agentproto.Ask{TaskID: "tsk_1", App: "Demo", Chat: "Leo Park", Request: "Draft a reply",
		Lines: []agentproto.AskLine{{Speaker: "Me", Own: true, Text: "hey"}, {Speaker: "Leo Park", Text: "Are we still on for the flight?"}}}
	if err := c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$b", Text: "Ask: flight", Ask: ask}); err != nil {
		t.Fatal(err)
	}
	e := fb.next()
	if e.Type != agentproto.EventDrafts || e.Drafts.TaskID != "tsk_1" {
		t.Fatalf("drafts: %+v", e)
	}
	want := []string{"Leo, sounds good, see you then!", "Leo, thanks! Let me check and get back to you.", "Leo, got it 👍"}
	for i, d := range e.Drafts.Drafts {
		if d.Text != want[i] {
			t.Fatalf("draft %d = %q, want %q", i, d.Text, want[i])
		}
	}
}

func TestDraftsFor(t *testing.T) {
	own := DraftsFor(&agentproto.Ask{Lines: []agentproto.AskLine{{Speaker: "Leo", Text: "x"}, {Speaker: "Me", Own: true}}})
	if own[0] != "Sounds good, see you then!" || own[2] != "Got it 👍" {
		t.Fatalf("own last line must not prefix: %q", own)
	}
	if none := DraftsFor(&agentproto.Ask{}); none[1] != "Thanks! Let me check and get back to you." {
		t.Fatalf("no lines: %q", none)
	}
	if p := DraftsFor(&agentproto.Ask{Lines: []agentproto.AskLine{{Speaker: "Person 2"}}}); p[0] != "Person 2, sounds good, see you then!" {
		t.Fatalf("person: %q", p)
	}
	if Drafts[0] != "Sounds good, see you then!" {
		t.Fatal("DraftsFor must not mutate Drafts")
	}
}

func TestSessionsAndErrors(t *testing.T) {
	fb, agentSrv, c, sid := setup(t)
	// Unknown session.
	err := c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: "nope", MessageID: "$x", Text: "hi"})
	if !agentproto.IsStatus(err, 404) {
		t.Fatalf("expected 404, got %v", err)
	}
	// Invalid ask.
	err = c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$x", Ask: &agentproto.Ask{}})
	if !agentproto.IsStatus(err, 400) {
		t.Fatalf("expected 400, got %v", err)
	}
	// Session creation needs a callback.
	if _, err = c.CreateSession(t.Context(), &agentproto.CreateSessionRequest{}); !agentproto.IsStatus(err, 400) {
		t.Fatalf("expected 400, got %v", err)
	}

	// Re-registering with the old id keeps it and switches to the new callback token.
	fb.token = "newtoken"
	sid2, err := c.CreateSession(t.Context(), &agentproto.CreateSessionRequest{
		CallbackURL: fb.url, CallbackToken: "newtoken", SessionID: sid,
	})
	if err != nil || sid2 != sid {
		t.Fatalf("resume: %v %q != %q", err, sid2, sid)
	}
	if err = c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$y", Text: "again"}); err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Message.Text != "You said: again" {
		t.Fatalf("after resume: %+v", e.Message)
	}
	// After a restart, a bridge re-registering an id the agent never saw gets it back too.
	if sid3, _ := c.CreateSession(t.Context(), &agentproto.CreateSessionRequest{
		CallbackURL: fb.url, CallbackToken: "newtoken", SessionID: "ses_restored",
	}); sid3 != "ses_restored" {
		t.Fatalf("restored id: %q", sid3)
	}

	if err = c.DeleteSession(t.Context(), sid); err != nil {
		t.Fatal(err)
	}
	err = c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$z", Text: "hi"})
	if !agentproto.IsStatus(err, 404) {
		t.Fatalf("expected 404 after delete, got %v", err)
	}
	// Mismatched header/body.
	body, _ := json.Marshal(agentproto.InboundMessage{SessionID: "ses_restored", MessageID: "$q"})
	req, _ := http.NewRequest("POST", agentSrv.URL+"/agentstudio/v0/messages", bytes.NewReader(body))
	req.Header.Set(agentproto.HeaderSession, "other")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 400 {
		t.Fatalf("expected 400 for mismatched session header, got %v %v", err, resp.StatusCode)
	}
	resp.Body.Close()
}

func TestRetriesOnServerError(t *testing.T) {
	fb, _ := newFakeBridge(t, "tok")
	fb.fail = 2
	a := New(Config{Delay: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	defer a.Close()
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	c := &agentproto.Client{BaseURL: srv.URL}
	sid, err := c.CreateSession(t.Context(), &agentproto.CreateSessionRequest{CallbackURL: fb.url, CallbackToken: "tok"})
	if err != nil {
		t.Fatal(err)
	}
	if err = c.SendMessage(t.Context(), &agentproto.InboundMessage{SessionID: sid, MessageID: "$r", Text: "retry"}); err != nil {
		t.Fatal(err)
	}
	if e := fb.next(); e.Message.Text != "You said: retry" {
		t.Fatalf("got %+v", e.Message)
	}
}
