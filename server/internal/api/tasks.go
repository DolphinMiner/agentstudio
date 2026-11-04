package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type TaskOrigin struct {
	RoomID        string `json:"room_id"`
	Network       string `json:"network"`
	ChatName      string `json:"chat_name"`
	AnchorEventID string `json:"anchor_event_id"`
}

type Draft struct {
	Text string `json:"text"`
}

type TaskAnswer struct {
	EventID string  `json:"event_id"`
	Drafts  []Draft `json:"drafts"`
}

type Task struct {
	ID             string      `json:"id"`
	Version        int         `json:"version"`
	AgentID        string      `json:"agent_id"`
	AgentName      string      `json:"agent_name"`
	State          string      `json:"state"`
	Title          string      `json:"title"`
	RequestText    string      `json:"request_text"`
	Origin         TaskOrigin  `json:"origin"`
	Answer         *TaskAnswer `json:"answer"`
	SentDraftIndex *int        `json:"sent_draft_index"`
	CreatedAt      time.Time   `json:"created_at"`
	UpdatedAt      time.Time   `json:"updated_at"`
}

// Task state machine (docs/api.md § Tasks):
//
//	pending  --answer--> answered --sent--> done
//	pending  --fail----> failed
//	pending | answered --cancel--> cancelled
type taskAction string

const (
	taskAnswer taskAction = "answer"
	taskFail   taskAction = "fail"
	taskSent   taskAction = "sent"
	taskCancel taskAction = "cancel"
)

// taskTransition returns the next state, or ok=false if the action is not
// allowed from the current state.
func taskTransition(from string, action taskAction) (string, bool) {
	switch action {
	case taskAnswer:
		return "answered", from == "pending"
	case taskFail:
		return "failed", from == "pending"
	case taskSent:
		return "done", from == "answered"
	case taskCancel:
		return "cancelled", from == "pending" || from == "answered"
	}
	return "", false
}

// taskTitle is the first line of the anchor text, at most 80 characters.
func taskTitle(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if r := []rune(s); len(r) > 80 {
		s = string(r[:79]) + "…"
	}
	return s
}

const taskSelect = `
	SELECT t.id, t.version, t.agent_id, a.name, t.state, t.title, t.request_text, t.origin, t.answer,
		t.sent_draft_index, t.created_at, t.updated_at
	FROM tasks t JOIN agents a ON a.id = t.agent_id`

