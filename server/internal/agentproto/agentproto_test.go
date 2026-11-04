package agentproto

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func validApproval() ApprovalRequestEvent {
	return ApprovalRequestEvent{
		ExternalID: "flight-1",
		Title:      "Book it?",
		Details:    []Detail{{Label: "Date", Value: "Friday"}},
		Choices: []Choice{
			{Key: "book", Label: "Book", Category: CategoryApprove},
			{Key: "skip", Label: "Don't book", Category: CategoryDeny},
		},
		ExpiresInSeconds: 2700,
	}
}

func TestEventRoundTrip(t *testing.T) {
	events := []AgentEvent{
		NewMessage("hello"),
		{Type: EventMessage, Message: &MessageEvent{Text: "hi", ReplyTo: "$evt"}},
		NewDrafts("tsk_1", "a", "b"),
		NewApprovalRequest(validApproval()),
		NewApprovalCancel("flight-1"),
		NewStatus(StateWorking, "Searching flights"),
	}
	for _, e := range events {
		data, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal %s: %v", e.Type, err)
		}
		var flat map[string]any
		_ = json.Unmarshal(data, &flat)
		if flat["type"] != string(e.Type) {
			t.Fatalf("type not flattened: %s", data)
		}
		var back AgentEvent
		if err = json.Unmarshal(data, &back); err != nil {
			t.Fatalf("unmarshal %s: %v", data, err)
		}
		if err = back.Validate(); err != nil {
			t.Fatalf("validate %s: %v", data, err)
		}
		again, _ := json.Marshal(back)
		if string(again) != string(data) {
			t.Fatalf("round trip mismatch:\n%s\n%s", data, again)
		}
	}
}

func TestEventWireFormat(t *testing.T) {
	data, _ := json.Marshal(NewStatus(StateIdle, ""))
	if string(data) != `{"state":"idle","type":"status"}` {
		t.Fatalf("unexpected wire format %s", data)
	}
	var e AgentEvent
	err := json.Unmarshal([]byte(`{"type":"drafts","task_id":"t","drafts":[{"text":"x"}],"text":"lead"}`), &e)
	if err != nil || e.Drafts == nil || e.Drafts.Text != "lead" || e.Drafts.Drafts[0].Text != "x" {
		t.Fatalf("bad decode: %v %+v", err, e.Drafts)
	}
}

