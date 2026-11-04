package demo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
)

func TestLoginID(t *testing.T) {
	got := LoginID("@alice:agentstudio.local")
	if !regexp.MustCompile(`^demo-[0-9a-f]{12}$`).MatchString(string(got)) {
		t.Fatalf("LoginID = %q", got)
	}
	// printf '%s' '@alice:agentstudio.local' | shasum -a 256 | cut -c1-12
	if got != "demo-539ec770748b" {
		t.Fatalf("LoginID = %q, want demo-539ec770748b", got)
	}
	if got == LoginID("@bob:agentstudio.local") {
		t.Fatal("LoginID collides across users")
	}
}

func TestPortalDefsMatchDocs(t *testing.T) {
	want := map[networkid.PortalID][]string{
		"mom":      {"mom: Did you eat yet?"},
		"leo":      {"leo: Hey! Long time", "leo: Are we still on for 7:15?"},
		"bookclub": {"mia: Chapter 4 tonight?", "+15550101: I'm in"},
	}
	for id, msgs := range want {
		def := getPortal(id)
		if def == nil {
			t.Fatalf("missing portal %s", id)
		}
		if len(def.Messages) != len(msgs) {
			t.Fatalf("%s: %d messages", id, len(def.Messages))
		}
		for i, m := range def.Messages {
			if got := string(m.Sender) + ": " + m.Text; got != msgs[i] {
				t.Errorf("%s[%d] = %q, want %q", id, i, got, msgs[i])
			}
			if !def.hasMember(m.Sender) {
				t.Errorf("%s: sender %s not a member", id, m.Sender)
			}
		}
	}
	if contacts["+15550101"].Name != "+1 555 0101" || contacts["leo"].Name != "Leo Park" || contacts["mia"].Name != "Mia Chen" {
		t.Error("contact names do not match docs")
	}
	if getPortal("bookclub").Members[0] != "mia" || getPortal("bookclub").Name != "Book Club" {
		t.Error("Mia must be the first Book Club ghost")
	}
}

func testClient(loginAt time.Time) *Client {
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{
		ID:       "demo-000000000000",
		Metadata: &UserLoginMetadata{DisplayName: "T", LoginAt: loginAt.UnixMilli()},
	}}
	return &Client{conn: NewConnector(), login: login}
}

func testPortal(id networkid.PortalID) *bridgev2.Portal {
	return &bridgev2.Portal{Portal: &database.Portal{PortalKey: networkid.PortalKey{ID: id, Receiver: "demo-000000000000"}}}
}

func TestFetchMessages(t *testing.T) {
	loginAt := time.Now()
	c := testClient(loginAt)
	resp, err := c.FetchMessages(context.Background(), bridgev2.FetchMessagesParams{Portal: testPortal("leo"), Forward: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Messages) != 2 || resp.HasMore {
		t.Fatalf("got %d messages, has_more %v", len(resp.Messages), resp.HasMore)
	}
	prev := time.Time{}
	for i, m := range resp.Messages {
		if !m.Timestamp.After(prev) || !m.Timestamp.Before(loginAt) || loginAt.Sub(m.Timestamp) > time.Hour {
			t.Errorf("message %d has bad timestamp %s", i, m.Timestamp)
		}
		prev = m.Timestamp
		if m.Sender.Sender != "leo" || m.Parts[0].Content.MsgType != event.MsgText {
			t.Errorf("message %d: %+v", i, m)
		}
	}
	if resp.Messages[0].ID == resp.Messages[1].ID {
		t.Error("message IDs must be unique")
	}
	// Only the first forward backfill of an empty room returns messages.
	resp, _ = c.FetchMessages(context.Background(), bridgev2.FetchMessagesParams{
		Portal: testPortal("leo"), Forward: true, AnchorMessage: &database.Message{ID: "leo-start-1"},
	})
	if len(resp.Messages) != 0 {
		t.Error("catch-up backfill should be empty")
	}
	resp, _ = c.FetchMessages(context.Background(), bridgev2.FetchMessagesParams{Portal: testPortal("leo")})
	if len(resp.Messages) != 0 || resp.HasMore {
		t.Error("backward backfill should be empty")
	}
}

func TestHandleMatrixMessageRejectsMedia(t *testing.T) {
	c := testClient(time.Now())
	msg := &bridgev2.MatrixMessage{}
	msg.Portal = testPortal("mom")
	msg.Content = &event.MessageEventContent{MsgType: event.MsgImage, Body: "cat.png"}
	if _, err := c.HandleMatrixMessage(context.Background(), msg); err == nil || !strings.Contains(err.Error(), "only supports text") {
		t.Fatalf("err = %v", err)
	}
}

func TestDevHookValidation(t *testing.T) {
	conn := NewConnector()
	mux := http.NewServeMux()
	conn.RegisterDevRoutes(mux, "s3cret")
	cases := []struct {
		name, auth, body string
		want             int
	}{
		{"no auth", "", `{}`, 401},
		{"wrong auth", "Bearer nope", `{}`, 401},
		{"bad json", "Bearer s3cret", `{`, 400},
		{"no user", "Bearer s3cret", `{"portal":"mom","sender":"mom","text":"x"}`, 400},
		{"bad portal", "Bearer s3cret", `{"user_mxid":"@a:b","portal":"x","sender":"mom","text":"x"}`, 400},
		{"sender not in portal", "Bearer s3cret", `{"user_mxid":"@a:b","portal":"mom","sender":"leo","text":"x"}`, 400},
		{"empty text", "Bearer s3cret", `{"user_mxid":"@a:b","portal":"bookclub","sender":"+15550101","text":"  "}`, 400},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, DevIncomingPath, strings.NewReader(tc.body))
		if tc.auth != "" {
			req.Header.Set("Authorization", tc.auth)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body)
		}
	}
	// An empty secret never registers the route.
	empty := http.NewServeMux()
	conn.RegisterDevRoutes(empty, "")
	rec := httptest.NewRecorder()
	empty.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, DevIncomingPath, strings.NewReader(`{}`)))
	if rec.Code != http.StatusNotFound {
		t.Errorf("route registered with empty secret: %d", rec.Code)
	}
}
