package api

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mailer sends sign-in codes.
type Mailer interface {
	SendCode(ctx context.Context, email, code string) error
}

// devMailer is the only mailer in v0.1: it stores mails in dev_outbox (dev
// mode) and logs that a code was sent. The code itself is logged only in dev.
type devMailer struct {
	db          *pgxpool.Pool
	log         *slog.Logger
	logCode     bool
	storeOutbox bool
}

func (m *devMailer) SendCode(ctx context.Context, email, code string) error {
	if m.storeOutbox {
		if _, err := m.db.Exec(ctx, `INSERT INTO dev_outbox (to_email, subject, code) VALUES ($1, $2, $3)`,
			email, "Your AgentStudio sign-in code", code); err != nil {
			return err
		}
	}
	if m.logCode {
		m.log.Info("sign-in code sent", "to", email, "code", code)
	} else {
		m.log.Info("sign-in code sent")
	}
	return nil
}

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	MatrixUserID string    `json:"matrix_user_id"`
	CreatedAt    time.Time `json:"created_at"`
}

type SessionMatrix struct {
	HomeserverURL string `json:"homeserver_url"`
	UserID        string `json:"user_id"`
	DeviceID      string `json:"device_id"`
	AccessToken   string `json:"access_token"`
}

type Session struct {
	SessionID       string        `json:"session_id"`
	AccessToken     string        `json:"access_token"`
	AccessExpiresAt time.Time     `json:"access_expires_at"`
	RefreshToken    string        `json:"refresh_token"`
	User            User          `json:"user"`
	Matrix          SessionMatrix `json:"matrix"`
}

// authUser is the authenticated caller.
type authUser struct {
	User
	SessionID string
}

func (s *Server) authed(fn authedFunc) http.HandlerFunc {
	return s.h(func(w http.ResponseWriter, r *http.Request) error {
		tok, ok := bearer(r)
		if !ok {
			return errUnauthenticated
		}
		userID, sid, err := parseAccessToken(s.cfg.TokenSecret, tok, s.now())
		if err != nil {
			return errUnauthenticated
		}
		var u authUser
		var lp string
		err = s.db.QueryRow(r.Context(), `
			SELECT u.id, u.email, u.matrix_localpart, u.created_at
			FROM sessions s JOIN users u ON u.id = s.user_id
			WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL`, sid, userID).
			Scan(&u.ID, &u.Email, &lp, &u.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return errUnauthenticated
		} else if err != nil {
			return err
		}
		u.MatrixUserID = s.cfg.MatrixUserID(lp)
		u.SessionID = sid
		return fn(w, r, &u)
	})
}

func (s *Server) handleEmailStart(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	email, ok := normalizeEmail(req.Email)
	if !ok {
		return errBadRequest("Enter a valid email address")
	}
	now := s.now()
	code := newOTP()
	// Upsert the code unless the previous one was sent less than 30 s ago.
	tag, err := s.db.Exec(r.Context(), `
		INSERT INTO email_codes (email, code_hash, attempts, sent_at, expires_at)
		VALUES ($1, $2, 0, $3, $4)
		ON CONFLICT (email) DO UPDATE
		SET code_hash = EXCLUDED.code_hash, attempts = 0, sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at
		WHERE email_codes.sent_at <= $5`,
		email, hashOTP(s.cfg.TokenSecret, email, code), now, now.Add(codeTTL), now.Add(-codeResendGap))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errRateLimited
	}
	if err := s.mailer.SendCode(r.Context(), email, code); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// consumeCode checks a code and deletes it on success. Failed attempts are
// counted; after codeMaxTries the code is dead.
func (s *Server) consumeCode(ctx context.Context, email, code string) error {
	var hash string
	var attempts int
	var expires time.Time
	err := s.db.QueryRow(ctx, `SELECT code_hash, attempts, expires_at FROM email_codes WHERE email = $1`, email).
		Scan(&hash, &attempts, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInvalidCode
	} else if err != nil {
		return err
	}
	if attempts >= codeMaxTries || !s.now().Before(expires) {
		return errInvalidCode
	}
	if !constantTimeEq(hash, hashOTP(s.cfg.TokenSecret, email, code)) {
		if _, err := s.db.Exec(ctx, `UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1`, email); err != nil {
			return err
		}
		return errInvalidCode
	}
	// Delete only if unchanged, so two concurrent verifies cannot both win.
	tag, err := s.db.Exec(ctx, `DELETE FROM email_codes WHERE email = $1 AND code_hash = $2 AND attempts < $3`,
		email, hash, codeMaxTries)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errInvalidCode
	}
	return nil
}

