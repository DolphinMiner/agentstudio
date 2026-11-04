package adapterstest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/adapters/a2a"
	"github.com/DolphinMiner/agentstudio/server/internal/adapters/acp"
	"github.com/DolphinMiner/agentstudio/server/internal/agenthost"
	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// bridge is a fake agents bridge: it records callback events.
type bridge struct {
	srv    *httptest.Server
	mu     sync.Mutex
	events []agentproto.AgentEvent
}

func newBridge(t *testing.T) *bridge {
	b := &bridge{}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if agentproto.BearerToken(r) != "cb-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var evt agentproto.AgentEvent
		if err := json.NewDecoder(r.Body).Decode(&evt); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		b.mu.Lock()
		b.events = append(b.events, evt)
		b.mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(b.srv.Close)
	return b
}

// wait returns the first event matching fn, failing after a timeout.
func (b *bridge) wait(t *testing.T, what string, fn func(agentproto.AgentEvent) bool) agentproto.AgentEvent {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		for _, e := range b.events {
			if fn(e) {
				b.mu.Unlock()
				return e
			}
		}
		b.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	t.Fatalf("timed out waiting for %s; got %d events", what, len(b.events))
	return agentproto.AgentEvent{}
}

func isMessage(text string) func(agentproto.AgentEvent) bool {
	return func(e agentproto.AgentEvent) bool { return e.Message != nil && e.Message.Text == text }
}

// session creates a session against an adapter base URL and returns a client.
func session(t *testing.T, base string, b *bridge) (*agentproto.Client, string) {
	t.Helper()
	c := &agentproto.Client{BaseURL: base}
	info, err := c.Info(context.Background())
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if info.Name == "" {
		t.Fatal("empty agent name")
	}
	sid, err := c.CreateSession(context.Background(), &agentproto.CreateSessionRequest{
		CallbackURL: b.srv.URL, CallbackToken: "cb-token", User: agentproto.SessionUser{DisplayName: "Test"},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	return c, sid
}

func send(t *testing.T, c *agentproto.Client, sid, id, text string, ask *agentproto.Ask) {
	t.Helper()
	if err := c.SendMessage(context.Background(), &agentproto.InboundMessage{SessionID: sid, MessageID: id, Text: text, SentAt: time.Now().UTC().Format(time.RFC3339), Ask: ask}); err != nil {
		t.Fatalf("send %q: %v", text, err)
	}
}

func buildBinary(t *testing.T, pkg string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), filepath.Base(pkg))
	cmd := exec.Command("go", "build", "-tags", "nocrypto", "-o", out, pkg)
	cmd.Dir = filepath.Join("..", "..", "..")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", pkg, err, b)
	}
	return out
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l := httptest.NewServer(http.NotFoundHandler())
	addr := strings.TrimPrefix(l.URL, "http://")
	l.Close()
	return addr
}

func waitHTTP(t *testing.T, url string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never came up", url)
}

var ask = &agentproto.Ask{TaskID: "tsk_1", App: "Demo", Chat: "Leo Park", Request: "Draft a reply",
	Lines: []agentproto.AskLine{{Speaker: "Leo Park", Text: "Dinner at 7?"}}}

