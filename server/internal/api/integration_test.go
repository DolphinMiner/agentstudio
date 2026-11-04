package api

// Integration tests against the running dev stack (Postgres and Synapse).
// Bridges are faked with httptest servers that speak the bridgev2
// provisioning API, so these tests do not depend on the real bridges.
//
// Run: set -a; . ../.local/env; set +a; AGENTSTUDIO_IT=1 go test -tags nocrypto ./internal/api/ -run IT -v

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type fakeBridge struct {
	t      *testing.T
	secret string
	srv    *httptest.Server

	mu         sync.Mutex
	logouts    []string
	decisions  []map[string]string
	qrRelease  chan struct{}
	internalSK string
}

func newFakeBridge(t *testing.T, secret, internalSecret string) *fakeBridge {
	fb := &fakeBridge{t: t, secret: secret, internalSK: internalSecret, qrRelease: make(chan struct{})}
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+fb.secret || r.URL.Query().Get("user_id") == "" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"errcode":"M_UNKNOWN_TOKEN","error":"Invalid auth token"}`))
				return
			}
			h(w, r)
		}
	}
	js := func(w http.ResponseWriter, s string) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(s))
	}
	mux.HandleFunc("GET /_matrix/mau/live", func(w http.ResponseWriter, r *http.Request) { js(w, `{}`) })
	mux.HandleFunc("GET /_matrix/provision/v3/login/flows", auth(func(w http.ResponseWriter, r *http.Request) {
		js(w, `{"flows":[{"id":"demo","name":"Demo","description":"Simulated"},{"id":"qr","name":"QR","description":"Scan"}]}`)
	}))
	mux.HandleFunc("POST /_matrix/provision/v3/login/start/{flow}", auth(func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("flow") {
		case "demo":
			js(w, `{"login_id":"L1","type":"user_input","step_id":"demo.name","txn_id":"bls_1","instructions":"Pick a name",
				"user_input":{"fields":[{"type":"username","id":"display_name","name":"Display name","description":"","default_value":"Demo User"}]}}`)
		case "qr":
			js(w, `{"login_id":"L2","type":"display_and_wait","step_id":"qr.scan","txn_id":"bls_2","instructions":"Scan",
				"display_and_wait":{"type":"qr","data":"agentstudio:qr"}}`)
		default:
			w.WriteHeader(404)
			js(w, `{"errcode":"M_NOT_FOUND","error":"Unknown flow"}`)
		}
	}))
	mux.HandleFunc("POST /_matrix/provision/v3/login/step/L1/demo.name/user_input", auth(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["display_name"] == "" {
			w.WriteHeader(400)
			js(w, `{"errcode":"M_BAD_JSON","error":"display_name is required"}`)
			return
		}
		js(w, `{"login_id":"L1","type":"complete","step_id":"demo.complete","txn_id":"bls_3","instructions":"Done",
			"complete":{"user_login_id":"demo-abc"}}`)
	}))
	mux.HandleFunc("POST /_matrix/provision/v3/login/step/L2/qr.scan/display_and_wait", auth(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-fb.qrRelease:
			js(w, `{"login_id":"L2","type":"complete","step_id":"qr.complete","txn_id":"bls_4","instructions":"",
				"complete":{"user_login_id":"qr-login"}}`)
		case <-r.Context().Done():
		}
	}))
	mux.HandleFunc("POST /_matrix/provision/v3/logout/{id}", auth(func(w http.ResponseWriter, r *http.Request) {
		fb.mu.Lock()
		fb.logouts = append(fb.logouts, r.PathValue("id"))
		fb.mu.Unlock()
		js(w, `{}`)
	}))
	mux.HandleFunc("POST /agentstudio/internal/v1/approval-decisions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fb.internalSK {
			w.WriteHeader(401)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		fb.mu.Lock()
		fb.decisions = append(fb.decisions, body)
		fb.mu.Unlock()
		js(w, `{}`)
	})
	fb.srv = httptest.NewServer(mux)
	t.Cleanup(fb.srv.Close)
	return fb
}

type itEnv struct {
	t       *testing.T
	cfg     *Config
	srv     *Server
	base    string
	demo    *fakeBridge
	agents  *fakeBridge
	asToken string
}

func setupIT(t *testing.T) *itEnv {
	if os.Getenv("AGENTSTUDIO_IT") != "1" {
		t.Skip("set AGENTSTUDIO_IT=1 (and load .local/env) to run integration tests")
	}
	ctx := context.Background()
	adminURL := os.Getenv("AGENTSTUDIO_DATABASE_URL")
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	dbName := "agentstudio_it_" + strings.TrimPrefix(newID("x"), "x_")
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+dbName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+dbName+" WITH (FORCE)")
		admin.Close(context.Background())
	})
	u, _ := url.Parse(adminURL)
	u.Path = "/" + dbName
	pool, err := NewPool(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.New(slog.NewJSONHandler(os.Stderr, nil))
	}
	if err := Migrate(ctx, pool, log); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log); err != nil { // idempotent
		t.Fatal(err)
	}

	internal := "internal-" + newSecretToken()
	env := &itEnv{t: t, asToken: "as-" + newSecretToken()}
	env.demo = newFakeBridge(t, "demo-prov-secret-0123456789", internal)
	env.agents = newFakeBridge(t, "agents-prov-secret-0123456789", internal)
	cfg := &Config{
		DatabaseURL:    u.String(),
		SynapseURL:     strings.TrimRight(os.Getenv("SYNAPSE_URL"), "/"),
		ServerName:     "agentstudio.local",
		Dev:            true,
		TokenSecret:    []byte("token-" + newSecretToken()),
		InternalSecret: internal,
		SynapseJWT:     []byte(os.Getenv("SYNAPSE_JWT_SECRET")),
		Bridges: []BridgeConfig{
			{ID: "demo", Name: "Demo", Kind: "chat", BotMXID: "@demobot:agentstudio.local", ProvisionURL: env.demo.srv.URL, ProvisionSecret: env.demo.secret, ASToken: env.asToken},
			{ID: "agentstudio-agents", Name: "Agents", Kind: "agent", BotMXID: "@agentsbot:agentstudio.local", ProvisionURL: env.agents.srv.URL, ProvisionSecret: env.agents.secret, ASToken: "agents-as"},
			{ID: "dead", Name: "Dead", Kind: "chat", BotMXID: "@deadbot:agentstudio.local", ProvisionURL: "http://127.0.0.1:1", ProvisionSecret: "x"},
		},
	}
	env.cfg = cfg
	env.srv = New(cfg, pool, log)
	ts := httptest.NewServer(env.srv.Handler())
	t.Cleanup(ts.Close)
	env.base = ts.URL
	cfg.ServerURL = ts.URL
	return env
}

// call does a JSON request and decodes the response into a map.
func (e *itEnv) call(method, path, token string, body any, hdr ...string) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.base+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func (e *itEnv) must(want int, method, path, token string, body any) map[string]any {
	e.t.Helper()
	got, out := e.call(method, path, token, body)
	if got != want {
		e.t.Fatalf("%s %s: status %d, want %d: %v", method, path, got, want, out)
	}
	return out
}

func (e *itEnv) signIn(email string) map[string]any {
	e.t.Helper()
	e.must(204, "POST", "/v1/auth/email/start", "", map[string]string{"email": email})
	out := e.must(200, "GET", "/v1/dev/outbox?email="+url.QueryEscape(email), "", nil)
	msgs := out["messages"].([]any)
	code := msgs[0].(map[string]any)["code"].(string)
	return e.must(200, "POST", "/v1/auth/email/verify", "", map[string]string{"email": email, "code": code, "device_name": "IT test"})
}

func str(m map[string]any, path ...string) string {
	var cur any = m
	for _, p := range path {
		cur = cur.(map[string]any)[p]
	}
	s, _ := cur.(string)
	return s
}

func TestITAuthAndMatrix(t *testing.T) {
	e := setupIT(t)
	email := fmt.Sprintf("it-%s@Example.com", strings.TrimPrefix(newID("x"), "x_"))
	lower := strings.ToLower(email)

	e.must(204, "POST", "/v1/auth/email/start", "", map[string]string{"email": email})
	if c, out := e.call("POST", "/v1/auth/email/start", "", map[string]string{"email": email}); c != 429 || str(out, "error", "code") != "rate_limited" {
		t.Fatalf("resend throttle: %d %v", c, out)
	}
	if c, _ := e.call("POST", "/v1/auth/email/start", "", map[string]string{"email": "nope"}); c != 400 {
		t.Fatalf("bad email: %d", c)
	}
	out := e.must(200, "GET", "/v1/dev/outbox?email="+url.QueryEscape(email), "", nil)
	code := out["messages"].([]any)[0].(map[string]any)["code"].(string)
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}
	if c, out := e.call("POST", "/v1/auth/email/verify", "", map[string]string{"email": email, "code": wrong}); c != 422 || str(out, "error", "code") != "invalid_code" {
		t.Fatalf("wrong code: %d %v", c, out)
	}
	sess := e.must(200, "POST", "/v1/auth/email/verify", "", map[string]string{"email": email, "code": code, "device_name": "IT laptop"})
	if c, _ := e.call("POST", "/v1/auth/email/verify", "", map[string]string{"email": email, "code": code}); c != 422 {
		t.Fatal("code reused")
	}
	userID := str(sess, "user", "id")
	mxid := str(sess, "matrix", "user_id")
	if str(sess, "user", "email") != lower || mxid != "@u_"+userID+":agentstudio.local" || str(sess, "user", "matrix_user_id") != mxid {
		t.Fatalf("session user: %v", sess)
	}
	if str(sess, "matrix", "homeserver_url") != e.base || !strings.HasPrefix(str(sess, "matrix", "device_id"), "AGENTSTUDIO_") {
		t.Fatalf("session matrix: %v", sess["matrix"])
	}
	access := str(sess, "access_token")
	me := e.must(200, "GET", "/v1/me", access, nil)
	if str(me, "user", "id") != userID {
		t.Fatalf("me: %v", me)
	}
	if c, _ := e.call("GET", "/v1/me", "", nil); c != 401 {
		t.Fatal("me without token")
	}

	// Matrix through the proxy.
	mtok := str(sess, "matrix", "access_token")
	who := e.must(200, "GET", "/_matrix/client/v3/account/whoami", mtok, nil)
	if who["user_id"] != mxid || who["device_id"] != str(sess, "matrix", "device_id") {
		t.Fatalf("whoami: %v", who)
	}
	prof := e.must(200, "GET", "/_matrix/client/v3/profile/"+url.PathEscape(mxid)+"/displayname", mtok, nil)
	if prof["displayname"] != strings.Split(lower, "@")[0] {
		t.Fatalf("displayname: %v", prof)
	}

	// Second sign-in: same user, new device, display name untouched.
	sess2 := e.signIn(email)
	if str(sess2, "user", "id") != userID || str(sess2, "matrix", "device_id") == str(sess, "matrix", "device_id") {
		t.Fatalf("second session: %v", sess2)
	}

	// Refresh rotation and reuse detection.
	r1 := str(sess, "refresh_token")
	ref := e.must(200, "POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": r1})
	r2 := str(ref, "refresh_token")
	if r2 == r1 || str(ref, "session_id") != str(sess, "session_id") || str(ref, "matrix", "access_token") != mtok {
		t.Fatalf("refresh: %v", ref)
	}
	e.must(200, "GET", "/v1/me", str(ref, "access_token"), nil)
	if c, _ := e.call("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": r1}); c != 401 {
		t.Fatal("reused refresh token accepted")
	}
	// Reuse revoked the session: the new tokens are dead and the Matrix device is gone.
	if c, _ := e.call("GET", "/v1/me", str(ref, "access_token"), nil); c != 401 {
		t.Fatal("session not revoked after reuse")
	}
	if c, _ := e.call("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": r2}); c != 401 {
		t.Fatal("rotated token of revoked session accepted")
	}
	if c, _ := e.call("GET", "/_matrix/client/v3/account/whoami", mtok, nil); c != 401 {
		t.Fatal("matrix token alive after revoke")
	}

	// Logout of the second session.
	a2 := str(sess2, "access_token")
	e.must(204, "POST", "/v1/auth/logout", a2, nil)
	if c, _ := e.call("GET", "/v1/me", a2, nil); c != 401 {
		t.Fatal("access token alive after logout")
	}
	if c, _ := e.call("GET", "/_matrix/client/v3/account/whoami", str(sess2, "matrix", "access_token"), nil); c != 401 {
		t.Fatal("matrix token alive after logout")
	}

	// Max attempts: 5 wrong codes kill the code.
	e.must(204, "POST", "/v1/auth/email/start", "", map[string]string{"email": "max-" + lower})
	out = e.must(200, "GET", "/v1/dev/outbox?email="+url.QueryEscape("max-"+lower), "", nil)
	good := out["messages"].([]any)[0].(map[string]any)["code"].(string)
	for range codeMaxTries {
		e.call("POST", "/v1/auth/email/verify", "", map[string]string{"email": "max-" + lower, "code": wrong})
	}
	if c, _ := e.call("POST", "/v1/auth/email/verify", "", map[string]string{"email": "max-" + lower, "code": good}); c != 422 {
		t.Fatal("code accepted after max attempts")
	}
}

func TestITHealthCORSAndInternalAuth(t *testing.T) {
	e := setupIT(t)
	h := e.must(200, "GET", "/v1/health", "", nil)
	br := h["bridges"].(map[string]any)
	if h["synapse"] != true || br["demo"] != true || br["dead"] != false {
		t.Fatalf("health: %v", h)
	}
	resp := func(method, path, origin string) *http.Response {
		req, _ := http.NewRequest(method, e.base+path, nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r
	}
	for _, p := range []string{"/v1/auth/email/start", "/_matrix/client/v3/sync"} {
		r := resp("OPTIONS", p, "http://localhost:5173")
		if r.StatusCode != 204 || r.Header.Get("Access-Control-Allow-Origin") != "http://localhost:5173" ||
			!strings.Contains(r.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
			t.Fatalf("preflight %s: %d %v", p, r.StatusCode, r.Header)
		}
	}
	if r := resp("OPTIONS", "/v1/me", "null"); r.Header.Get("Access-Control-Allow-Origin") != "null" {
		t.Fatal("null origin")
	}
	if r := resp("OPTIONS", "/v1/me", "https://evil.example"); r.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("evil origin allowed")
	}
	if r := resp("OPTIONS", "/internal/v1/agents", "http://localhost:5173"); r.Header.Get("Access-Control-Allow-Origin") != "" || r.StatusCode == 204 {
		t.Fatalf("internal preflight: %d", r.StatusCode)
	}
	// Proxied responses carry exactly one ACAO header.
	req, _ := http.NewRequest("GET", e.base+"/_matrix/client/versions", nil)
	req.Header.Set("Origin", "http://127.0.0.1:18300")
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if v := r.Header.Values("Access-Control-Allow-Origin"); r.StatusCode != 200 || len(v) != 1 || v[0] != "http://127.0.0.1:18300" {
		t.Fatalf("proxied CORS: %d %v", r.StatusCode, v)
	}

	if c, _ := e.call("PUT", "/internal/v1/agents", "", map[string]any{}); c != 401 {
		t.Fatal("internal without auth")
	}
	if c, _ := e.call("PUT", "/internal/v1/agents", e.asToken, map[string]any{}); c != 401 {
		t.Fatal("as_token accepted on internal route")
	}
	if c, _ := e.call("POST", "/internal/v1/bridge-state", e.cfg.InternalSecret, map[string]any{}); c != 401 {
		t.Fatal("bridge-state accepts only as_tokens")
	}
	e.must(204, "POST", "/internal/v1/bridge-state", e.asToken, map[string]any{"state_event": "RUNNING"})
}

func TestITConnectionsAgentsApprovalsTasks(t *testing.T) {
	e := setupIT(t)
	email := fmt.Sprintf("it-flow-%s@example.com", strings.TrimPrefix(newID("x"), "x_"))
	sess := e.signIn(email)
	tok := str(sess, "access_token")
	mxid := str(sess, "matrix", "user_id")
	internal := e.cfg.InternalSecret

	// Networks.
	nets := e.must(200, "GET", "/v1/networks", "", nil)["networks"].([]any)
	if len(nets) != 3 {
		t.Fatalf("networks: %v", nets)
	}
	demo := nets[0].(map[string]any)
	if demo["id"] != "demo" || demo["available"] != true || demo["kind"] != "chat" || len(demo["flows"].([]any)) != 2 {
		t.Fatalf("demo network: %v", demo)
	}
	if dead := nets[2].(map[string]any); dead["available"] != false || len(dead["flows"].([]any)) != 0 {
		t.Fatalf("dead network: %v", dead)
	}

	// Login: user_input then complete.
	if c, _ := e.call("POST", "/v1/connections/nope/logins", tok, map[string]string{"flow_id": "demo"}); c != 404 {
		t.Fatal("unknown network")
	}
	start := e.must(200, "POST", "/v1/connections/demo/logins", tok, map[string]string{"flow_id": "demo"})
	pid := str(start, "process_id")
	step := start["step"].(map[string]any)
	if step["type"] != "user_input" || step["login_id"] != nil || step["step_id"] != "demo.name" {
		t.Fatalf("first step: %v", start)
	}
	if c, out := e.call("POST", "/v1/connections/logins/"+pid+"/steps/demo.name", tok, map[string]any{"fields": map[string]string{}}); c != 400 || str(out, "error", "message") != "display_name is required" {
		t.Fatalf("bridge validation error: %d %v", c, out)
	}
	done := e.must(200, "POST", "/v1/connections/logins/"+pid+"/steps/demo.name", tok,
		map[string]any{"fields": map[string]string{"display_name": "Demo User"}})["step"].(map[string]any)
	if done["type"] != "complete" || str(done, "complete", "connection_id") != "demo:demo-abc" || str(done, "complete", "user_login_id") != "demo-abc" {
		t.Fatalf("complete: %v", done)
	}
	conns := e.must(200, "GET", "/v1/connections", tok, nil)["connections"].([]any)
	if len(conns) != 1 || conns[0].(map[string]any)["state"] != "connecting" {
		t.Fatalf("connections: %v", conns)
	}
	// Bridge state moves it to connected.
	e.must(204, "POST", "/internal/v1/bridge-state", e.asToken, map[string]any{
		"state_event": "CONNECTED", "user_id": mxid, "remote_id": "demo-abc", "remote_name": "Demo account", "timestamp": 1, "ttl": 60})
	c0 := e.must(200, "GET", "/v1/connections", tok, nil)["connections"].([]any)[0].(map[string]any)
	if c0["state"] != "connected" || c0["remote_name"] != "Demo account" || c0["id"] != "demo:demo-abc" {
		t.Fatalf("after CONNECTED: %v", c0)
	}
	e.must(204, "POST", "/internal/v1/bridge-state", e.asToken, map[string]any{
		"state_event": "BAD_CREDENTIALS", "user_id": mxid, "remote_id": "demo-abc", "error": "x", "message": "Please log in again"})
	c0 = e.must(200, "GET", "/v1/connections", tok, nil)["connections"].([]any)[0].(map[string]any)
	if c0["state"] != "bad_credentials" || c0["state_message"] != "Please log in again" {
		t.Fatalf("after BAD_CREDENTIALS: %v", c0)
	}
	// Another user cannot use this login process.
	other := e.signIn(fmt.Sprintf("it-other-%s@example.com", strings.TrimPrefix(newID("x"), "x_")))
	otok := str(other, "access_token")
	if c, _ := e.call("POST", "/v1/connections/logins/"+pid+"/steps/demo.name", otok, map[string]any{"fields": map[string]string{"display_name": "x"}}); c != 404 {
		t.Fatal("foreign process accessible")
	}

	// display_and_wait long poll: first poll times out and returns the same step.
	old := loginWaitMax
	loginWaitMax = 300 * time.Millisecond
	defer func() { loginWaitMax = old }()
	qr := e.must(200, "POST", "/v1/connections/demo/logins", tok, map[string]string{"flow_id": "qr"})
	qpid := str(qr, "process_id")
	w1 := e.must(200, "POST", "/v1/connections/logins/"+qpid+"/steps/qr.scan/wait", tok, nil)["step"].(map[string]any)
	if w1["type"] != "display_and_wait" || str(w1, "display_and_wait", "data") != "agentstudio:qr" {
		t.Fatalf("wait timeout: %v", w1)
	}
	close(e.demo.qrRelease)
	w2 := e.must(200, "POST", "/v1/connections/logins/"+qpid+"/steps/qr.scan/wait", tok, nil)["step"].(map[string]any)
	if w2["type"] != "complete" || str(w2, "complete", "connection_id") != "demo:qr-login" {
		t.Fatalf("wait complete: %v", w2)
	}

	// Agents: registered by the bridge through the internal API.
	agentID := "agentstudio-agents:concierge-1"
	ag := e.must(200, "PUT", "/internal/v1/agents", internal, map[string]any{
		"owner_mxid": mxid, "connection_id": agentID, "name": "Concierge", "capabilities": []string{"chat", "ask", "approvals", "bogus"}})
	if ag["id"] != agentID || ag["status"] != "idle" || ag["room_id"] != nil || len(ag["capabilities"].([]any)) != 3 {
		t.Fatalf("agent: %v", ag)
	}
	e.must(200, "PATCH", "/internal/v1/agents/"+url.PathEscape(agentID), internal, map[string]any{"status": "working", "status_text": "Searching flights", "room_id": "!room:agentstudio.local"})
	agents := e.must(200, "GET", "/v1/agents", tok, nil)["agents"].([]any)
	a0 := agents[0].(map[string]any)
	if len(agents) != 1 || a0["status"] != "working" || a0["status_text"] != "Searching flights" || a0["room_id"] != "!room:agentstudio.local" {
		t.Fatalf("agents: %v", agents)
	}
	if n := len(e.must(200, "GET", "/v1/agents", otok, nil)["agents"].([]any)); n != 0 {
		t.Fatal("other user sees agent")
	}
	cons := e.must(200, "PUT", "/v1/agents/"+url.PathEscape(agentID)+"/consent", tok, map[string]any{"ask_without_preview": true})
	if cons["consent"].(map[string]any)["ask_without_preview"] != true {
		t.Fatalf("consent: %v", cons)
	}
	if c, _ := e.call("PUT", "/v1/agents/"+url.PathEscape(agentID)+"/consent", otok, map[string]any{"ask_without_preview": true}); c != 404 {
		t.Fatal("other user changed consent")
	}

	// Approvals.
	choices := []map[string]string{{"key": "book", "label": "Book", "category": "approve"}, {"key": "skip", "label": "Don't book", "category": "deny"}}
	mk := func(ext string, expires time.Time) map[string]any {
		return e.must(200, "POST", "/internal/v1/approvals", internal, map[string]any{
			"owner_mxid": mxid, "agent_id": agentID, "external_id": ext, "title": "Book the 6pm flight to Toronto for $412?",
			"details": []map[string]string{{"label": "Date", "value": "Friday"}}, "choices": choices, "expires_at": expires})
	}
	ap := mk("flight-1", time.Now().Add(45*time.Minute))
	if again := mk("flight-1", time.Now().Add(time.Hour)); again["id"] != ap["id"] {
		t.Fatal("approval create not idempotent")
	}
	apID := ap["id"].(string)
	if ap["state"] != "pending" || ap["agent_name"] != "Concierge" || ap["decision"] != nil || ap["delivery_state"] != nil || ap["version"] != 1.0 {
		t.Fatalf("approval: %v", ap)
	}
	e.must(200, "PATCH", "/internal/v1/approvals/"+apID, internal, map[string]any{"room_id": "!room:agentstudio.local", "event_id": "$card"})
	a0 = e.must(200, "GET", "/v1/agents", tok, nil)["agents"].([]any)[0].(map[string]any)
	if a0["pending_approvals"] != 1.0 {
		t.Fatalf("pending_approvals: %v", a0)
	}
	list := e.must(200, "GET", "/v1/approvals", tok, nil)["approvals"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["event_id"] != "$card" {
		t.Fatalf("approvals list: %v", list)
	}
	cur := e.must(200, "GET", "/v1/approvals/"+apID, tok, nil)
	ver := cur["version"].(float64)
	if c, out := e.call("POST", "/v1/approvals/"+apID+"/decision", tok, map[string]any{"choice": "book", "version": ver - 1, "idempotency_key": "k0"}); c != 409 || out["error"].(map[string]any)["current"] == nil {
		t.Fatalf("stale version: %d %v", c, out)
	}
	if c, _ := e.call("POST", "/v1/approvals/"+apID+"/decision", tok, map[string]any{"choice": "maybe", "version": ver, "idempotency_key": "k0"}); c != 400 {
		t.Fatal("bad choice")
	}
	if c, _ := e.call("POST", "/v1/approvals/"+apID+"/decision", otok, map[string]any{"choice": "book", "version": ver}); c != 404 {
		t.Fatal("other user decided")
	}
	dec := e.must(200, "POST", "/v1/approvals/"+apID+"/decision", tok, map[string]any{"choice": "book", "version": ver, "idempotency_key": "k1"})
	if dec["state"] != "decided" || dec["delivery_state"] != "delivered" || str(dec, "decision", "choice") != "book" {
		t.Fatalf("decision: %v", dec)
	}
	if len(e.agents.decisions) != 1 || e.agents.decisions[0]["external_id"] != "flight-1" || e.agents.decisions[0]["choice"] != "book" || e.agents.decisions[0]["agent_id"] != agentID {
		t.Fatalf("delivered: %v", e.agents.decisions)
	}
	replay := e.must(200, "POST", "/v1/approvals/"+apID+"/decision", tok, map[string]any{"choice": "book", "version": ver, "idempotency_key": "k1"})
	if replay["version"] != dec["version"] || len(e.agents.decisions) != 1 {
		t.Fatalf("replay: %v", replay)
	}
	if c, _ := e.call("POST", "/v1/approvals/"+apID+"/decision", tok, map[string]any{"choice": "skip", "version": dec["version"], "idempotency_key": "k2"}); c != 409 {
		t.Fatal("second decision accepted")
	}
	if n := len(e.must(200, "GET", "/v1/approvals", tok, nil)["approvals"].([]any)); n != 0 {
		t.Fatal("decided approval still pending")
	}
	// Expired approval: lazily expired on read, decisions get 410.
	exp := mk("flight-old", time.Now().Add(-time.Second))
	expID := exp["id"].(string)
	if c, out := e.call("POST", "/v1/approvals/"+expID+"/decision", tok, map[string]any{"choice": "book", "version": exp["version"], "idempotency_key": "k3"}); c != 410 || str(out, "error", "code") != "expired" {
		t.Fatalf("expired decision: %d %v", c, out)
	}
	if g := e.must(200, "GET", "/v1/approvals/"+expID, tok, nil); g["state"] != "expired" {
		t.Fatalf("expired state: %v", g)
	}
	if n := len(e.must(200, "GET", "/v1/approvals?state=all", tok, nil)["approvals"].([]any)); n != 2 {
		t.Fatalf("all approvals: %d", n)
	}
	// Delivery failure: the agents bridge is down.
	ap3 := mk("flight-3", time.Now().Add(time.Hour))
	e.agents.srv.Close()
	d3 := e.must(200, "POST", "/v1/approvals/"+ap3["id"].(string)+"/decision", tok, map[string]any{"choice": "skip", "version": ap3["version"], "idempotency_key": "k4"})
	if d3["delivery_state"] != "failed" || d3["state"] != "decided" {
		t.Fatalf("failed delivery: %v", d3)
	}
	// Cancel from the bridge.
	ap4 := mk("flight-4", time.Now().Add(time.Hour))
	if c4 := e.must(200, "PATCH", "/internal/v1/approvals/"+ap4["id"].(string), internal, map[string]any{"state": "cancelled"}); c4["state"] != "cancelled" {
		t.Fatalf("cancel: %v", c4)
	}

	// Tasks.
	origin := map[string]string{"room_id": "!leo:agentstudio.local", "network": "demo", "chat_name": "Leo Park", "anchor_event_id": "$anchor"}
	newTask := func(key string) map[string]any {
		return e.must(200, "POST", "/v1/tasks", tok, map[string]any{"agent_id": agentID, "idempotency_key": key,
			"request_text": "Draft a reply", "title": "Are we still on for 7:15?\nmore", "origin": origin})
	}
	tk := newTask("t1")
	if tk["state"] != "pending" || tk["title"] != "Are we still on for 7:15?" || tk["agent_name"] != "Concierge" || tk["answer"] != nil {
		t.Fatalf("task: %v", tk)
	}
	if again := newTask("t1"); again["id"] != tk["id"] {
		t.Fatal("task create not idempotent")
	}
	if c, _ := e.call("POST", "/v1/tasks", otok, map[string]any{"agent_id": agentID, "request_text": "x", "origin": origin}); c != 404 {
		t.Fatal("other user's agent usable")
	}
	tid := tk["id"].(string)
	if c, _ := e.call("POST", "/v1/tasks/"+tid+"/sent", tok, map[string]any{"version": tk["version"], "draft_index": 0}); c != 409 {
		t.Fatal("sent before answered")
	}
	drafts := []map[string]string{{"text": "Leo, sounds good, see you then!"}, {"text": "b"}, {"text": "c"}}
	ans := e.must(200, "POST", "/internal/v1/tasks/"+tid+"/answer", internal, map[string]any{"event_id": "$drafts", "drafts": drafts})
	if ans["state"] != "answered" || str(ans, "answer", "event_id") != "$drafts" {
		t.Fatalf("answer: %v", ans)
	}
	e.must(200, "POST", "/internal/v1/tasks/"+tid+"/answer", internal, map[string]any{"event_id": "$drafts", "drafts": drafts}) // retry is a no-op
	if c, _ := e.call("POST", "/internal/v1/tasks/"+tid+"/answer", internal, map[string]any{"event_id": "$other", "drafts": drafts}); c != 409 {
		t.Fatal("second answer accepted")
	}
	open := e.must(200, "GET", "/v1/tasks", tok, nil)["tasks"].([]any)
	if len(open) != 1 {
		t.Fatalf("open tasks: %v", open)
	}
	if c, _ := e.call("POST", "/v1/tasks/"+tid+"/sent", tok, map[string]any{"version": ans["version"], "draft_index": 7}); c != 400 {
		t.Fatal("bad draft index")
	}
	if c, _ := e.call("POST", "/v1/tasks/"+tid+"/sent", tok, map[string]any{"version": tk["version"], "draft_index": 0}); c != 409 {
		t.Fatal("stale version accepted")
	}
	sent := e.must(200, "POST", "/v1/tasks/"+tid+"/sent", tok, map[string]any{"version": ans["version"], "draft_index": 0})
	if sent["state"] != "done" || sent["sent_draft_index"] != 0.0 {
		t.Fatalf("sent: %v", sent)
	}
	if c, _ := e.call("POST", "/v1/tasks/"+tid+"/cancel", tok, map[string]any{"version": sent["version"]}); c != 409 {
		t.Fatal("cancel after done")
	}
	t2 := newTask("t2")
	if c := e.must(200, "POST", "/v1/tasks/"+t2["id"].(string)+"/cancel", tok, map[string]any{"version": t2["version"]}); c["state"] != "cancelled" {
		t.Fatalf("cancel: %v", c)
	}
	t3 := newTask("t3")
	if f := e.must(200, "POST", "/internal/v1/tasks/"+t3["id"].(string)+"/fail", internal, map[string]any{"reason": "agent offline"}); f["state"] != "failed" {
		t.Fatalf("fail: %v", f)
	}
	if n := len(e.must(200, "GET", "/v1/tasks?state=all", tok, nil)["tasks"].([]any)); n != 3 {
		t.Fatalf("all tasks: %d", n)
	}
	if n := len(e.must(200, "GET", "/v1/tasks", tok, nil)["tasks"].([]any)); n != 0 {
		t.Fatalf("open tasks after: %d", n)
	}

	// Remove the demo connection: bridge logout, connection hidden.
	e.must(204, "DELETE", "/v1/connections/"+url.PathEscape("demo:demo-abc"), tok, nil)
	if len(e.demo.logouts) != 1 || e.demo.logouts[0] != "demo-abc" {
		t.Fatalf("logouts: %v", e.demo.logouts)
	}
	for _, c := range e.must(200, "GET", "/v1/connections", tok, nil)["connections"].([]any) {
		if c.(map[string]any)["id"] == "demo:demo-abc" {
			t.Fatal("removed connection listed")
		}
	}
	if c, _ := e.call("DELETE", "/v1/connections/"+url.PathEscape("demo:demo-abc"), tok, nil); c != 404 {
		t.Fatal("double delete")
	}
}

func TestITLocalSignIn(t *testing.T) {
	e := setupIT(t)
	// Not in local mode: no such route.
	if c, _ := e.call("POST", "/v1/auth/local", "", map[string]string{}); c != 404 && c != 405 {
		t.Fatalf("local sign-in outside local mode: %d", c)
	}
	e.cfg.Local = true
	ts := httptest.NewServer(e.srv.Handler())
	t.Cleanup(ts.Close)
	e.base = ts.URL
	if h := e.must(200, "GET", "/v1/health", "", nil); h["local"] != true {
		t.Fatalf("health: %v", h)
	}
	a := e.must(200, "POST", "/v1/auth/local", "", map[string]string{"device_name": "IT test"})
	b := e.must(200, "POST", "/v1/auth/local", "", map[string]string{})
	if str(a, "user", "id") == "" || str(a, "user", "id") != str(b, "user", "id") || str(a, "user", "email") != LocalEmail {
		t.Fatalf("local sign-ins: %v / %v", a["user"], b["user"])
	}
	if c, _ := e.call("POST", "/v1/auth/local", "", map[string]string{}, "X-Forwarded-For", "203.0.113.9"); c != 403 {
		t.Fatalf("forwarded request: %d", c)
	}
}