func TestEventValidation(t *testing.T) {
	tooMany := make([]string, 6)
	for i := range tooMany {
		tooMany[i] = "d"
	}
	noDeny := validApproval()
	noDeny.Choices[1].Category = CategoryApprove
	dupKey := validApproval()
	dupKey.Choices[1].Key = "book"
	oneChoice := validApproval()
	oneChoice.Choices = oneChoice.Choices[:1]
	badCat := validApproval()
	badCat.Choices[0].Category = "maybe"
	noTitle := validApproval()
	noTitle.Title = ""
	negExp := validApproval()
	negExp.ExpiresInSeconds = -1

	bad := map[string]AgentEvent{
		"empty message":   NewMessage(""),
		"huge message":    NewMessage(strings.Repeat("x", MaxTextLength+1)),
		"no drafts":       NewDrafts("t"),
		"too many drafts": NewDrafts("t", tooMany...),
		"empty draft":     NewDrafts("t", ""),
		"drafts no task":  NewDrafts("", "a"),
		"no deny":         NewApprovalRequest(noDeny),
		"dup key":         NewApprovalRequest(dupKey),
		"one choice":      NewApprovalRequest(oneChoice),
		"bad category":    NewApprovalRequest(badCat),
		"no title":        NewApprovalRequest(noTitle),
		"negative expiry": NewApprovalRequest(negExp),
		"cancel no id":    NewApprovalCancel(""),
		"bad state":       NewStatus("sleeping", ""),
		"nil payload":     {Type: EventMessage},
		"unknown type":    {Type: "nope"},
	}
	for name, e := range bad {
		if err := e.Validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
	for _, raw := range []string{`{}`, `{"type":"bogus"}`, `{"type":"message","text":5}`} {
		var e AgentEvent
		if err := json.Unmarshal([]byte(raw), &e); err == nil {
			t.Errorf("expected unmarshal error for %s", raw)
		}
	}
}

func TestAskValidation(t *testing.T) {
	ok := Ask{TaskID: "t", Lines: []AskLine{{Speaker: "Leo", Text: "hi"}}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	long := ok
	long.Lines = []AskLine{{Text: strings.Repeat("é", MaxAskLineText+1)}}
	many := ok
	many.Lines = make([]AskLine, MaxAskLines+1)
	for _, a := range []Ask{{}, long, many} {
		if err := a.Validate(); err == nil {
			t.Errorf("expected error for %+v", len(a.Lines))
		}
	}
}

func TestClient(t *testing.T) {
	var gotAuth, gotSession string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /agentstudio/v0/info", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		WriteJSON(w, 200, AgentInfo{Name: "X", Capabilities: []Capability{CapabilityChat}, Protocol: ProtocolVersion})
	})
	mux.HandleFunc("POST /agentstudio/v0/sessions", func(w http.ResponseWriter, r *http.Request) {
		var req CreateSessionRequest
		_ = ReadJSON(r, 1<<20, &req)
		WriteJSON(w, 200, CreateSessionResponse{SessionID: "s-" + req.User.DisplayName})
	})
	mux.HandleFunc("POST /agentstudio/v0/messages", func(w http.ResponseWriter, r *http.Request) {
		gotSession = r.Header.Get(HeaderSession)
		if gotSession == "gone" {
			WriteError(w, 404, "not_found", "no session")
			return
		}
		WriteJSON(w, 202, map[string]any{})
	})
	mux.HandleFunc("POST /agentstudio/v0/approvals/{id}/decision", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "a b" {
			w.WriteHeader(400)
			return
		}
		WriteJSON(w, 200, map[string]any{})
	})
	mux.HandleFunc("DELETE /agentstudio/v0/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	base, err := NormalizeBaseURL(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{BaseURL: base, Token: "tok"}
	ctx := context.Background()
	info, err := c.Info(ctx)
	if err != nil || info.Name != "X" || gotAuth != "Bearer tok" {
		t.Fatalf("info: %v %+v %q", err, info, gotAuth)
	}
	sid, err := c.CreateSession(ctx, &CreateSessionRequest{User: SessionUser{DisplayName: "u"}})
	if err != nil || sid != "s-u" {
		t.Fatalf("session: %v %q", err, sid)
	}
	if err = c.SendMessage(ctx, &InboundMessage{SessionID: "s1", MessageID: "$m"}); err != nil || gotSession != "s1" {
		t.Fatalf("message: %v %q", err, gotSession)
	}
	err = c.SendMessage(ctx, &InboundMessage{SessionID: "gone", MessageID: "$m"})
	if !errors.Is(err, ErrSessionNotFound) || !IsStatus(err, 404) {
		t.Fatalf("expected ErrSessionNotFound, got %v", err)
	}
	if err = c.SendDecision(ctx, "s1", "a b", &DecisionRequest{ApprovalID: "apr", Choice: "book"}); err != nil {
		t.Fatalf("decision: %v", err)
	}
	if err = c.DeleteSession(ctx, "s1"); err != nil {
		t.Fatalf("delete should treat 404 as success: %v", err)
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	for _, bad := range []string{"", "ftp://x", "/relative", "http://", "http://x/?q=1", "http://u:p@x"} {
		if _, err := NormalizeBaseURL(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
	if got, _ := NormalizeBaseURL(" https://agent.example/api// "); got != "https://agent.example/api" {
		t.Errorf("got %q", got)
	}
}

func TestCallbackClientAndTokens(t *testing.T) {
	hash := HashToken("secret")
	var got AgentEvent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cb/k/events" || !TokenMatches(BearerToken(r), hash[:]) {
			w.WriteHeader(401)
			return
		}
		_ = ReadJSON(r, MaxEventBodySize, &got)
		WriteJSON(w, 200, map[string]bool{"ok": true})
	}))
	defer srv.Close()
	cc := &CallbackClient{URL: srv.URL + "/cb/k", Token: "secret"}
	if err := cc.Send(context.Background(), NewMessage("hi")); err != nil || got.Message.Text != "hi" {
		t.Fatalf("send: %v", err)
	}
	cc.Token = "wrong"
	if err := cc.Send(context.Background(), NewMessage("hi")); !IsStatus(err, 401) {
		t.Fatalf("expected 401, got %v", err)
	}
	if err := cc.Send(context.Background(), NewMessage("")); err == nil {
		t.Fatal("invalid events must not be sent")
	}
	if TokenMatches("", hash[:]) || !SecretMatches("a", "a") || SecretMatches("", "") || SecretMatches("a", "b") {
		t.Fatal("token helpers misbehave")
	}
}
