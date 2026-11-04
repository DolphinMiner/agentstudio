package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provisioning client for mautrix bridgev2 (bridgev2/matrix/provisioning.go in
// mautrix-go v0.32.0). Requests carry "Authorization: Bearer <shared_secret>"
// and "?user_id=<mxid>"; errors are {"errcode", "error"} JSON.

const (
	flowsCacheOK   = 30 * time.Second
	flowsCacheFail = 5 * time.Second
)

// loginWaitMax bounds the display_and_wait long poll (a var for tests).
var loginWaitMax = 60 * time.Second

type LoginFlow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type flowsCacheEntry struct {
	flows   []LoginFlow
	ok      bool
	expires time.Time
}

// bridgeError is a non-2xx reply from the bridge.
type bridgeError struct {
	Status  int
	ErrCode string `json:"errcode"`
	Message string `json:"error"`
}

func (e *bridgeError) Error() string {
	return fmt.Sprintf("bridge HTTP %d %s: %s", e.Status, e.ErrCode, e.Message)
}

// toAPIError maps bridge/transport errors to API errors.
func toAPIError(err error) error {
	var be *bridgeError
	if errors.As(err, &be) {
		msg := be.Message
		if msg == "" {
			msg = "The bridge rejected the request"
		}
		switch {
		case be.Status == 0:
			return errUpstream("The bridge is unreachable")
		case be.Status == http.StatusNotFound:
			return &apiError{Status: 404, Code: "not_found", Message: msg}
		case be.Status == http.StatusGone:
			return &apiError{Status: 410, Code: "expired", Message: msg}
		case be.Status >= 400 && be.Status < 500:
			return &apiError{Status: 400, Code: "bad_request", Message: msg}
		}
		return errUpstream(msg)
	}
	return err // *apiError or an internal error
}

func (s *Server) provision(ctx context.Context, b *BridgeConfig, method, path, userMXID string, body, out any) error {
	var rd io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(buf)
	}
	u := strings.TrimRight(b.ProvisionURL, "/") + "/_matrix/provision/v3" + path + "?user_id=" + url.QueryEscape(userMXID)
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.ProvisionSecret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &bridgeError{Message: err.Error()} // Status 0: unreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		be := &bridgeError{Status: resp.StatusCode}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(be)
		return be
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// serviceMXID is the user id the API uses for bridge calls that are not on
// behalf of a user (listing login flows).
func (s *Server) serviceMXID() string { return "@agentstudio-api:" + s.cfg.ServerName }

// loginFlows fetches a bridge's flows, cached briefly. ok=false means unreachable.
func (s *Server) loginFlows(ctx context.Context, b *BridgeConfig) ([]LoginFlow, bool) {
	s.flowsMu.Lock()
	e, hit := s.flowsCache[b.ID]
	s.flowsMu.Unlock()
	if hit && s.now().Before(e.expires) {
		return e.flows, e.ok
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var resp struct {
		Flows []LoginFlow `json:"flows"`
	}
	err := s.provision(ctx, b, http.MethodGet, "/login/flows", s.serviceMXID(), nil, &resp)
	e = flowsCacheEntry{flows: resp.Flows, ok: err == nil, expires: s.now().Add(flowsCacheOK)}
	if err != nil {
		s.log.Warn("bridge login flows unavailable", "network", b.ID, "err", err)
		e.flows, e.expires = nil, s.now().Add(flowsCacheFail)
	}
	if e.flows == nil {
		e.flows = []LoginFlow{}
	}
	s.flowsMu.Lock()
	s.flowsCache[b.ID] = e
	s.flowsMu.Unlock()
	return e.flows, e.ok
}

type Network struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Kind      string      `json:"kind"`
	BotMXID   string      `json:"bot_mxid"`
	Available bool        `json:"available"`
	Flows     []LoginFlow `json:"flows"`
}

func (s *Server) handleNetworks(w http.ResponseWriter, r *http.Request) error {
	out := make([]Network, len(s.cfg.Bridges))
	done := make(chan struct{})
	for i := range s.cfg.Bridges {
		go func(i int) {
			b := &s.cfg.Bridges[i]
			flows, ok := s.loginFlows(r.Context(), b)
			out[i] = Network{ID: b.ID, Name: b.Name, Kind: b.Kind, BotMXID: b.BotMXID, Available: ok, Flows: flows}
			done <- struct{}{}
		}(i)
	}
	for range s.cfg.Bridges {
		<-done
	}
	writeJSON(w, http.StatusOK, map[string]any{"networks": out})
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) error {
	bridges := make(map[string]bool, len(s.cfg.Bridges))
	type res struct {
		id string
		ok bool
	}
	ch := make(chan res)
	for _, b := range s.cfg.Bridges {
		go func(b BridgeConfig) {
			ch <- res{b.ID, probe(r.Context(), s.http, strings.TrimRight(b.ProvisionURL, "/")+"/_matrix/mau/live")}
		}(b)
	}
	synapseOK := probe(r.Context(), s.http, s.cfg.SynapseURL+"/_matrix/client/versions")
	for range s.cfg.Bridges {
		x := <-ch
		bridges[x.id] = x.ok
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "synapse": synapseOK, "bridges": bridges, "local": s.cfg.Local})
	return nil
}