func (s *Server) handleEmailVerify(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Email      string `json:"email"`
		Code       string `json:"code"`
		DeviceName string `json:"device_name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	email, ok := normalizeEmail(req.Email)
	if !ok || len(req.Code) != 6 {
		return errInvalidCode
	}
	if req.DeviceName == "" {
		req.DeviceName = "AgentStudio"
	}
	if len(req.DeviceName) > 100 {
		req.DeviceName = req.DeviceName[:100]
	}
	ctx := r.Context()
	if err := s.consumeCode(ctx, email, req.Code); err != nil {
		return err
	}
	user, created, err := s.findOrCreateUser(ctx, email)
	if err != nil {
		return err
	}
	sess, err := s.createSession(ctx, user, req.DeviceName, created)
	if err != nil {
		return err
	}
	s.log.Info("signed in", "user_id", user.ID, "session_id", sess.SessionID, "new_user", created)
	writeJSON(w, http.StatusOK, sess)
	return nil
}

// LocalEmail is the account of the person whose Mac runs the API in local mode.
const LocalEmail = "you@agentstudio.local"

// handleLocalSignIn signs in without an email code. Only in local mode
// (AGENTSTUDIO_LOCAL=1), where the whole stack runs on one person's Mac, and
// only for requests made on that Mac (not forwarded by a proxy).
func (s *Server) handleLocalSignIn(w http.ResponseWriter, r *http.Request) error {
	if !fromThisMachine(r) {
		return errForbidden
	}
	var req struct {
		DeviceName string `json:"device_name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.DeviceName == "" || len(req.DeviceName) > 100 {
		req.DeviceName = "AgentStudio"
	}
	user, created, err := s.findOrCreateUser(r.Context(), LocalEmail)
	if err != nil {
		return err
	}
	sess, err := s.createSession(r.Context(), user, req.DeviceName, created)
	if err != nil {
		return err
	}
	s.log.Info("signed in on this Mac", "user_id", user.ID, "session_id", sess.SessionID, "new_user", created)
	writeJSON(w, http.StatusOK, sess)
	return nil
}

func fromThisMachine(r *http.Request) bool {
	if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) findOrCreateUser(ctx context.Context, email string) (*User, bool, error) {
	var u User
	var lp string
	err := s.db.QueryRow(ctx, `SELECT id, email, matrix_localpart, created_at FROM users WHERE email = $1`, email).
		Scan(&u.ID, &u.Email, &lp, &u.CreatedAt)
	if err == nil {
		u.MatrixUserID = s.cfg.MatrixUserID(lp)
		return &u, false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	id := newID("usr")
	lp = matrixLocalpart(id)
	err = s.db.QueryRow(ctx, `
		INSERT INTO users (id, email, matrix_localpart) VALUES ($1, $2, $3)
		ON CONFLICT (email) DO NOTHING
		RETURNING id, email, matrix_localpart, created_at`, id, email, lp).
		Scan(&u.ID, &u.Email, &lp, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) { // lost a race with a concurrent first sign-in
		u2, _, err := s.findOrCreateUser(ctx, email)
		return u2, false, err
	} else if err != nil {
		return nil, false, err
	}
	u.MatrixUserID = s.cfg.MatrixUserID(lp)
	return &u, true, nil
}

// createSession mints Matrix credentials for a new device and stores the session.
func (s *Server) createSession(ctx context.Context, user *User, deviceName string, firstSignIn bool) (*Session, error) {
	sid := newID("ses")
	creds, err := s.synapse.Login(ctx, matrixLocalpart(user.ID), deviceIDForSession(sid), deviceName)
	if err != nil {
		s.log.Error("synapse login failed", "user_id", user.ID, "err", err)
		return nil, errUpstream("Could not create the chat account")
	}
	if firstSignIn {
		if err := s.synapse.SetDisplayName(ctx, creds, emailLocalPart(user.Email)); err != nil {
			s.log.Warn("set displayname failed", "user_id", user.ID, "err", err)
		}
	}
	refresh := newSecretToken()
	now := s.now()
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sessions (id, user_id, device_name, matrix_device_id, matrix_access_token)
			VALUES ($1, $2, $3, $4, $5)`, sid, user.ID, deviceName, creds.DeviceID, creds.AccessToken); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO refresh_tokens (token_hash, session_id, expires_at) VALUES ($1, $2, $3)`,
			sha256Hex(refresh), sid, now.Add(refreshTTL))
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.buildSession(user, sid, refresh, creds.DeviceID, creds.AccessToken)
}

