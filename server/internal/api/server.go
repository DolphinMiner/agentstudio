package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Server holds the API's dependencies.
type Server struct {
	cfg     *Config
	db      *pgxpool.Pool
	log     *slog.Logger
	synapse *synapseClient
	http    *http.Client // bridges and health probes
	mailer  Mailer
	now     func() time.Time

	flowsMu    sync.Mutex
	flowsCache map[string]flowsCacheEntry
}

// New wires a Server. The pool must already be migrated.
func New(cfg *Config, db *pgxpool.Pool, log *slog.Logger) *Server {
	s := &Server{
		cfg:        cfg,
		db:         db,
		log:        log,
		http:       &http.Client{Timeout: 70 * time.Second},
		now:        time.Now,
		flowsCache: map[string]flowsCacheEntry{},
	}
	s.synapse = &synapseClient{baseURL: cfg.SynapseURL, secret: cfg.SynapseJWT, http: &http.Client{Timeout: 15 * time.Second}}
	s.mailer = &devMailer{db: db, log: log, logCode: cfg.Dev, storeOutbox: cfg.Dev}
	return s
}

type handlerFunc func(w http.ResponseWriter, r *http.Request) error
type authedFunc func(w http.ResponseWriter, r *http.Request, u *authUser) error

func (s *Server) h(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			s.handleErr(w, r, err)
		}
	}
}

func (s *Server) handleErr(w http.ResponseWriter, r *http.Request, err error) {
	if _, ok := err.(*apiError); !ok {
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	}
	writeError(w, err)
}

// Handler returns the full HTTP handler, including CORS and access logs.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /v1/health", s.h(s.handleHealth))
	if s.cfg.Dev {
		mux.HandleFunc("GET /v1/dev/outbox", s.h(s.handleDevOutbox))
	}

	if s.cfg.Local {
		mux.HandleFunc("POST /v1/auth/local", s.h(s.handleLocalSignIn))
	}
	mux.HandleFunc("POST /v1/auth/email/start", s.h(s.handleEmailStart))
	mux.HandleFunc("POST /v1/auth/email/verify", s.h(s.handleEmailVerify))
	mux.HandleFunc("POST /v1/auth/refresh", s.h(s.handleRefresh))
	mux.HandleFunc("POST /v1/auth/logout", s.authed(s.handleLogout))
	mux.HandleFunc("GET /v1/me", s.authed(s.handleMe))

	mux.HandleFunc("GET /v1/networks", s.h(s.handleNetworks))
	mux.HandleFunc("GET /v1/connections", s.authed(s.handleListConnections))
	mux.HandleFunc("POST /v1/connections/{network}/logins", s.authed(s.handleLoginStart))
	mux.HandleFunc("POST /v1/connections/logins/{process_id}/steps/{step_id}", s.authed(s.handleLoginStep))
	mux.HandleFunc("POST /v1/connections/logins/{process_id}/steps/{step_id}/wait", s.authed(s.handleLoginWait))
	mux.HandleFunc("DELETE /v1/connections/{connection_id}", s.authed(s.handleDeleteConnection))

	mux.HandleFunc("GET /v1/agents", s.authed(s.handleListAgents))
	mux.HandleFunc("PUT /v1/agents/{agent_id}/consent", s.authed(s.handleAgentConsent))

	mux.HandleFunc("GET /v1/approvals", s.authed(s.handleListApprovals))
	mux.HandleFunc("GET /v1/approvals/{id}", s.authed(s.handleGetApproval))
	mux.HandleFunc("POST /v1/approvals/{id}/decision", s.authed(s.handleDecision))

	mux.HandleFunc("POST /v1/tasks", s.authed(s.handleCreateTask))
	mux.HandleFunc("GET /v1/tasks", s.authed(s.handleListTasks))
	mux.HandleFunc("POST /v1/tasks/{id}/sent", s.authed(s.handleTaskSent))
	mux.HandleFunc("POST /v1/tasks/{id}/cancel", s.authed(s.handleTaskCancel))

	mux.HandleFunc("POST /internal/v1/bridge-state", s.h(s.handleBridgeState))
	mux.HandleFunc("PUT /internal/v1/agents", s.internal(s.handleInternalPutAgent))
	mux.HandleFunc("PATCH /internal/v1/agents/{agent_id}", s.internal(s.handleInternalPatchAgent))
	mux.HandleFunc("POST /internal/v1/approvals", s.internal(s.handleInternalCreateApproval))
	mux.HandleFunc("PATCH /internal/v1/approvals/{id}", s.internal(s.handleInternalPatchApproval))
	mux.HandleFunc("POST /internal/v1/tasks/{id}/answer", s.internal(s.handleInternalTaskAnswer))
	mux.HandleFunc("POST /internal/v1/tasks/{id}/fail", s.internal(s.handleInternalTaskFail))

	mux.Handle("/_matrix/", s.matrixProxy())

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { writeError(w, errNotFound) })

	return s.accessLog(s.cors(mux))
}

// internal guards /internal/v1 routes with AGENTSTUDIO_INTERNAL_SECRET.
func (s *Server) internal(fn handlerFunc) http.HandlerFunc {
	return s.h(func(w http.ResponseWriter, r *http.Request) error {
		tok, ok := bearer(r)
		if !ok || !constantTimeEq(tok, s.cfg.InternalSecret) {
			return errUnauthenticated
		}
		return fn(w, r)
	})
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	tok, ok := strings.CutPrefix(h, "Bearer ")
	return strings.TrimSpace(tok), ok && strings.TrimSpace(tok) != ""
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

// Flush keeps streaming (the /_matrix proxy) working through the recorder.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// accessLog logs method, path (never the query, which may carry tokens or
// emails), status and duration. Proxied Matrix traffic is logged at debug.
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		level := slog.LevelInfo
		if strings.HasPrefix(r.URL.Path, "/_matrix/") || r.URL.Path == "/healthz" {
			level = slog.LevelDebug
		}
		s.log.Log(r.Context(), level, "http",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ms", time.Since(start).Milliseconds())
	})
}

// Run listens until ctx is cancelled. There is deliberately no write timeout:
// the /_matrix/sync and login wait long polls stream for up to minutes.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	s.log.Info("agentstudio-api listening", "addr", s.cfg.Addr, "dev", s.cfg.Dev)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
