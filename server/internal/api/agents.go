package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

type AgentConsent struct {
	AskWithoutPreview bool `json:"ask_without_preview"`
}

type Agent struct {
	ID               string       `json:"id"`
	ConnectionID     string       `json:"connection_id"`
	Name             string       `json:"name"`
	Description      string       `json:"description,omitempty"`
	AvatarURL        string       `json:"avatar_url,omitempty"`
	RoomID           *string      `json:"room_id"`
	Capabilities     []string     `json:"capabilities"`
	Status           string       `json:"status"`
	StatusText       string       `json:"status_text,omitempty"`
	PendingApprovals int          `json:"pending_approvals"`
	Consent          AgentConsent `json:"consent"`
}

// agentSelect lists a user's agents. Agents on a removed connection are hidden;
// agents whose connection is logged out show as offline.
const agentSelect = `
	SELECT a.id, a.name, a.description, a.avatar_url, a.room_id, a.capabilities,
		CASE WHEN c.state IN ('logged_out', 'bad_credentials') THEN 'offline' ELSE a.status END,
		a.status_text, a.ask_without_preview,
		(SELECT count(*) FROM approvals p WHERE p.agent_id = a.id AND p.state = 'pending'
			AND (p.expires_at IS NULL OR p.expires_at > now()))
	FROM agents a LEFT JOIN connections c ON c.id = a.id
	WHERE a.user_id = $1 AND c.removed_at IS NULL`

func scanAgent(row pgx.Row) (Agent, error) {
	var a Agent
	err := row.Scan(&a.ID, &a.Name, &a.Description, &a.AvatarURL, &a.RoomID, &a.Capabilities,
		&a.Status, &a.StatusText, &a.Consent.AskWithoutPreview, &a.PendingApprovals)
	a.ConnectionID = a.ID
	if a.Capabilities == nil {
		a.Capabilities = []string{}
	}
	return a, err
}

func (s *Server) getAgent(ctx context.Context, userID, agentID string) (*Agent, error) {
	a, err := scanAgent(s.db.QueryRow(ctx, agentSelect+` AND a.id = $2`, userID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	} else if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request, u *authUser) error {
	rows, err := s.db.Query(r.Context(), agentSelect+` ORDER BY a.created_at`, u.ID)
	if err != nil {
		return err
	}
	agents, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Agent, error) { return scanAgent(row) })
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
	return nil
}

func (s *Server) handleAgentConsent(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		AskWithoutPreview *bool `json:"ask_without_preview"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.AskWithoutPreview == nil {
		return errBadRequest("ask_without_preview is required")
	}
	id := r.PathValue("agent_id")
	tag, err := s.db.Exec(r.Context(), `UPDATE agents SET ask_without_preview = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
		id, u.ID, *req.AskWithoutPreview)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	a, err := s.getAgent(r.Context(), u.ID, id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, a)
	return nil
}

var validCapabilities = map[string]bool{"chat": true, "ask": true, "approvals": true}

func (s *Server) handleInternalPutAgent(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		OwnerMXID    string   `json:"owner_mxid"`
		ConnectionID string   `json:"connection_id"`
		Name         string   `json:"name"`
		Description  string   `json:"description"`
		AvatarURL    string   `json:"avatar_url"`
		Capabilities []string `json:"capabilities"`
		RoomID       *string  `json:"room_id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.ConnectionID == "" || req.Name == "" {
		return errBadRequest("connection_id and name are required")
	}
	caps := []string{}
	for _, c := range req.Capabilities {
		if validCapabilities[c] {
			caps = append(caps, c)
		}
	}
	ctx := r.Context()
	userID, err := s.userIDByMXID(ctx, req.OwnerMXID)
	if err != nil {
		return err
	}
	var owner string
	err = s.db.QueryRow(ctx, `
		INSERT INTO agents (id, user_id, name, description, avatar_url, room_id, capabilities)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name, description = EXCLUDED.description, avatar_url = EXCLUDED.avatar_url,
			room_id = coalesce(EXCLUDED.room_id, agents.room_id), capabilities = EXCLUDED.capabilities,
			status = CASE WHEN agents.status = 'offline' THEN 'idle' ELSE agents.status END,
			updated_at = now()
		RETURNING user_id`,
		req.ConnectionID, userID, req.Name, req.Description, req.AvatarURL, req.RoomID, caps).Scan(&owner)
	if err != nil {
		return err
	}
	if owner != userID {
		return errForbidden // an agent never changes owner
	}
	a, err := s.getAgent(ctx, userID, req.ConnectionID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, a)
	return nil
}

func (s *Server) handleInternalPatchAgent(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Status     *string `json:"status"`
		StatusText *string `json:"status_text"`
		RoomID     *string `json:"room_id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Status != nil && *req.Status != "idle" && *req.Status != "working" && *req.Status != "offline" {
		return errBadRequest("status must be idle, working or offline")
	}
	ctx := r.Context()
	id := r.PathValue("agent_id")
	var userID string
	err := s.db.QueryRow(ctx, `
		UPDATE agents SET
			status = coalesce($2, status),
			status_text = CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN coalesce($3, '') ELSE status_text END,
			room_id = coalesce($4, room_id),
			updated_at = now()
		WHERE id = $1 RETURNING user_id`, id, req.Status, req.StatusText, req.RoomID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	} else if err != nil {
		return err
	}
	a, err := s.getAgent(ctx, userID, id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, a)
	return nil
}

// idempotency helpers: results are stored per (user, route, key).

func lookupIdempotent(ctx context.Context, q pgx.Tx, userID, route, key string) (json.RawMessage, bool, error) {
	if key == "" {
		return nil, false, nil
	}
	var resp json.RawMessage
	err := q.QueryRow(ctx, `SELECT response FROM idempotency_keys WHERE user_id = $1 AND route = $2 AND key = $3`,
		userID, route, key).Scan(&resp)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return resp, err == nil, err
}

func saveIdempotent(ctx context.Context, exec func(context.Context, string, ...any) error, userID, route, key string, v any) error {
	if key == "" {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return exec(ctx, `
		INSERT INTO idempotency_keys (user_id, route, key, status, response) VALUES ($1, $2, $3, 200, $4)
		ON CONFLICT (user_id, route, key) DO UPDATE SET response = EXCLUDED.response`, userID, route, key, b)
}

func txExec(tx pgx.Tx) func(context.Context, string, ...any) error {
	return func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}
}
