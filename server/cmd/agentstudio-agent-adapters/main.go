// Command agentstudio-agent-adapters serves the AgentStudio Agent Protocol in front of
// agents that speak other protocols, so the agents bridge can connect them:
//
//   - /a2a/{target}/agentstudio/v0/... for A2A agents (target = base64url of the agent URL)
//   - /acp/{agent}/agentstudio/v0/...  for ACP agents allowed by AGENTSTUDIO_ACP_AGENTS
//
// It listens on ADAPTERS_ADDR (default 127.0.0.1:18202) and serves GET /health.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/adapters/a2a"
	"github.com/DolphinMiner/agentstudio/server/internal/adapters/acp"
	"github.com/DolphinMiner/agentstudio/server/internal/agenthost"
	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	addr := os.Getenv("ADAPTERS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18202"
	}
	specs, err := acp.ParseAgents(os.Getenv("AGENTSTUDIO_ACP_AGENTS"))
	if err != nil {
		log.Error("bad configuration", "err", err)
		os.Exit(1)
	}
	workDir := os.Getenv("AGENTSTUDIO_ACP_WORKDIR")
	if workDir == "" {
		workDir = filepath.Join(os.TempDir(), "agentstudio-acp")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		agentproto.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	a2aHost := agenthost.New(a2a.New(), agenthost.Options{Log: log.With("adapter", "a2a")})
	defer a2aHost.Close()
	a2aHost.Register(mux, "/a2a/{target}")
	acpHost := agenthost.New(acp.New(specs, workDir, log.With("adapter", "acp")), agenthost.Options{Log: log.With("adapter", "acp")})
	defer acpHost.Close()
	acpHost.Register(mux, "/acp/{agent}")

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Info("agentstudio-agent-adapters listening", "addr", addr, "acp_agents", len(specs))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server failed", "err", err)
		os.Exit(1)
	}
}
