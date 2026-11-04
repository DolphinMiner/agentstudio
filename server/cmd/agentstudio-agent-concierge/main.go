// Command agentstudio-agent-concierge is the deterministic reference agent for the
// AgentStudio Agent Protocol (docs/agent-protocol.md). It listens on CONCIERGE_ADDR
// (default 127.0.0.1:18201) and serves GET /health for the stack manager.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/concierge"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	addr := os.Getenv("CONCIERGE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18201"
	}

	agent := concierge.New(concierge.Config{Log: log})
	defer agent.Close()

	srv := &http.Server{Addr: addr, Handler: agent.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Info("agentstudio-agent-concierge listening", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server failed", "err", err)
		os.Exit(1)
	}
}
