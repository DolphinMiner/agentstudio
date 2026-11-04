package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// synapseClient mints and revokes per-session Matrix credentials.
type synapseClient struct {
	baseURL string
	secret  []byte
	http    *http.Client
}

type matrixCreds struct {
	UserID      string `json:"user_id"`
	DeviceID    string `json:"device_id"`
	AccessToken string `json:"access_token"`
}

func (s *synapseClient) do(ctx context.Context, method, path, token string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		// The error body holds only errcode/error, never secrets; keep it short.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("synapse %s %s: HTTP %d: %s", method, path, resp.StatusCode, b)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// Login logs in (auto-registering on first use) with org.matrix.login.jwt.
func (s *synapseClient) Login(ctx context.Context, localpart, deviceID, deviceName string) (*matrixCreds, error) {
	tok, err := synapseLoginJWT(s.secret, localpart, time.Now())
	if err != nil {
		return nil, err
	}
	var out matrixCreds
	err = s.do(ctx, http.MethodPost, "/_matrix/client/v3/login", "", map[string]any{
		"type":                        "org.matrix.login.jwt",
		"token":                       tok,
		"device_id":                   deviceID,
		"initial_device_display_name": deviceName,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetDisplayName sets the user's global display name.
func (s *synapseClient) SetDisplayName(ctx context.Context, creds *matrixCreds, name string) error {
	return s.do(ctx, http.MethodPut,
		"/_matrix/client/v3/profile/"+url.PathEscape(creds.UserID)+"/displayname",
		creds.AccessToken, map[string]string{"displayname": name}, nil)
}

// Logout deletes the device behind a Matrix access token.
func (s *synapseClient) Logout(ctx context.Context, token string) error {
	return s.do(ctx, http.MethodPost, "/_matrix/client/v3/logout", token, map[string]any{}, nil)
}

// LeaveRoom leaves and forgets a room as the token's user, so it is gone from
// every client. Leaving a room the user is no longer in is not an error.
func (s *synapseClient) LeaveRoom(ctx context.Context, token, roomID string) error {
	base := "/_matrix/client/v3/rooms/" + url.PathEscape(roomID)
	if err := s.do(ctx, http.MethodPost, base+"/leave", token, map[string]any{}, nil); err != nil {
		return err
	}
	return s.do(ctx, http.MethodPost, base+"/forget", token, map[string]any{}, nil)
}

// probe returns true when GET url answers 200 within 2 s.
func probe(ctx context.Context, client *http.Client, u string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
