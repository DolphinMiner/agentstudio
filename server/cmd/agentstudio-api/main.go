// Command agentstudio-api is the AgentStudio REST API (docs/api.md).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/DolphinMiner/agentstudio/server/internal/api"
)

func main() {
	level := slog.LevelInfo
	if os.Getenv("AGENTSTUDIO_LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	if err := run(log); err != nil {
		log.Error("agentstudio-api failed", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := api.ConfigFromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := api.NewPool(startCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := api.Migrate(startCtx, pool, log); err != nil {
		return err
	}
	return api.New(cfg, pool, log).Run(ctx)
}
