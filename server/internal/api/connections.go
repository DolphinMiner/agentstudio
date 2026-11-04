package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Connection struct {
	ID           string    `json:"id"`
	Network      string    `json:"network"`
	RemoteName   string    `json:"remote_name"`
	State        string    `json:"state"`
	StateMessage string    `json:"state_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// connectionStateFor maps a bridgev2 BridgeState state_event to
// Connection.state. ok=false for bridge-global states (STARTING, RUNNING, ...).
func connectionStateFor(stateEvent string) (string, bool) {
	switch stateEvent {
	case "CONNECTED", "BACKFILLING":
		return "connected", true
	case "CONNECTING":
		return "connecting", true
	case "TRANSIENT_DISCONNECT", "UNKNOWN_ERROR":
		return "transient_disconnect", true
	case "BAD_CREDENTIALS":
		return "bad_credentials", true
	case "LOGGED_OUT":
		return "logged_out", true
	}
	return "", false
}

func connectionID(network, userLoginID string) string { return network + ":" + userLoginID }

func (s *Server) handleListConnections(w http.ResponseWriter, r *http.Request, u *authUser) error {
	rows, err := s.db.Query(r.Context(), `
		SELECT id, network, remote_name, state, state_message, created_at, updated_at
		FROM connections WHERE user_id = $1 AND removed_at IS NULL ORDER BY created_at`, u.ID)
	if err != nil {
		return err
	}
	conns, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Connection, error) {
		var c Connection
		err := row.Scan(&c.ID, &c.Network, &c.RemoteName, &c.State, &c.StateMessage, &c.CreatedAt, &c.UpdatedAt)
		if c.RemoteName == "" {
			if b := s.cfg.Bridge(c.Network); b != nil {
				c.RemoteName = b.Name + " account"
			}
		}
		return c, err
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": conns})
	return nil
}

// bridgeStepResp is bridgev2's RespSubmitLogin: {"login_id", ...LoginStep}.
// The step is kept as raw JSON so unknown fields pass through untouched.
func splitBridgeStep(raw json.RawMessage) (loginID string, step map[string]any, err error) {
	if err := json.Unmarshal(raw, &step); err != nil {
		return "", nil, err
	}
	loginID, _ = step["login_id"].(string)
	delete(step, "login_id")
	return loginID, step, nil
}

func stepType(step map[string]any) string { t, _ := step["type"].(string); return t }

// finishStep stores the latest step and, on "complete", records the connection
// and adds connection_id to the step.
func (s *Server) finishStep(ctx context.Context, u *authUser, network, processID string, step map[string]any) error {
	if stepType(step) == "complete" {
		complete, _ := step["complete"].(map[string]any)
		if complete == nil {
			complete = map[string]any{}
			step["complete"] = complete
		}
		loginID, _ := complete["user_login_id"].(string)
		if loginID == "" {
			return errUpstream("The bridge returned an incomplete login")
		}
		connID := connectionID(network, loginID)
		complete["connection_id"] = connID
		// The bridge may already have posted CONNECTED; keep that state unless
		// the connection was removed before.
		if _, err := s.db.Exec(ctx, `
			INSERT INTO connections (id, user_id, network, remote_id, state)
			VALUES ($1, $2, $3, $4, 'connecting')
			ON CONFLICT (id) DO UPDATE SET
				user_id = EXCLUDED.user_id,
				state = CASE WHEN connections.removed_at IS NULL THEN connections.state ELSE 'connecting' END,
				state_message = CASE WHEN connections.removed_at IS NULL THEN connections.state_message ELSE '' END,
				removed_at = NULL, updated_at = now()`,
			connID, u.ID, network, loginID); err != nil {
			return err
		}
		_, err := s.db.Exec(ctx, `DELETE FROM login_processes WHERE id = $1`, processID)
		return err
	}
	stepJSON, err := json.Marshal(step)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE login_processes SET last_step = $2 WHERE id = $1`, processID, stepJSON)
	return err
}

