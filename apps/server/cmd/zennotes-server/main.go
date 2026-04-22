package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	if strings.TrimSpace(cfg.AuthToken) == "" && !cfg.AllowInsecureNoAuth && !bindIsLoopback(cfg.Bind) {
		log.Fatal("refusing to start without ZENNOTES_AUTH_TOKEN on a non-loopback bind; set ZENNOTES_ALLOW_INSECURE_NOAUTH=1 to override")
	}
	log.Printf("vault: %s", cfg.VaultPath)
	log.Printf("bind:  %s", cfg.Bind)

	v, err := vault.New(cfg.VaultPath)
	if err != nil {
		log.Fatalf("vault init: %v", err)
	}

	if config.LegacyVaultConfigExists(v.Root()) {
		log.Printf("warning: ignoring legacy vault config at %s; server secrets now stay in host config only", config.LegacyVaultConfigPath(v.Root()))
	}

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

func bindIsLoopback(bind string) bool {
	host, _, err := net.SplitHostPort(bind)
	if err != nil {
		host = bind
	}
	host = strings.Trim(host, "[]")
	if host == "" || strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
