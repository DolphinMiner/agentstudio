package demo

// Integration test against the running local stack (pnpm dev:up). Run with:
//
//	cd server && AGENTSTUDIO_IT=1 go test -tags nocrypto -run TestIntegration -v ./internal/bridges/demo/
//
// It reads secrets and URLs from the environment, falling back to <repo>/.local/env.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func loadStackEnv(t *testing.T) map[string]string {
	t.Helper()
	env := map[string]string{}
	dir, _ := os.Getwd()
	for ; dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		f, err := os.Open(filepath.Join(dir, ".local", "env"))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if k, v, ok := strings.Cut(line, "="); ok {
				env[k] = strings.Trim(v, `"'`)
			}
		}
		f.Close()
		break
	}
	for _, k := range []string{"SYNAPSE_URL", "SYNAPSE_JWT_SECRET", "DEMO_BRIDGE_URL", "DEMO_PROVISION_SECRET", "AGENTSTUDIO_INTERNAL_SECRET", "MATRIX_SERVER_NAME"} {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
		if env[k] == "" {
			t.Fatalf("%s is not set and not found in .local/env", k)
		}
	}
	return env
}

type itEnv struct {
	t   *testing.T
	env map[string]string
	ctx context.Context
}

// doJSON calls url with an optional JSON body and decodes a JSON response into out.
func (e *itEnv) doJSON(method, u, bearer string, body, out any) int {
	e.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequestWithContext(e.ctx, method, u, rd)
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, u, err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func (e *itEnv) provision(method, path string, user id.UserID, body, out any) {
	e.t.Helper()
	u := fmt.Sprintf("%s/_matrix/provision%s?user_id=%s", e.env["DEMO_BRIDGE_URL"], path, url.QueryEscape(string(user)))
	var raw json.RawMessage
	if status := e.doJSON(method, u, e.env["DEMO_PROVISION_SECRET"], body, &raw); status != http.StatusOK {
		e.t.Fatalf("%s %s: status %d: %s", method, path, status, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			e.t.Fatalf("decode %s: %v", path, err)
		}
	}
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

type itMessage struct {
	Sender id.UserID
	Body   string
	TS     int64
}

func roomMessages(t *testing.T, ctx context.Context, cli *mautrix.Client, roomID id.RoomID) []itMessage {
	t.Helper()
	resp, err := cli.Messages(ctx, roomID, "", "", mautrix.DirectionForward, nil, 100)
	if err != nil {
		t.Fatalf("messages in %s: %v", roomID, err)
	}
	var out []itMessage
	for _, evt := range resp.Chunk {
		if evt.Type != event.EventMessage {
			continue
		}
		var c struct {
			Body string `json:"body"`
		}
		_ = json.Unmarshal(evt.Content.VeryRaw, &c)
		out = append(out, itMessage{Sender: evt.Sender, Body: c.Body, TS: evt.Timestamp})
	}
	return out
}

func TestIntegration(t *testing.T) {
	if os.Getenv("AGENTSTUDIO_IT") != "1" {
		t.Skip("set AGENTSTUDIO_IT=1 to run against the local stack")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	e := &itEnv{t: t, env: loadStackEnv(t), ctx: ctx}
	server := e.env["MATRIX_SERVER_NAME"]

	// 1. A fresh Matrix user via Synapse JWT login.
	rb := make([]byte, 5)
	_, _ = rand.Read(rb)
	localpart := "it_demo_" + hex.EncodeToString(rb)
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": localpart, "exp": time.Now().Add(5 * time.Minute).Unix(),
	}).SignedString([]byte(e.env["SYNAPSE_JWT_SECRET"]))
	if err != nil {
		t.Fatal(err)
	}
	cli, err := mautrix.NewClient(e.env["SYNAPSE_URL"], "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = cli.Login(ctx, &mautrix.ReqLogin{Type: "org.matrix.login.jwt", Token: token, StoreCredentials: true}); err != nil {
		t.Fatalf("jwt login: %v", err)
	}
	mxid := cli.UserID
	t.Logf("test user %s", mxid)

	// 2. Provisioning: flows, start, submit display name.
	var flows struct {
		Flows []struct{ ID string } `json:"flows"`
	}
	e.provision(http.MethodGet, "/v3/login/flows", mxid, nil, &flows)
	if len(flows.Flows) != 1 || flows.Flows[0].ID != "demo" {
		t.Fatalf("unexpected flows: %+v", flows)
	}
	var start struct {
		LoginID   string `json:"login_id"`
		Type      string `json:"type"`
		StepID    string `json:"step_id"`
		UserInput struct {
			Fields []struct {
				ID, Type     string
				DefaultValue string `json:"default_value"`
			} `json:"fields"`
		} `json:"user_input"`
	}
	e.provision(http.MethodPost, "/v3/login/start/demo", mxid, map[string]any{}, &start)
	if start.Type != "user_input" || len(start.UserInput.Fields) != 1 || start.UserInput.Fields[0].ID != "display_name" ||
		start.UserInput.Fields[0].Type != "username" || start.UserInput.Fields[0].DefaultValue != "Demo User" {
		t.Fatalf("unexpected first step: %+v", start)
	}
	var done struct {
		Type     string `json:"type"`
		Complete struct {
			UserLoginID string `json:"user_login_id"`
		} `json:"complete"`
	}
	e.provision(http.MethodPost, fmt.Sprintf("/v3/login/step/%s/%s/user_input", start.LoginID, start.StepID), mxid,
		map[string]string{"display_name": "IT User"}, &done)
	if done.Type != "complete" || done.Complete.UserLoginID != string(LoginID(mxid)) {
		t.Fatalf("unexpected final step: %+v (want login %s)", done, LoginID(mxid))
	}

	// 3. Three invites from the bot or demo ghosts; join them all.
	invited := map[id.RoomID]bool{}
	since := ""
	waitFor(t, 30*time.Second, "3 invites", func() bool {
		resp, err := cli.SyncRequest(ctx, 1000, since, "", false, event.PresenceOffline)
		if err != nil {
			t.Fatalf("sync: %v", err)
		}
		since = resp.NextBatch
		for roomID, room := range resp.Rooms.Invite {
			for _, evt := range room.State.Events {
				if evt.Type != event.StateMember || evt.GetStateKey() != string(mxid) {
					continue
				}
				lp, hs, _ := evt.Sender.Parse()
				if hs != server || !(lp == "demobot" || strings.HasPrefix(lp, "demo_")) {
					t.Errorf("invite to %s from unexpected sender %s", roomID, evt.Sender)
				}
				invited[roomID] = true
			}
		}
		return len(invited) >= 3
	})
	if len(invited) != 3 {
		t.Fatalf("expected exactly 3 invites, got %d", len(invited))
	}
	rooms := map[string]id.RoomID{} // portal id -> room
	for roomID := range invited {
		if _, err := cli.JoinRoomByID(ctx, roomID); err != nil {
			t.Fatalf("join %s: %v", roomID, err)
		}
		state, err := cli.State(ctx, roomID)
		if err != nil {
			t.Fatalf("state %s: %v", roomID, err)
		}
		var found bool
		for _, evt := range state[event.StateBridge] {
			var info event.BridgeEventContent
			_ = json.Unmarshal(evt.Content.VeryRaw, &info)
			if info.Protocol.ID != "demo" {
				t.Errorf("room %s: m.bridge protocol.id = %q", roomID, info.Protocol.ID)
			}
			rooms[info.Channel.ID] = roomID
			found = true
		}
		if !found {
			t.Fatalf("room %s has no m.bridge state", roomID)
		}
	}
	for _, p := range []string{"mom", "leo", "bookclub"} {
		if rooms[p] == "" {
			t.Fatalf("no room for portal %s (rooms: %v)", p, rooms)
		}
	}
	var nameEvt struct {
		Name string `json:"name"`
	}
	if err := cli.StateEvent(ctx, rooms["bookclub"], event.StateRoomName, "", &nameEvt); err != nil || nameEvt.Name != "Book Club" {
		t.Errorf("bookclub name = %q, err %v", nameEvt.Name, err)
	}
	if err := cli.StateEvent(ctx, rooms["leo"], event.StateRoomName, "", &nameEvt); err != nil || nameEvt.Name != "Leo Park" {
		t.Errorf("leo room name = %q, err %v", nameEvt.Name, err)
	}

	// 4. Starting messages, in order, from the right ghosts, in the past.
	ghost := func(remote string) id.UserID { return id.NewUserID("demo_"+id.EncodeUserLocalpart(remote), server) }
	want := map[string][]itMessage{
		"mom":      {{Sender: ghost("mom"), Body: "Did you eat yet?"}},
		"leo":      {{Sender: ghost("leo"), Body: "Hey! Long time"}, {Sender: ghost("leo"), Body: "Are we still on for 7:15?"}},
		"bookclub": {{Sender: ghost("mia"), Body: "Chapter 4 tonight?"}, {Sender: ghost("+15550101"), Body: "I'm in"}},
	}
	for portal, msgs := range want {
		var got []itMessage
		waitFor(t, 15*time.Second, "starting messages in "+portal, func() bool {
			got = roomMessages(t, ctx, cli, rooms[portal])
			return len(got) >= len(msgs)
		})
		if len(got) != len(msgs) {
			t.Fatalf("%s: got %d messages, want %d: %+v", portal, len(got), len(msgs), got)
		}
		for i := range msgs {
			if got[i].Sender != msgs[i].Sender || got[i].Body != msgs[i].Body {
				t.Errorf("%s[%d] = %s %q, want %s %q", portal, i, got[i].Sender, got[i].Body, msgs[i].Sender, msgs[i].Body)
			}
			if age := time.Since(time.UnixMilli(got[i].TS)); age < time.Minute || age > time.Hour {
				t.Errorf("%s[%d] timestamp is %s old, want a few minutes", portal, i, age)
			}
			if i > 0 && got[i].TS <= got[i-1].TS {
				t.Errorf("%s[%d] timestamps not increasing", portal, i)
			}
		}
	}

	// 5. Outgoing text gets an echo from the first ghost.
	if _, err := cli.SendText(ctx, rooms["leo"], "hello"); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, 10*time.Second, "Echo: hello from leo", func() bool {
		return slices.ContainsFunc(roomMessages(t, ctx, cli, rooms["leo"]), func(m itMessage) bool {
			return m.Sender == ghost("leo") && m.Body == "Echo: hello"
		})
	})
	if _, err := cli.SendText(ctx, rooms["bookclub"], "see you"); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, 10*time.Second, "Echo from mia", func() bool {
		return slices.ContainsFunc(roomMessages(t, ctx, cli, rooms["bookclub"]), func(m itMessage) bool {
			return m.Sender == ghost("mia") && m.Body == "Echo: see you"
		})
	})

	// 6. Dev incoming hook: auth required, then the message shows up.
	hook := e.env["DEMO_BRIDGE_URL"] + DevIncomingPath
	body := map[string]string{"user_mxid": string(mxid), "portal": "bookclub", "sender": "+15550101", "text": "Running late"}
	if status := e.doJSON(http.MethodPost, hook, "wrong", body, nil); status != http.StatusUnauthorized {
		t.Errorf("hook with wrong secret: status %d, want 401", status)
	}
	bad := map[string]string{"user_mxid": string(mxid), "portal": "mom", "sender": "leo", "text": "x"}
	if status := e.doJSON(http.MethodPost, hook, e.env["AGENTSTUDIO_INTERNAL_SECRET"], bad, nil); status != http.StatusBadRequest {
		t.Errorf("hook with wrong sender: status %d, want 400", status)
	}
	other := map[string]string{"user_mxid": "@nobody_" + localpart + ":" + server, "portal": "mom", "sender": "mom", "text": "x"}
	if status := e.doJSON(http.MethodPost, hook, e.env["AGENTSTUDIO_INTERNAL_SECRET"], other, nil); status != http.StatusNotFound {
		t.Errorf("hook for unknown user: status %d, want 404", status)
	}
	var hookResp struct {
		MessageID string `json:"message_id"`
	}
	if status := e.doJSON(http.MethodPost, hook, e.env["AGENTSTUDIO_INTERNAL_SECRET"], body, &hookResp); status != http.StatusAccepted || hookResp.MessageID == "" {
		t.Fatalf("hook: status %d, resp %+v", status, hookResp)
	}
	waitFor(t, 10*time.Second, "incoming message from +15550101", func() bool {
		return slices.ContainsFunc(roomMessages(t, ctx, cli, rooms["bookclub"]), func(m itMessage) bool {
			return m.Sender == ghost("+15550101") && m.Body == "Running late"
		})
	})

	// 7. Media is rejected.
	_, err = cli.SendMessageEvent(ctx, rooms["mom"], event.EventMessage, &event.MessageEventContent{
		MsgType: event.MsgImage, Body: "cat.png", URL: "mxc://agentstudio.local/doesnotexist",
	})
	if err != nil {
		t.Fatalf("send image: %v", err)
	}
	waitFor(t, 10*time.Second, "media rejection notice", func() bool {
		return slices.ContainsFunc(roomMessages(t, ctx, cli, rooms["mom"]), func(m itMessage) bool {
			return strings.Contains(m.Body, "not") && (m.Sender == id.NewUserID("demobot", server) || strings.HasPrefix(string(m.Sender), "@demo_"))
		})
	})
}