func (s *Server) handleLoginStart(w http.ResponseWriter, r *http.Request, u *authUser) error {
	b := s.cfg.Bridge(r.PathValue("network"))
	if b == nil {
		return errNotFound
	}
	var req struct {
		FlowID string `json:"flow_id"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.FlowID == "" {
		return errBadRequest("flow_id is required")
	}
	ctx := r.Context()
	var raw json.RawMessage
	if err := s.provision(ctx, b, http.MethodPost, "/login/start/"+url.PathEscape(req.FlowID), u.MatrixUserID, map[string]any{}, &raw); err != nil {
		s.log.Warn("login start failed", "network", b.ID, "err", err)
		return toAPIError(err)
	}
	bridgeLoginID, step, err := splitBridgeStep(raw)
	if err != nil {
		return errUpstream("Invalid response from the bridge")
	}
	processID := newID("lgn")
	if _, err := s.db.Exec(ctx, `INSERT INTO login_processes (id, user_id, network, bridge_login_id) VALUES ($1, $2, $3, $4)`,
		processID, u.ID, b.ID, bridgeLoginID); err != nil {
		return err
	}
	if err := s.finishStep(ctx, u, b.ID, processID, step); err != nil {
		return err
	}
	s.log.Info("login started", "network", b.ID, "process_id", processID, "step_type", stepType(step))
	writeJSON(w, http.StatusOK, map[string]any{"process_id": processID, "step": step})
	return nil
}

type loginProcess struct {
	network, bridgeLoginID string
	lastStep               map[string]any
}

func (s *Server) getLoginProcess(ctx context.Context, u *authUser, id string) (*loginProcess, error) {
	var p loginProcess
	var last []byte
	err := s.db.QueryRow(ctx, `
		SELECT network, bridge_login_id, last_step FROM login_processes
		WHERE id = $1 AND user_id = $2 AND created_at > now() - interval '30 minutes'`, id, u.ID).
		Scan(&p.network, &p.bridgeLoginID, &last)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	} else if err != nil {
		return nil, err
	}
	if last != nil {
		_ = json.Unmarshal(last, &p.lastStep)
	}
	return &p, nil
}

func (s *Server) submitStep(ctx context.Context, u *authUser, processID, stepID, typ string, body any) (map[string]any, error) {
	p, err := s.getLoginProcess(ctx, u, processID)
	if err != nil {
		return nil, err
	}
	b := s.cfg.Bridge(p.network)
	if b == nil {
		return nil, errNotFound
	}
	if typ == "" { // infer from the last step we saw
		typ = "user_input"
		if t := stepType(p.lastStep); t == "cookies" || t == "user_input" {
			typ = t
		}
	}
	path := "/login/step/" + url.PathEscape(p.bridgeLoginID) + "/" + url.PathEscape(stepID) + "/" + typ
	var raw json.RawMessage
	if err := s.provision(ctx, b, http.MethodPost, path, u.MatrixUserID, body, &raw); err != nil {
		return nil, err
	}
	_, step, err := splitBridgeStep(raw)
	if err != nil {
		return nil, errUpstream("Invalid response from the bridge")
	}
	if err := s.finishStep(ctx, u, p.network, processID, step); err != nil {
		return nil, err
	}
	s.log.Info("login step", "network", p.network, "process_id", processID, "step_type", stepType(step))
	return step, nil
}

func (s *Server) handleLoginStep(w http.ResponseWriter, r *http.Request, u *authUser) error {
	var req struct {
		Fields  map[string]string `json:"fields"`
		Cookies map[string]string `json:"cookies"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	typ, body := "", req.Fields
	if req.Cookies != nil {
		typ, body = "cookies", req.Cookies
	} else if req.Fields != nil {
		typ = "user_input"
	}
	if body == nil {
		body = map[string]string{}
	}
	step, err := s.submitStep(r.Context(), u, r.PathValue("process_id"), r.PathValue("step_id"), typ, body)
	if err != nil {
		return toAPIError(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"step": step})
	return nil
}

// handleLoginWait long-polls a display_and_wait step for up to 60 s. On timeout
// it returns the unchanged step so the client polls again; the bridge keeps
// waiting on its side and joins the next poll.
func (s *Server) handleLoginWait(w http.ResponseWriter, r *http.Request, u *authUser) error {
	ctx, cancel := context.WithTimeout(r.Context(), loginWaitMax)
	defer cancel()
	processID := r.PathValue("process_id")
	step, err := s.submitStep(ctx, u, processID, r.PathValue("step_id"), "display_and_wait", nil)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && r.Context().Err() == nil {
			p, perr := s.getLoginProcess(r.Context(), u, processID)
			if perr != nil {
				return perr
			}
			writeJSON(w, http.StatusOK, map[string]any{"step": p.lastStep})
			return nil
		}
		return toAPIError(err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"step": step})
	return nil
}