func (s *Server) buildSession(user *User, sid, refresh, deviceID, matrixToken string) (*Session, error) {
	access, exp, err := issueAccessToken(s.cfg.TokenSecret, user.ID, sid, s.now())
	if err != nil {
		return nil, err
	}
	return &Session{
		SessionID:       sid,
		AccessToken:     access,
		AccessExpiresAt: exp.UTC(),
		RefreshToken:    refresh,
		User:            *user,
		Matrix: SessionMatrix{
			HomeserverURL: s.cfg.ServerURL,
			UserID:        user.MatrixUserID,
			DeviceID:      deviceID,
			AccessToken:   matrixToken,
		},
	}, nil
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.RefreshToken == "" {
		return errUnauthenticated
	}
	ctx := r.Context()
	now := s.now()
	hash := sha256Hex(req.RefreshToken)
	var sid string
	var expires time.Time
	var used *time.Time
	err := s.db.QueryRow(ctx, `SELECT session_id, expires_at, used_at FROM refresh_tokens WHERE token_hash = $1`, hash).
		Scan(&sid, &expires, &used)
	if errors.Is(err, pgx.ErrNoRows) {
		return errUnauthenticated
	} else if err != nil {
		return err
	}
	if used != nil {
		// Reuse of a rotated token: assume theft and kill the session.
		s.log.Warn("refresh token reuse, revoking session", "session_id", sid)
		s.revokeSession(ctx, sid)
		return errUnauthenticated
	}
	if !now.Before(expires) {
		return errUnauthenticated
	}
	// Atomically mark this token used; a concurrent refresh with the same token loses.
	tag, err := s.db.Exec(ctx, `UPDATE refresh_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL`, hash, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		s.revokeSession(ctx, sid)
		return errUnauthenticated
	}
	var u User
	var lp, deviceID, matrixToken string
	err = s.db.QueryRow(ctx, `
		SELECT u.id, u.email, u.matrix_localpart, u.created_at, s.matrix_device_id, s.matrix_access_token
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = $1 AND s.revoked_at IS NULL`, sid).
		Scan(&u.ID, &u.Email, &lp, &u.CreatedAt, &deviceID, &matrixToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return errUnauthenticated
	} else if err != nil {
		return err
	}
	u.MatrixUserID = s.cfg.MatrixUserID(lp)
	refresh := newSecretToken()
	if _, err := s.db.Exec(ctx, `INSERT INTO refresh_tokens (token_hash, session_id, expires_at) VALUES ($1, $2, $3)`,
		sha256Hex(refresh), sid, now.Add(refreshTTL)); err != nil {
		return err
	}
	sess, err := s.buildSession(&u, sid, refresh, deviceID, matrixToken)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sess)
	return nil
}

// revokeSession marks the session revoked and logs out its Matrix device.
func (s *Server) revokeSession(ctx context.Context, sid string) {
	var matrixToken string
	err := s.db.QueryRow(ctx, `
		UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
		RETURNING matrix_access_token`, sid).Scan(&matrixToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	} else if err != nil {
		s.log.Error("revoke session failed", "session_id", sid, "err", err)
		return
	}
	if err := s.synapse.Logout(ctx, matrixToken); err != nil {
		s.log.Warn("matrix logout failed", "session_id", sid, "err", err)
	}
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, u *authUser) error {
	s.revokeSession(r.Context(), u.SessionID)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, u *authUser) error {
	writeJSON(w, http.StatusOK, map[string]any{"user": u.User})
	return nil
}

func (s *Server) handleDevOutbox(w http.ResponseWriter, r *http.Request) error {
	email, ok := normalizeEmail(r.URL.Query().Get("email"))
	if !ok {
		return errBadRequest("email is required")
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT to_email, subject, code, sent_at FROM dev_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 50`, email)
	if err != nil {
		return err
	}
	type msg struct {
		To      string    `json:"to"`
		Subject string    `json:"subject"`
		Code    string    `json:"code"`
		SentAt  time.Time `json:"sent_at"`
	}
	msgs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (msg, error) {
		var m msg
		err := row.Scan(&m.To, &m.Subject, &m.Code, &m.SentAt)
		m.SentAt = m.SentAt.UTC()
		return m, err
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
	return nil
}
