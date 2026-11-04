package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const deliveryTimeout = 5 * time.Second

type LabelValue struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type Choice struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Category string `json:"category"`
}

type Decision struct {
	Choice    string    `json:"choice"`
	DecidedAt time.Time `json:"decided_at"`
}

type Approval struct {
	ID            string       `json:"id"`
	Version       int          `json:"version"`
	AgentID       string       `json:"agent_id"`
	AgentName     string       `json:"agent_name"`
	RoomID        *string      `json:"room_id"`
	EventID       *string      `json:"event_id"`
	Title         string       `json:"title"`
	Summary       string       `json:"summary,omitempty"`
	Details       []LabelValue `json:"details"`
	Choices       []Choice     `json:"choices"`
	State         string       `json:"state"`
	Decision      *Decision    `json:"decision"`
	DeliveryState *string      `json:"delivery_state"`
	ExpiresAt     *time.Time   `json:"expires_at"`
	CreatedAt     time.Time    `json:"created_at"`
	UpdatedAt     time.Time    `json:"updated_at"`

	userID     string
	externalID string
}

const approvalSelect = `
	SELECT p.id, p.version, p.agent_id, a.name, p.room_id, p.event_id, p.title, p.summary, p.details, p.choices,
		p.state, p.decision, p.decided_at, p.delivery_state, p.expires_at, p.created_at, p.updated_at,
		p.user_id, p.external_id
	FROM approvals p JOIN agents a ON a.id = p.agent_id`

func scanApproval(row pgx.Row) (*Approval, error) {
	var p Approval
	var choice *string
	var decidedAt *time.Time
	err := row.Scan(&p.ID, &p.Version, &p.AgentID, &p.AgentName, &p.RoomID, &p.EventID, &p.Title, &p.Summary,
		&p.Details, &p.Choices, &p.State, &choice, &decidedAt, &p.DeliveryState, &p.ExpiresAt,
		&p.CreatedAt, &p.UpdatedAt, &p.userID, &p.externalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	} else if err != nil {
		return nil, err
	}
	if choice != nil && decidedAt != nil {
		p.Decision = &Decision{Choice: *choice, DecidedAt: *decidedAt}
	}
	if p.Details == nil {
		p.Details = []LabelValue{}
	}
	return &p, nil
}

// expireApprovals lazily marks a user's overdue pending approvals expired.
func (s *Server) expireApprovals(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE approvals SET state = 'expired', version = version + 1, updated_at = now()
		WHERE user_id = $1 AND state = 'pending' AND expires_at <= now()`, userID)
	return err
}

func (s *Server) handleListApprovals(w http.ResponseWriter, r *http.Request, u *authUser) error {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "pending"
	}
	if state != "pending" && state != "all" {
		return errBadRequest("state must be pending or all")
	}
	ctx := r.Context()
	if err := s.expireApprovals(ctx, u.ID); err != nil {
		return err
	}
	q := approvalSelect + ` WHERE p.user_id = $1`
	if state == "pending" {
		q += ` AND p.state = 'pending'`
	}
	rows, err := s.db.Query(ctx, q+` ORDER BY p.created_at DESC, p.id DESC LIMIT 200`, u.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []*Approval{}
	for rows.Next() {
		p, err := scanApproval(rows)
		if err != nil {
			return err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": out})
	return nil
}

func (s *Server) getApproval(ctx context.Context, userID, id string) (*Approval, error) {
	if err := s.expireApprovals(ctx, userID); err != nil {
		return nil, err
	}
	return scanApproval(s.db.QueryRow(ctx, approvalSelect+` WHERE p.id = $1 AND p.user_id = $2`, id, userID))
}

func (s *Server) handleGetApproval(w http.ResponseWriter, r *http.Request, u *authUser) error {
	p, err := s.getApproval(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, p)
	return nil
}

func hasChoice(choices []Choice, key string) bool {
	for _, c := range choices {
		if c.Key == key {
			return true
		}
	}
	return false
}

func (s *Server) handleDecision(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		Choice         string `json:"choice"`
		Version        *int   `json:"version"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Choice == "" || req.Version == nil {
		return errBadRequest("choice and version are required")
	}
	ctx := r.Context()
	id := r.PathValue("id")
	route := "approval-decision:" + id

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// Lock the row first: concurrent decisions (and retries) serialize here.
	p, err := scanApproval(tx.QueryRow(ctx, approvalSelect+` WHERE p.id = $1 AND p.user_id = $2 FOR UPDATE OF p`, id, u.ID))
	if err != nil {
		return err
	}
	if prev, ok, err := lookupIdempotent(ctx, tx, u.ID, route, req.IdempotencyKey); err != nil {
		return err
	} else if ok {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(append(prev, '\n'))
		return nil
	}
	now := s.now()
	if p.State == "pending" && p.ExpiresAt != nil && !now.Before(*p.ExpiresAt) {
		if _, err := tx.Exec(ctx, `UPDATE approvals SET state = 'expired', version = version + 1, updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errExpired
	}
	if p.State == "expired" {
		return errExpired
	}
	if *req.Version != p.Version || p.State != "pending" {
		return errConflict(p)
	}
	if !hasChoice(p.Choices, req.Choice) {
		return errBadRequest("Unknown choice")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE approvals SET state = 'decided', decision = $2, decided_at = $3, delivery_state = 'queued',
			version = version + 1, updated_at = now()
		WHERE id = $1`, id, req.Choice, now); err != nil {
		return err
	}
	decided, err := scanApproval(tx.QueryRow(ctx, approvalSelect+` WHERE p.id = $1`, id))
	if err != nil {
		return err
	}
	if err := saveIdempotent(ctx, txExec(tx), u.ID, route, req.IdempotencyKey, decided); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.log.Info("approval decided", "approval_id", id, "choice", req.Choice)

	// Deliver synchronously. Detach from the client so a disconnect cannot
	// leave the approval stuck in "queued".
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryTimeout)
	defer cancel()
	delivery := "delivered"
	if err := s.deliverDecision(dctx, decided); err != nil {
		s.log.Warn("approval delivery failed", "approval_id", id, "err", err)
		delivery = "failed"
	}
	bg := context.WithoutCancel(ctx)
	if _, err := s.db.Exec(bg, `UPDATE approvals SET delivery_state = $2, version = version + 1, updated_at = now() WHERE id = $1`, id, delivery); err != nil {
		return err
	}
	final, err := scanApproval(s.db.QueryRow(bg, approvalSelect+` WHERE p.id = $1`, id))
	if err != nil {
		return err
	}
	if err := saveIdempotent(bg, func(ctx context.Context, sql string, args ...any) error {
		_, err := s.db.Exec(ctx, sql, args...)
		return err
	}, u.ID, route, req.IdempotencyKey, final); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, final)
	return nil
}