func scanTask(row pgx.Row) (*Task, error) {
	var t Task
	err := row.Scan(&t.ID, &t.Version, &t.AgentID, &t.AgentName, &t.State, &t.Title, &t.RequestText,
		&t.Origin, &t.Answer, &t.SentDraftIndex, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return &t, err
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		AgentID        string     `json:"agent_id"`
		IdempotencyKey string     `json:"idempotency_key"`
		RequestText    string     `json:"request_text"`
		Title          string     `json:"title"`
		Origin         TaskOrigin `json:"origin"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	req.RequestText = strings.TrimSpace(req.RequestText)
	if req.AgentID == "" || req.RequestText == "" || req.Origin.RoomID == "" {
		return errBadRequest("agent_id, request_text and origin.room_id are required")
	}
	if len(req.RequestText) > 2000 {
		return errBadRequest("request_text is too long")
	}
	title := taskTitle(req.Title)
	if title == "" {
		title = taskTitle(req.RequestText)
	}
	ctx := r.Context()
	if _, err := s.getAgent(ctx, u.ID, req.AgentID); err != nil {
		return err
	}
	const route = "tasks:create"
	var out *Task
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if prev, ok, err := lookupIdempotent(ctx, tx, u.ID, route, req.IdempotencyKey); err != nil {
			return err
		} else if ok {
			out = &Task{}
			return json.Unmarshal(prev, out)
		}
		id := newID("tsk")
		if _, err := tx.Exec(ctx, `
			INSERT INTO tasks (id, user_id, agent_id, title, request_text, origin) VALUES ($1, $2, $3, $4, $5, $6)`,
			id, u.ID, req.AgentID, title, req.RequestText, req.Origin); err != nil {
			return err
		}
		t, err := scanTask(tx.QueryRow(ctx, taskSelect+` WHERE t.id = $1`, id))
		if err != nil {
			return err
		}
		if req.IdempotencyKey != "" {
			// Plain INSERT: a concurrent request with the same key fails here and retries below.
			b, _ := json.Marshal(t)
			if _, err := tx.Exec(ctx, `INSERT INTO idempotency_keys (user_id, route, key, status, response) VALUES ($1, $2, $3, 200, $4)`,
				u.ID, route, req.IdempotencyKey, b); err != nil {
				return err
			}
		}
		out = t
		return nil
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // lost the race; return the winner's result
		err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
			prev, ok, err := lookupIdempotent(ctx, tx, u.ID, route, req.IdempotencyKey)
			if err != nil || !ok {
				return errors.Join(err, errors.New("idempotency key vanished"))
			}
			out = &Task{}
			return json.Unmarshal(prev, out)
		})
	}
	if err != nil {
		return err
	}
	s.log.Info("task created", "task_id", out.ID, "agent_id", out.AgentID)
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request, u *authUser) error {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	q := taskSelect + ` WHERE t.user_id = $1`
	switch state {
	case "open":
		q += ` AND t.state IN ('pending', 'answered')`
	case "all":
	default:
		return errBadRequest("state must be open or all")
	}
	rows, err := s.db.Query(r.Context(), q+` ORDER BY t.created_at DESC, t.id DESC LIMIT 200`, u.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []*Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": out})
	return nil
}

// mutateTask locks a task and applies fn. userID "" means internal (any owner);
// version nil means no optimistic check. fn returns the SQL SET clause args.
func (s *Server) mutateTask(ctx context.Context, userID, id string, version *int, action taskAction,
	apply func(tx pgx.Tx, t *Task, next string) error) (*Task, error) {
	var out *Task
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		q := taskSelect + ` WHERE t.id = $1 AND ($2 = '' OR t.user_id = $2) FOR UPDATE OF t`
		t, err := scanTask(tx.QueryRow(ctx, q, id, userID))
		if err != nil {
			return err
		}
		if version != nil && *version != t.Version {
			return errConflict(t)
		}
		next, ok := taskTransition(t.State, action)
		if !ok {
			return errConflict(t)
		}
		if err := apply(tx, t, next); err != nil {
			return err
		}
		out, err = scanTask(tx.QueryRow(ctx, taskSelect+` WHERE t.id = $1`, id))
		return err
	})
	return out, err
}

func (s *Server) handleTaskSent(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		Version    *int `json:"version"`
		DraftIndex *int `json:"draft_index"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Version == nil || req.DraftIndex == nil {
		return errBadRequest("version and draft_index are required")
	}
	t, err := s.mutateTask(r.Context(), u.ID, r.PathValue("id"), req.Version, taskSent, func(tx pgx.Tx, t *Task, next string) error {
		if t.Answer == nil || *req.DraftIndex < 0 || *req.DraftIndex >= len(t.Answer.Drafts) {
			return errBadRequest("draft_index is out of range")
		}
		_, err := tx.Exec(r.Context(), `UPDATE tasks SET state = $2, sent_draft_index = $3, version = version + 1, updated_at = now() WHERE id = $1`,
			t.ID, next, *req.DraftIndex)
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, t)
	return nil
}

func (s *Server) handleTaskCancel(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		Version *int `json:"version"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Version == nil {
		return errBadRequest("version is required")
	}
	t, err := s.mutateTask(r.Context(), u.ID, r.PathValue("id"), req.Version, taskCancel, func(tx pgx.Tx, t *Task, next string) error {
		_, err := tx.Exec(r.Context(), `UPDATE tasks SET state = $2, version = version + 1, updated_at = now() WHERE id = $1`, t.ID, next)
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, t)
	return nil
}

func (s *Server) handleInternalTaskAnswer(w http.ResponseWriter, r *http.Request) error {
	var req TaskAnswer
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.EventID == "" || len(req.Drafts) < 1 || len(req.Drafts) > 5 {
		return errBadRequest("event_id and 1 to 5 drafts are required")
	}
	ctx := r.Context()
	id := r.PathValue("id")
	t, err := s.mutateTask(ctx, "", id, nil, taskAnswer, func(tx pgx.Tx, t *Task, next string) error {
		_, err := tx.Exec(ctx, `UPDATE tasks SET state = $2, answer = $3, version = version + 1, updated_at = now() WHERE id = $1`,
			t.ID, next, req)
		return err
	})
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == "version_conflict" {
		// A retried answer with the same event is a no-op.
		if cur, ok := ae.Current.(*Task); ok && cur.State == "answered" && cur.Answer != nil && cur.Answer.EventID == req.EventID {
			t, err = cur, nil
		}
	}
	if err != nil {
		return err
	}
	s.log.Info("task answered", "task_id", t.ID, "drafts", len(req.Drafts))
	writeJSON(w, http.StatusOK, t)
	return nil
}

func (s *Server) handleInternalTaskFail(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	t, err := s.mutateTask(ctx, "", r.PathValue("id"), nil, taskFail, func(tx pgx.Tx, t *Task, next string) error {
		_, err := tx.Exec(ctx, `UPDATE tasks SET state = $2, fail_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`,
			t.ID, next, req.Reason)
		return err
	})
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == "version_conflict" {
		if cur, ok := ae.Current.(*Task); ok && cur.State == "failed" {
			t, err = cur, nil
		}
	}
	if err != nil {
		return err
	}
	s.log.Info("task failed", "task_id", t.ID)
	writeJSON(w, http.StatusOK, t)
	return nil
}
