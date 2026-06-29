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
	logStartupBanner(cfg)

	v, err := vault.New(cfg.VaultPath, vault.Options{
		FileMode:      cfg.VaultFileMode,
		DirMode:       cfg.VaultDirMode,
		MaxAssetBytes: cfg.MaxAssetBytes,
	})
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			logVaultPermissionHelp(cfg.VaultPath, err)
			os.Exit(1)
		}
		log.Fatalf("vault init: %v", err)
	}

	if config.LegacyVaultConfigExists(v.Root()) {
		log.Printf("warning: ignoring legacy vault config at %s; server secrets now stay in host config only", config.LegacyVaultConfigPath(v.Root()))
	}

	// Never fatal: where inotify is restricted (e.g. unprivileged LXC) the
	// watcher falls back to a no-op so the server still serves the vault. (#179)
	w := watcher.StartOrDisabled(v.Root(), cfg.DisableWatcher)
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

	if !bindIsLoopback(cfg.Bind) && !cfg.BehindTLS {
		go warnInsecureExposureLoop(ctx)
	}

	<-ctx.Done()
	log.Printf("shutting down…")

	shutdownCtx, stopShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopShutdown()
	_ = httpSrv.Shutdown(shutdownCtx)
}

// logVaultPermissionHelp turns the cryptic "mkdir … permission denied" into
// actionable guidance: the container runs as a non-root UID, so a bind-mounted
// host vault has to be writable by that UID (#227).
func logVaultPermissionHelp(vaultPath string, err error) {
	log.Printf("vault init: %v", err)
	log.Printf("→ ZenNotes runs as UID %d:%d and cannot write to the vault directory %q.", os.Getuid(), os.Getgid(), vaultPath)
	log.Printf("→ The mounted host directory must be writable by that UID. Either:")
	log.Printf("→   • run the container as a user that owns it:  docker run --user \"$(id -u):$(id -g)\" …")
	log.Printf("→   • or make the host directory owned by / writable for UID %d (e.g. chown).", os.Getuid())
	log.Printf("→ See https://github.com/ZenNotes/zennotes/blob/main/docs/how-to/self-host-with-docker.md#permissions")
}

func logStartupBanner(cfg config.Config) {
	log.Printf("vault:        %s", cfg.VaultPath)
	log.Printf("bind:         %s", cfg.Bind)
	authMode := "ZENNOTES_AUTH_TOKEN required"
	if strings.TrimSpace(cfg.AuthToken) == "" {
		authMode = "OPEN (no auth token set — anyone reachable can read/write)"
	}
	log.Printf("auth:         %s", authMode)
	tlsMode := "behind TLS proxy (cookies marked Secure, HSTS sent)"
	if !cfg.BehindTLS {
		tlsMode = "plain HTTP (set ZENNOTES_BEHIND_TLS=1 once a TLS proxy is in front)"
	}
	log.Printf("tls:          %s", tlsMode)
	if !bindIsLoopback(cfg.Bind) && !cfg.BehindTLS {
		log.Printf("WARNING: bound to a non-loopback address without ZENNOTES_BEHIND_TLS=1.")
		log.Printf("WARNING: put a TLS-terminating reverse proxy in front before exposing publicly.")
	}
}

func warnInsecureExposureLoop(ctx context.Context) {
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			log.Printf("WARNING: still serving plain HTTP on a non-loopback bind; configure a TLS proxy and set ZENNOTES_BEHIND_TLS=1")
		}
	}
}

func bindIsLoopback(bind string) bool {
	host, _, err := net.SplitHostPort(bind)
	if err != nil {
		host = bind
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
