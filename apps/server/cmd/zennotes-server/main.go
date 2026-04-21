package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
	"github.com/ZenNotes/zennotes/apps/server/internal/httpserver"
	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
	"github.com/ZenNotes/zennotes/apps/server/internal/watcher"
	"github.com/ZenNotes/zennotes/apps/server/web"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	cfg := config.Load()
	log.Printf("vault: %s", cfg.VaultPath)
	log.Printf("bind:  %s", cfg.Bind)

	v, err := vault.New(cfg.VaultPath)
	if err != nil {
		log.Fatalf("vault init: %v", err)
	}

	_ = config.Save(cfg, v.Root())

	w, err := watcher.Start(v.Root())
	if err != nil {
		log.Fatalf("watcher start: %v", err)
	}
	defer w.Close()

	dist, err := web.Dist()
	if err != nil {
		log.Printf("warning: embedded web bundle not available: %v", err)
		dist = nil
	}

	srv := httpserver.New(v, w, dist, cfg)
	httpSrv := &http.Server{
		Addr:         cfg.Bind,
		Handler:      srv.Router(),
		ReadTimeout:  0, // Websocket-friendly.
		WriteTimeout: 0,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go func() {
		log.Printf("listening on http://%s", cfg.Bind)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http serve: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down…")

	shutdownCtx, stopShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopShutdown()
	_ = httpSrv.Shutdown(shutdownCtx)
}