// deliverDecision posts the decision to the agents bridge.
func (s *Server) deliverDecision(ctx context.Context, p *Approval) error {
	b := s.cfg.AgentsBridge()
	if b == nil {
		return errors.New("no agents bridge configured")
	}
	body, _ := json.Marshal(map[string]string{
		"approval_id": p.ID, "agent_id": p.AgentID, "external_id": p.externalID, "choice": p.Decision.Choice,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(b.ProvisionURL, "/")+"/agentstudio/internal/v1/approval-decisions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.InternalSecret)
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &bridgeError{Status: resp.StatusCode}
	}
	return nil
}

// validateChoices enforces docs/agent-protocol.md: 2..4 choices with unique
// keys, at least one approve and one deny.
func validateChoices(choices []Choice) error {
	if len(choices) < 2 || len(choices) > 4 {
		return errBadRequest("choices must have 2 to 4 entries")
	}
	seen := map[string]bool{}
	var approve, deny bool
	for _, c := range choices {
		if c.Key == "" || c.Label == "" || seen[c.Key] {
			return errBadRequest("each choice needs a unique key and a label")
		}
		seen[c.Key] = true
		switch c.Category {
		case "approve":
			approve = true
		case "deny":
			deny = true
		default:
			return errBadRequest("choice category must be approve or deny")
		}
	}
	if !approve || !deny {
		return errBadRequest("choices need at least one approve and one deny")
	}
	return nil
}

func (s *Server) handleInternalCreateApproval(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		OwnerMXID  string       `json:"owner_mxid"`
		AgentID    string       `json:"agent_id"`
		ExternalID string       `json:"external_id"`
		Title      string       `json:"title"`
		Summary    string       `json:"summary"`
		Details    []LabelValue `json:"details"`
		Choices    []Choice     `json:"choices"`
		ExpiresAt  *time.Time   `json:"expires_at"`
		RoomID     *string      `json:"room_id"`
		EventID    *string      `json:"event_id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.AgentID == "" || req.ExternalID == "" || req.Title == "" {
		return errBadRequest("agent_id, external_id and title are required")
	}
	if err := validateChoices(req.Choices); err != nil {
		return err
	}
	if req.Details == nil {
		req.Details = []LabelValue{}
	}
	ctx := r.Context()
	userID, err := s.userIDByMXID(ctx, req.OwnerMXID)
	if err != nil {
		return err
	}
	var owner string
	if err := s.db.QueryRow(ctx, `SELECT user_id FROM agents WHERE id = $1`, req.AgentID).Scan(&owner); errors.Is(err, pgx.ErrNoRows) || (err == nil && owner != userID) {
		return errNotFound
	} else if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO approvals (id, user_id, agent_id, external_id, room_id, event_id, title, summary, details, choices, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (agent_id, external_id) DO NOTHING`,
		newID("apr"), userID, req.AgentID, req.ExternalID, req.RoomID, req.EventID, req.Title, req.Summary,
		req.Details, req.Choices, req.ExpiresAt); err != nil {
		return err
	}
	p, err := scanApproval(s.db.QueryRow(ctx, approvalSelect+` WHERE p.agent_id = $1 AND p.external_id = $2`, req.AgentID, req.ExternalID))
	if err != nil {
		return err
	}
	s.log.Info("approval created", "approval_id", p.ID, "agent_id", p.AgentID)
	writeJSON(w, http.StatusOK, p)
	return nil
}

func (s *Server) handleInternalPatchApproval(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		RoomID  *string `json:"room_id"`
		EventID *string `json:"event_id"`
		State   *string `json:"state"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.State != nil && *req.State != "cancelled" {
		return errBadRequest(`state may only be "cancelled"`)
	}
	ctx := r.Context()
	id := r.PathValue("id")
	var out *Approval
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		p, err := scanApproval(tx.QueryRow(ctx, approvalSelect+` WHERE p.id = $1 FOR UPDATE OF p`, id))
		if err != nil {
			return err
		}
		newState := p.State
		if req.State != nil && p.State != "cancelled" {
			if p.State != "pending" {
				return errConflict(p)
			}
			newState = "cancelled"
		}
		if _, err := tx.Exec(ctx, `
			UPDATE approvals SET room_id = coalesce($2, room_id), event_id = coalesce($3, event_id), state = $4,
				version = version + 1, updated_at = now()
			WHERE id = $1`, id, req.RoomID, req.EventID, newState); err != nil {
			return err
		}
		out, err = scanApproval(tx.QueryRow(ctx, approvalSelect+` WHERE p.id = $1`, id))
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}
