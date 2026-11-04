package demo

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// DevIncomingPath is the dev-only route that injects an incoming demo message (docs/matrix-events.md).
const DevIncomingPath = "/agentstudio/dev/v1/incoming"

type devIncomingRequest struct {
	UserMXID id.UserID `json:"user_mxid"`
	Portal   string    `json:"portal"`
	Sender   string    `json:"sender"`
	Text     string    `json:"text"`
}

// RegisterDevRoutes adds the dev hooks to mux, protected by "Authorization: Bearer <secret>".
// Callers must only do this when AGENTSTUDIO_DEV=1. An empty secret disables the routes.
func (c *Connector) RegisterDevRoutes(mux *http.ServeMux, secret string) {
	if secret == "" {
		return
	}
	mux.HandleFunc("POST "+DevIncomingPath, requireBearer(secret, c.handleDevIncoming))
}

func requireBearer(secret string, next http.HandlerFunc) http.HandlerFunc {
	want := []byte("Bearer " + secret)
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeJSONError(w, http.StatusUnauthorized, "unauthenticated", "missing or invalid bearer token")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func (c *Connector) handleDevIncoming(w http.ResponseWriter, r *http.Request) {
	var req devIncomingRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	def := getPortal(networkid.PortalID(req.Portal))
	switch {
	case req.UserMXID == "":
		writeJSONError(w, http.StatusBadRequest, "bad_request", "user_mxid is required")
		return
	case def == nil:
		writeJSONError(w, http.StatusBadRequest, "bad_request", `portal must be one of "mom", "leo", "bookclub"`)
		return
	case !def.hasMember(networkid.UserID(req.Sender)):
		writeJSONError(w, http.StatusBadRequest, "bad_request", "sender is not a member of that portal")
		return
	case strings.TrimSpace(req.Text) == "" || len(req.Text) > maxTextLength:
		writeJSONError(w, http.StatusBadRequest, "bad_request", "text must be 1-10000 bytes")
		return
	}
	login, err := c.br.GetExistingUserLoginByID(r.Context(), LoginID(req.UserMXID))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "internal_error", "failed to look up login")
		return
	}
	if login == nil || login.UserMXID != req.UserMXID {
		writeJSONError(w, http.StatusNotFound, "not_found", "no demo login for that user")
		return
	}
	client, ok := login.Client.(*Client)
	if !ok || client == nil {
		writeJSONError(w, http.StatusConflict, "not_connected", "login is not loaded")
		return
	}
	msgID := client.queueIncoming(def.ID, networkid.UserID(req.Sender), req.Text)
	writeJSON(w, http.StatusAccepted, map[string]string{"message_id": string(msgID)})
}