func (s *Server) handleDeleteConnection(w http.ResponseWriter, r *http.Request, u *authUser) error {
	ctx := r.Context()
	id := r.PathValue("connection_id")
	var network, remoteID string
	err := s.db.QueryRow(ctx, `SELECT network, remote_id FROM connections WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`, id, u.ID).
		Scan(&network, &remoteID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	} else if err != nil {
		return err
	}
	if b := s.cfg.Bridge(network); b != nil {
		err := s.provision(ctx, b, http.MethodPost, "/logout/"+url.PathEscape(remoteID), u.MatrixUserID, map[string]any{}, nil)
		var be *bridgeError
		if err != nil && !(errors.As(err, &be) && be.Status == http.StatusNotFound) {
			s.log.Warn("bridge logout failed", "connection_id", id, "err", err)
			return toAPIError(err)
		}
	}
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE connections SET removed_at = now(), state = 'logged_out', updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE agents SET status = 'offline', status_text = '', updated_at = now() WHERE id = $1`, id)
		return err
	})
	if err != nil {
		return err
	}
	s.leaveAgentRoom(ctx, u, id)
	s.log.Info("connection removed", "connection_id", id)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// leaveAgentRoom takes an agent's chat out of the user's inbox when its
// connection goes. The bridge deletes its portals too; this also covers chats
// the bridge no longer knows about. Best effort.
func (s *Server) leaveAgentRoom(ctx context.Context, u *authUser, agentID string) {
	var roomID, token *string
	_ = s.db.QueryRow(ctx, `SELECT room_id FROM agents WHERE id = $1`, agentID).Scan(&roomID)
	_ = s.db.QueryRow(ctx, `SELECT matrix_access_token FROM sessions WHERE id = $1`, u.SessionID).Scan(&token)
	if roomID == nil || *roomID == "" || token == nil || *token == "" {
		return
	}
	if err := s.synapse.LeaveRoom(ctx, *token, *roomID); err != nil {
		s.log.Info("leaving the agent's room failed", "connection_id", agentID, "err", err)
	}
}

// bridgeByASToken identifies the bridge posting bridge state.
func (s *Server) bridgeByASToken(tok string) *BridgeConfig {
	for i := range s.cfg.Bridges {
		if b := &s.cfg.Bridges[i]; b.ASToken != "" && constantTimeEq(tok, b.ASToken) {
			return b
		}
	}
	return nil
}

// localpartOf returns the localpart of a Matrix ID on our server.
func (s *Server) localpartOf(mxid string) (string, bool) {
	rest, ok := strings.CutPrefix(mxid, "@")
	if !ok {
		return "", false
	}
	lp, server, ok := strings.Cut(rest, ":")
	return lp, ok && server == s.cfg.ServerName && lp != ""
}

// userIDByMXID resolves a Matrix ID to an AgentStudio user id.
func (s *Server) userIDByMXID(ctx context.Context, mxid string) (string, error) {
	lp, ok := s.localpartOf(mxid)
	if !ok {
		return "", errNotFound
	}
	var id string
	err := s.db.QueryRow(ctx, `SELECT id FROM users WHERE matrix_localpart = $1`, lp).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	return id, err
}

func (s *Server) handleBridgeState(w http.ResponseWriter, r *http.Request) error {
	tok, ok := bearer(r)
	if !ok {
		return errUnauthenticated
	}
	b := s.bridgeByASToken(tok)
	if b == nil {
		return errUnauthenticated
	}
	var st struct {
		StateEvent string `json:"state_event"`
		UserID     string `json:"user_id"`
		RemoteID   string `json:"remote_id"`
		RemoteName string `json:"remote_name"`
		Error      string `json:"error"`
		Message    string `json:"message"`
		Reason     string `json:"reason"`
	}
	if err := decodeJSON(r, &st); err != nil {
		return err
	}
	state, mapped := connectionStateFor(st.StateEvent)
	if !mapped || st.UserID == "" || st.RemoteID == "" {
		w.WriteHeader(http.StatusNoContent) // bridge-global state; nothing to store
		return nil
	}
	ctx := r.Context()
	userID, err := s.userIDByMXID(ctx, st.UserID)
	if err != nil {
		if errors.Is(err, errNotFound) {
			s.log.Warn("bridge state for unknown user", "network", b.ID)
			w.WriteHeader(http.StatusNoContent)
			return nil
		}
		return err
	}
	msg := st.Message
	if msg == "" {
		msg = st.Reason
	}
	if msg == "" {
		msg = st.Error
	}
	if state == "connected" {
		msg = ""
	}
	id := connectionID(b.ID, st.RemoteID)
	_, err = s.db.Exec(ctx, `
		INSERT INTO connections (id, user_id, network, remote_id, remote_name, state, state_message)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET
			remote_name = coalesce(nullif(EXCLUDED.remote_name, ''), connections.remote_name),
			state = EXCLUDED.state, state_message = EXCLUDED.state_message, updated_at = now()`,
		id, userID, b.ID, st.RemoteID, st.RemoteName, state, msg)
	if err != nil {
		return err
	}
	s.log.Info("bridge state", "connection_id", id, "state_event", st.StateEvent, "state", state)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
