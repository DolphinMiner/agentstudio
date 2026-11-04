package agentproto

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPError is returned when the other side answers with a non-2xx status.
type HTTPError struct {
	Method string
	Path   string
	Status int
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d", e.Method, e.Path, e.Status)
}

// IsStatus reports whether err is an HTTPError with the given status.
func IsStatus(err error, status int) bool {
	var he *HTTPError
	return errors.As(err, &he) && he.Status == status
}

// ErrSessionNotFound means the agent does not know the session (it answered 404),
// for example because it restarted and keeps sessions in memory.
var ErrSessionNotFound = errors.New("agent does not know this session")

// DefaultHTTPClient is used when a Client or CallbackClient has no HTTP client.
var DefaultHTTPClient = &http.Client{Timeout: 15 * time.Second}

// Client makes bridge -> agent calls.
type Client struct {
	BaseURL string // without trailing slash, e.g. http://127.0.0.1:18201
	Token   string // optional agent access token
	HTTP    *http.Client
}

// NormalizeBaseURL validates an agent base URL and strips trailing slashes.
func NormalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("agent URL must be an absolute http(s) URL")
	} else if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", errors.New("agent URL must not have a query, fragment or credentials")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func (c *Client) do(ctx context.Context, method, path, sessionID string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if sessionID != "" {
		req.Header.Set(HeaderSession, sessionID)
	}
	hc := c.HTTP
	if hc == nil {
		hc = DefaultHTTPClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("%s %s: bad response: %w", method, path, err)
	}
	return nil
}

func sessionErr(err error) error {
	if IsStatus(err, http.StatusNotFound) {
		return fmt.Errorf("%w (%w)", ErrSessionNotFound, err)
	}
	return err
}

// Info calls GET /agentstudio/v0/info and validates the result.
func (c *Client) Info(ctx context.Context) (*AgentInfo, error) {
	var info AgentInfo
	if err := c.do(ctx, http.MethodGet, "/agentstudio/v0/info", "", nil, &info); err != nil {
		return nil, err
	}
	if err := info.Validate(); err != nil {
		return nil, fmt.Errorf("invalid agent info: %w", err)
	}
	return &info, nil
}

// CreateSession calls POST /agentstudio/v0/sessions.
func (c *Client) CreateSession(ctx context.Context, req *CreateSessionRequest) (string, error) {
	var resp CreateSessionResponse
	if err := c.do(ctx, http.MethodPost, "/agentstudio/v0/sessions", req.SessionID, req, &resp); err != nil {
		return "", err
	} else if resp.SessionID == "" || len(resp.SessionID) > MaxIDLength {
		return "", errors.New("agent returned an invalid session_id")
	}
	return resp.SessionID, nil
}

// SendMessage calls POST /agentstudio/v0/messages. It returns ErrSessionNotFound on 404.
func (c *Client) SendMessage(ctx context.Context, msg *InboundMessage) error {
	return sessionErr(c.do(ctx, http.MethodPost, "/agentstudio/v0/messages", msg.SessionID, msg, nil))
}

// SendDecision calls POST /agentstudio/v0/approvals/{external_id}/decision.
// It returns ErrSessionNotFound on 404.
func (c *Client) SendDecision(ctx context.Context, sessionID, externalID string, req *DecisionRequest) error {
	path := "/agentstudio/v0/approvals/" + url.PathEscape(externalID) + "/decision"
	return sessionErr(c.do(ctx, http.MethodPost, path, sessionID, req, nil))
}

// DeleteSession calls DELETE /agentstudio/v0/sessions/{session_id}. 404 counts as success.
func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	err := c.do(ctx, http.MethodDelete, "/agentstudio/v0/sessions/"+url.PathEscape(sessionID), sessionID, nil, nil)
	if IsStatus(err, http.StatusNotFound) {
		return nil
	}
	return err
}

// CallbackClient makes agent -> bridge calls for one session.
type CallbackClient struct {
	URL   string // the session's callback_url
	Token string // the session's callback_token
	HTTP  *http.Client
}

// Send posts one event to {callback_url}/events.
func (cc *CallbackClient) Send(ctx context.Context, evt AgentEvent) error {
	if err := evt.Validate(); err != nil {
		return fmt.Errorf("refusing to send invalid event: %w", err)
	}
	c := Client{BaseURL: strings.TrimRight(cc.URL, "/"), Token: cc.Token, HTTP: cc.HTTP}
	return c.do(ctx, http.MethodPost, "/events", "", evt, nil)
}

// BearerToken extracts the token from an "Authorization: Bearer <token>" header.
func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// HashToken returns the SHA-256 of a token, used to store tokens without keeping them.
func HashToken(token string) [32]byte {
	return sha256.Sum256([]byte(token))
}

// TokenMatches compares a presented token with a stored hash in constant time.
func TokenMatches(token string, hash []byte) bool {
	if token == "" || len(hash) != sha256.Size {
		return false
	}
	h := HashToken(token)
	return subtle.ConstantTimeCompare(h[:], hash) == 1
}

// SecretMatches compares two secrets in constant time.
func SecretMatches(got, want string) bool {
	if got == "" || want == "" {
		return false
	}
	g, w := HashToken(got), HashToken(want)
	return subtle.ConstantTimeCompare(g[:], w[:]) == 1
}

// WriteJSON writes v with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes the AgentStudio error shape {"error": {"code", "message"}}.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// ReadJSON decodes a request body of at most limit bytes into v.
func ReadJSON(r *http.Request, limit int64, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, limit)).Decode(v)
}