func TestA2A(t *testing.T) {
	// The dev echo agent is the reference A2A peer for e2e; test against it.
	addr := freeAddr(t)
	cmd := exec.Command(buildBinary(t, "./cmd/agentstudio-dev-a2a-echo"))
	cmd.Env = append(os.Environ(), "A2A_ECHO_ADDR="+addr)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	waitHTTP(t, "http://"+addr+"/health")

	mux := http.NewServeMux()
	backend := a2a.New()
	backend.PollInterval = 50 * time.Millisecond
	host := agenthost.New(backend, agenthost.Options{})
	t.Cleanup(host.Close)
	host.Register(mux, "/a2a/{target}")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	b := newBridge(t)
	c, sid := session(t, srv.URL+"/a2a/"+a2a.EncodeTarget("http://"+addr), b)

	send(t, c, sid, "m1", "hello", nil)
	b.wait(t, "echo", isMessage("A2A echo: hello"))

	send(t, c, sid, "m2", "slow job", nil)
	b.wait(t, "working status", func(e agentproto.AgentEvent) bool {
		return e.Status != nil && e.Status.State == agentproto.StateWorking
	})
	b.wait(t, "artifact text", isMessage("Done: slow job"))

	send(t, c, sid, "m3", "book a table", nil)
	ar := b.wait(t, "approval", func(e agentproto.AgentEvent) bool { return e.ApprovalRequest != nil })
	if ar.ApprovalRequest.Title != "Book the table at Nopa for 7:30?" || len(ar.ApprovalRequest.Choices) != 2 {
		t.Fatalf("unexpected approval: %+v", ar.ApprovalRequest)
	}
	if err := c.SendDecision(context.Background(), sid, ar.ApprovalRequest.ExternalID, &agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "book"}); err != nil {
		t.Fatalf("decision: %v", err)
	}
	b.wait(t, "booked", isMessage("Table booked."))
	if err := c.SendDecision(context.Background(), sid, ar.ApprovalRequest.ExternalID, &agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "book"}); err == nil {
		t.Fatal("a second decision on the same approval should be rejected")
	}

	send(t, c, sid, "m4", "", ask)
	d := b.wait(t, "drafts", func(e agentproto.AgentEvent) bool { return e.Drafts != nil })
	if d.Drafts.TaskID != "tsk_1" || len(d.Drafts.Drafts) != 3 || d.Drafts.Drafts[0].Text != "Sounds great!" {
		t.Fatalf("unexpected drafts: %+v", d.Drafts)
	}
}

func TestACP(t *testing.T) {
	bin := buildBinary(t, "./cmd/agentstudio-dev-acp-echo")
	backend := acp.New([]acp.AgentSpec{{ID: "echo", Name: "ACP Echo", Command: bin}}, t.TempDir(), nil)
	host := agenthost.New(backend, agenthost.Options{})
	t.Cleanup(host.Close)
	mux := http.NewServeMux()
	host.Register(mux, "/acp/{agent}")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	b := newBridge(t)
	c, sid := session(t, srv.URL+"/acp/echo", b)

	send(t, c, sid, "m1", "héllo wörld", nil)
	b.wait(t, "echo", isMessage("ACP echo: héllo wörld"))

	send(t, c, sid, "m2", "please delete notes", nil)
	ar := b.wait(t, "permission", func(e agentproto.AgentEvent) bool { return e.ApprovalRequest != nil })
	if ar.ApprovalRequest.Title != "Delete notes.txt" || ar.ApprovalRequest.Choices[0].Key != "allow" ||
		ar.ApprovalRequest.Choices[1].Category != agentproto.CategoryDeny {
		t.Fatalf("unexpected approval: %+v", ar.ApprovalRequest)
	}
	if err := c.SendDecision(context.Background(), sid, ar.ApprovalRequest.ExternalID, &agentproto.DecisionRequest{ApprovalID: "apr_1", Choice: "reject"}); err != nil {
		t.Fatalf("decision: %v", err)
	}
	b.wait(t, "left alone", isMessage("Okay, I left it alone."))

	send(t, c, sid, "m3", "", ask)
	d := b.wait(t, "drafts", func(e agentproto.AgentEvent) bool { return e.Drafts != nil })
	if len(d.Drafts.Drafts) != 3 || d.Drafts.Drafts[2].Text != "Let's talk tomorrow." {
		t.Fatalf("unexpected drafts: %+v", d.Drafts)
	}

	if _, err := (&agentproto.Client{BaseURL: srv.URL + "/acp/nope"}).Info(context.Background()); err == nil {
		t.Fatal("an unknown ACP agent must not resolve")
	}
}

func TestParseDrafts(t *testing.T) {
	got := agenthost.ParseDrafts("Here you go:\n1. One\n2) \"Two\"\n- Three")
	if strings.Join(got, "|") != "One|Two|Three" {
		t.Fatalf("got %q", got)
	}
	if got := agenthost.ParseDrafts("Just this."); len(got) != 1 || got[0] != "Just this." {
		t.Fatalf("got %q", got)
	}
}
