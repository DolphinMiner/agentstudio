package api

import (
	"encoding/json"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestNewOTP(t *testing.T) {
	re := regexp.MustCompile(`^\d{6}$`)
	seen := map[string]bool{}
	for range 200 {
		c := newOTP()
		if !re.MatchString(c) {
			t.Fatalf("bad code %q", c)
		}
		seen[c] = true
	}
	if len(seen) < 150 {
		t.Fatalf("codes look non-random: %d unique of 200", len(seen))
	}
}

func TestHashOTP(t *testing.T) {
	k := []byte("secret")
	h := hashOTP(k, "a@b.c", "123456")
	if h != hashOTP(k, "a@b.c", "123456") {
		t.Fatal("hash not deterministic")
	}
	if h == hashOTP(k, "x@b.c", "123456") || h == hashOTP(k, "a@b.c", "123457") || h == hashOTP([]byte("other"), "a@b.c", "123456") {
		t.Fatal("hash must depend on email, code and key")
	}
	if strings.Contains(h, "123456") {
		t.Fatal("hash leaks the code")
	}
}

func TestIDs(t *testing.T) {
	id := newID("usr")
	if !regexp.MustCompile(`^usr_[a-z2-7]{16}$`).MatchString(id) {
		t.Fatalf("bad id %q", id)
	}
	lp := matrixLocalpart(id)
	if lp != "u_"+id || !regexp.MustCompile(`^[a-z0-9._=\-/]+$`).MatchString(lp) {
		t.Fatalf("bad localpart %q", lp)
	}
	if d := deviceIDForSession("ses_abc234"); d != "AGENTSTUDIO_ABC234" {
		t.Fatalf("device id %q", d)
	}
	if len(newSecretToken()) < 40 {
		t.Fatal("refresh token too short")
	}
}

func TestNormalizeEmail(t *testing.T) {
	cases := map[string]string{
		"  Alice@Example.COM ": "alice@example.com",
		"a@b":                  "a@b",
		"nobody":               "",
		"@x.com":               "",
		"a@":                   "",
		"a b@c.d":              "",
	}
	for in, want := range cases {
		got, ok := normalizeEmail(in)
		if ok != (want != "") || got != want {
			t.Errorf("normalizeEmail(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if emailLocalPart("leo.park@example.com") != "leo.park" {
		t.Fatal("local part")
	}
}

func TestAccessToken(t *testing.T) {
	secret := []byte("s3cret")
	now := time.Now()
	tok, exp, err := issueAccessToken(secret, "usr_a", "ses_b", now)
	if err != nil {
		t.Fatal(err)
	}
	if d := exp.Sub(now); d != 15*time.Minute {
		t.Fatalf("ttl %v", d)
	}
	uid, sid, err := parseAccessToken(secret, tok, now.Add(time.Minute))
	if err != nil || uid != "usr_a" || sid != "ses_b" {
		t.Fatalf("parse: %v %q %q", err, uid, sid)
	}
	if _, _, err := parseAccessToken(secret, tok, now.Add(16*time.Minute)); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, _, err := parseAccessToken([]byte("other"), tok, now); err == nil {
		t.Fatal("wrong secret accepted")
	}
	// alg=none must be rejected.
	none, _ := jwt.NewWithClaims(jwt.SigningMethodNone, accessClaims{SessionID: "ses_b",
		RegisteredClaims: jwt.RegisteredClaims{Issuer: "agentstudio", Subject: "usr_a", ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour))}}).
		SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, _, err := parseAccessToken(secret, none, now); err == nil {
		t.Fatal("alg none accepted")
	}
	// A Synapse login JWT must not work as an access token.
	syn, _ := synapseLoginJWT(secret, "u_x", now)
	if _, _, err := parseAccessToken(secret, syn, now); err == nil {
		t.Fatal("synapse jwt accepted as access token")
	}
}

func TestOriginAllowed(t *testing.T) {
	allowed := []string{"https://app.agentstudio.dev"}
	cases := []struct {
		origin string
		dev    bool
		want   bool
	}{
		{"https://app.agentstudio.dev", false, true},
		{"http://127.0.0.1:5173", false, false},
		{"http://127.0.0.1:5173", true, true},
		{"http://localhost:18300", true, true},
		{"http://localhost", true, true},
		{"null", true, true},
		{"file://", true, true},
		{"null", false, false},
		{"http://127.0.0.1.evil.com", true, false},
		{"http://localhost:80.evil.com", true, false},
		{"https://evil.com", true, false},
	}
	for _, c := range cases {
		if got := originAllowed(c.origin, allowed, c.dev); got != c.want {
			t.Errorf("originAllowed(%q, dev=%v) = %v", c.origin, c.dev, got)
		}
	}
}

func TestConnectionStateFor(t *testing.T) {
	cases := map[string]string{
		"CONNECTED": "connected", "BACKFILLING": "connected", "CONNECTING": "connecting",
		"TRANSIENT_DISCONNECT": "transient_disconnect", "UNKNOWN_ERROR": "transient_disconnect",
		"BAD_CREDENTIALS": "bad_credentials", "LOGGED_OUT": "logged_out",
	}
	for in, want := range cases {
		if got, ok := connectionStateFor(in); !ok || got != want {
			t.Errorf("%s -> %q %v", in, got, ok)
		}
	}
	for _, in := range []string{"STARTING", "RUNNING", "UNCONFIGURED", "BRIDGE_UNREACHABLE", ""} {
		if _, ok := connectionStateFor(in); ok {
			t.Errorf("%s should be ignored", in)
		}
	}
}

func TestTaskTransition(t *testing.T) {
	states := []string{"pending", "answered", "done", "cancelled", "failed"}
	allowed := map[string]string{
		"pending/answer":  "answered",
		"pending/fail":    "failed",
		"pending/cancel":  "cancelled",
		"answered/sent":   "done",
		"answered/cancel": "cancelled",
	}
	for _, from := range states {
		for _, a := range []taskAction{taskAnswer, taskFail, taskSent, taskCancel} {
			next, ok := taskTransition(from, a)
			want, wantOK := allowed[from+"/"+string(a)]
			if ok != wantOK || (ok && next != want) {
				t.Errorf("%s --%s--> %q %v; want %q %v", from, a, next, ok, want, wantOK)
			}
		}
	}
}

func TestTaskTitle(t *testing.T) {
	if got := taskTitle("  Are we still on?\nsecond line"); got != "Are we still on?" {
		t.Fatalf("%q", got)
	}
	long := strings.Repeat("é", 100)
	if got := []rune(taskTitle(long)); len(got) != 80 {
		t.Fatalf("len %d", len(got))
	}
}

func TestValidateChoices(t *testing.T) {
	ok := []Choice{{"book", "Book", "approve"}, {"skip", "Don't book", "deny"}}
	if err := validateChoices(ok); err != nil {
		t.Fatal(err)
	}
	bad := [][]Choice{
		nil,
		{{"a", "A", "approve"}},
		{{"a", "A", "approve"}, {"b", "B", "approve"}},
		{{"a", "A", "approve"}, {"a", "B", "deny"}},
		{{"a", "A", "approve"}, {"b", "B", "maybe"}},
		{{"a", "A", "approve"}, {"b", "B", "deny"}, {"c", "C", "deny"}, {"d", "D", "deny"}, {"e", "E", "deny"}},
	}
	for i, c := range bad {
		if validateChoices(c) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestSplitBridgeStep(t *testing.T) {
	id, step, err := splitBridgeStep(json.RawMessage(`{"login_id":"x1","type":"user_input","step_id":"s","txn_id":"t","user_input":{"fields":[]}}`))
	if err != nil || id != "x1" || step["login_id"] != nil || stepType(step) != "user_input" || step["txn_id"] != "t" {
		t.Fatalf("%v %q %v", err, id, step)
	}
}

func TestParseExtraBridges(t *testing.T) {
	b, err := parseExtraBridges(`[{"id":"whatsapp","name":"WhatsApp","kind":"chat","bot_mxid":"@whatsappbot:agentstudio.local","provision_url":"http://127.0.0.1:29318","provision_secret":"x","as_token":"y"}]`)
	if err != nil || len(b) != 1 || b[0].ID != "whatsapp" || b[0].ASToken != "y" {
		t.Fatalf("%v %+v", err, b)
	}
	if _, err := parseExtraBridges(`[{"id":"x","kind":"bot"}]`); err == nil {
		t.Fatal("invalid bridge accepted")
	}
	if b, err := parseExtraBridges(""); err != nil || b != nil {
		t.Fatal("empty")
	}
}

func TestWriteErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, errConflict(map[string]int{"version": 3}))
	var body struct {
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Current map[string]int `json:"current"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 409 || body.Error.Code != "version_conflict" || body.Error.Current["version"] != 3 {
		t.Fatalf("%d %+v", rec.Code, body)
	}
}
