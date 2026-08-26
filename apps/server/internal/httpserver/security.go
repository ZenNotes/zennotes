package httpserver

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
)

const (
	sessionCookieName = "zennotes_session"
	sessionTTL        = 30 * 24 * time.Hour
)

type sessionStore struct {
	mu       sync.Mutex
	sessions map[string]time.Time
	// path, when non-empty, persists sessions to disk so browser logins survive a
	// server restart (opt-in via ZENNOTES_PERSIST_SESSIONS).
	path string
}

type attemptLimiter struct {
	mu      sync.Mutex
	window  time.Duration
	maxHits int
	hits    map[string][]time.Time
}

type httpStatusError struct {
	code int
	msg  string
}

func (e httpStatusError) Error() string {
	return e.msg
}

func newSessionStore(path string) *sessionStore {
	s := &sessionStore{sessions: make(map[string]time.Time), path: path}
	s.load()
	return s
}

// load restores persisted sessions, dropping any already expired. Best-effort:
// a missing/unreadable/corrupt file just starts with no sessions.
func (s *sessionStore) load() {
	if s.path == "" {
		return
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return // no file yet (first run) or unreadable — start clean
	}
	var stored map[string]time.Time
	if err := json.Unmarshal(raw, &stored); err != nil {
		log.Printf("sessions: ignoring unreadable %q: %v", s.path, err)
		return
	}
	now := time.Now()
	for token, expiresAt := range stored {
		if now.Before(expiresAt) {
			s.sessions[token] = expiresAt
		}
	}
}

// persistLocked writes the current sessions to disk (mode 0600). The caller must
// hold s.mu. Best-effort: a write failure only means sessions won't survive the
// next restart, so it is logged but not fatal.
func (s *sessionStore) persistLocked() {
	if s.path == "" {
		return
	}
	data, err := json.Marshal(s.sessions)
	if err != nil {
		return
	}
	if err := os.WriteFile(s.path, data, 0o600); err != nil {
		log.Printf("sessions: could not persist to %q: %v", s.path, err)
	}
}

func (s *sessionStore) create() (string, time.Time, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(buf)
	expiresAt := time.Now().Add(sessionTTL)
	s.mu.Lock()
	s.sessions[token] = expiresAt
	s.persistLocked()
	s.mu.Unlock()
	return token, expiresAt, nil
}

func (s *sessionStore) isValid(token string) bool {
	if strings.TrimSpace(token) == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, expiresAt := range s.sessions {
		if now.After(expiresAt) {
			delete(s.sessions, key)
		}
	}
	expiresAt, ok := s.sessions[token]
	return ok && now.Before(expiresAt)
}

func (s *sessionStore) delete(token string) {
	if strings.TrimSpace(token) == "" {
		return
	}
	s.mu.Lock()
	delete(s.sessions, token)
	s.persistLocked()
	s.mu.Unlock()
}

func (s *sessionStore) deleteAll() {
	s.mu.Lock()
	s.sessions = make(map[string]time.Time)
	s.persistLocked()
	s.mu.Unlock()
}

func newAttemptLimiter(window time.Duration, maxHits int) *attemptLimiter {
	return &attemptLimiter{
		window:  window,
		maxHits: maxHits,
		hits:    make(map[string][]time.Time),
	}
}

func (l *attemptLimiter) allow(key string) bool {
	if strings.TrimSpace(key) == "" {
		key = "unknown"
	}
	now := time.Now()
	cutoff := now.Add(-l.window)

	l.mu.Lock()
	defer l.mu.Unlock()

	history := l.hits[key][:0]
	for _, ts := range l.hits[key] {
		if ts.After(cutoff) {
			history = append(history, ts)
		}
	}

	// Exponential backoff between consecutive attempts. The window-based
	// cap below is the absolute ceiling; the per-attempt backoff makes
	// even the first few failures cost real time.
	if n := len(history); n > 0 {
		if wait := backoffDelay(n); now.Sub(history[n-1]) < wait {
			l.hits[key] = history
			return false
		}
	}
	if len(history) >= l.maxHits {
		l.hits[key] = history
		return false
	}
	history = append(history, now)
	l.hits[key] = history
	return true
}

// backoffDelay returns the minimum time the caller must wait before the
// (consecutiveFailures+1)-th attempt is allowed: 0, 1, 2, 4, 8, 16, 32,
// then capped at 60s.
func backoffDelay(consecutiveFailures int) time.Duration {
	if consecutiveFailures < 1 {
		return 0
	}
	n := consecutiveFailures - 1
	if n > 6 {
		n = 6
	}
	d := time.Duration(1<<n) * time.Second
	if d > 60*time.Second {
		d = 60 * time.Second
	}
	return d
}

func (l *attemptLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

// AllowAllOrigins is the wildcard operators reach for first. Comparing it
// literally, as any other string, meant ZENNOTES_ALLOWED_ORIGINS="*" locked
// everything out with no hint that it was unsupported. (#482)
const AllowAllOrigins = "*"

// NullOrigin is what a browser sends for an opaque origin — a sandboxed
// iframe, a data: document, or a page loaded over file:// in most engines.
const NullOrigin = "null"

// normalizeOrigin canonicalises an origin for comparison, and returns "" for
// anything that isn't one.
//
// Origins are not always scheme+host. Browsers send the literal "null" for
// opaque origins, and "file://" (no host) for local pages in some engines;
// requiring a host silently dropped both, so an operator who listed them
// verbatim still saw them rejected with no way to allow them. Both are
// preserved here so they can be configured. (#482)
func normalizeOrigin(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if trimmed == AllowAllOrigins {
		return AllowAllOrigins
	}
	if strings.EqualFold(trimmed, NullOrigin) {
		return NullOrigin
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		return ""
	}
	if parsed.Host == "" {
		// Scheme-only origin such as "file://". Anything else without a host —
		// "mailto:someone", "https:///path" — is not an origin.
		if parsed.Opaque != "" || parsed.Path != "" {
			return ""
		}
		return strings.ToLower(parsed.Scheme) + "://"
	}
	return fmt.Sprintf("%s://%s", strings.ToLower(parsed.Scheme), strings.ToLower(parsed.Host))
}

// peerIsTrustedProxy reports whether the immediate TCP peer (r.RemoteAddr)
// is in the configured ZENNOTES_TRUSTED_PROXIES set. Forwarded-* headers
// are only honoured when this is true.
func (s *Server) peerIsTrustedProxy(r *http.Request) bool {
	cfg := s.currentConfig()
	if len(cfg.TrustedProxies) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	for _, n := range cfg.TrustedProxies {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// effectiveScheme returns "https" if the request is genuinely on TLS or
// arrived through a trusted proxy that declares X-Forwarded-Proto: https.
// Untrusted X-Forwarded-Proto headers are ignored.
func (s *Server) effectiveScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if s.peerIsTrustedProxy(r) {
		if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
			return strings.ToLower(forwarded)
		}
	}
	if s.currentConfig().BehindTLS {
		return "https"
	}
	return "http"
}

func (s *Server) requestOrigin(r *http.Request) string {
	scheme := s.effectiveScheme(r)
	host := strings.TrimSpace(r.Host)
	if s.peerIsTrustedProxy(r) {
		if forwardedHost := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); forwardedHost != "" {
			host = forwardedHost
		}
	}
	if host == "" {
		return ""
	}
	return fmt.Sprintf("%s://%s", scheme, strings.ToLower(host))
}

func isLoopbackBind(bind string) bool {
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

func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// originDecision is how a request's Origin fared: whether it may be echoed
// back at all, and whether credentials (the session cookie) may ride with it.
type originDecision struct {
	allowed bool
	// Credentials are withheld for a wildcard match: echoing
	// Access-Control-Allow-Origin for *any* site alongside
	// Allow-Credentials: true would let any page a user visits drive their
	// session. Bearer-token clients are unaffected — they attach the token
	// themselves. (#482)
	credentials bool
}

func (s *Server) originDecisionFor(r *http.Request, origin string) originDecision {
	if origin == "" {
		return originDecision{allowed: true, credentials: true}
	}
	normalized := normalizeOrigin(origin)
	if normalized == "" {
		return originDecision{}
	}
	if normalized == s.requestOrigin(r) {
		return originDecision{allowed: true, credentials: true}
	}

	cfg := s.currentConfig()
	wildcard := false
	for _, allowed := range cfg.AllowedOrigins {
		switch normalizeOrigin(allowed) {
		case normalized:
			return originDecision{allowed: true, credentials: true}
		case AllowAllOrigins:
			wildcard = true
		}
	}
	if wildcard {
		return originDecision{allowed: true}
	}

	if (cfg.DevMode || isLoopbackBind(cfg.Bind)) && isLoopbackOrigin(normalized) {
		return originDecision{allowed: true, credentials: true}
	}

	return originDecision{}
}

func (s *Server) isAllowedOrigin(r *http.Request, origin string) bool {
	return s.originDecisionFor(r, origin).allowed
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			if decision := s.originDecisionFor(r, origin); decision.allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				if decision.credentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, If-Match")
				w.Header().Add("Vary", "Origin")
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			} else {
				s.logCORSRejection(origin)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// logCORSRejection emits one log line per unique origin so a
// misconfigured ZENNOTES_ALLOWED_ORIGINS surfaces in operator logs
// instead of silently failing in the browser.
func (s *Server) logCORSRejection(origin string) {
	if _, loaded := s.loggedOrigins.LoadOrStore(origin, struct{}{}); loaded {
		return
	}
	log.Printf(
		"CORS rejected origin %q; add it verbatim to ZENNOTES_ALLOWED_ORIGINS (comma-separated) to allow it, "+
			"or set ZENNOTES_ALLOWED_ORIGINS=* to allow any origin without credentials. "+
			"The ZenNotes desktop app talks to the server from its main process and sends no Origin, so it is "+
			"never affected by this — browser and WebView clients are.",
		origin,
	)
}

func contentSecurityPolicy() string {
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"media-src 'self' data: blob:",
		"font-src 'self' data:",
		"worker-src 'self' blob:",
		"connect-src 'self' ws: wss: https:",
		"frame-src 'self' data: blob: https://www.youtube-nocookie.com https://player.vimeo.com",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		// 'self', not 'none': the web client shows a vault's PDFs in an iframe
		// served by this server, and the PDF response carries this policy too,
		// so 'none' forbade the app's own same-origin frame (#121). Third-party
		// framing stays blocked.
		"frame-ancestors 'self'",
		"manifest-src 'self'",
	}, "; ")
}

func (s *Server) securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy())
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if s.effectiveScheme(r) == "https" {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func sessionStatusPayload(authenticated bool, cfg config.Config) map[string]any {
	return map[string]any{
		"authenticated":        authenticated,
		"authRequired":         strings.TrimSpace(cfg.AuthToken) != "",
		"supportsSessionLogin": true,
	}
}

func (s *Server) sessionCookie(r *http.Request, token string, expiresAt time.Time) *http.Cookie {
	cookie := &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/api",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Expires:  expiresAt,
	}
	if s.effectiveScheme(r) == "https" {
		cookie.Secure = true
	}
	return cookie
}

func (s *Server) clearSessionCookie(r *http.Request) *http.Cookie {
	cookie := s.sessionCookie(r, "", time.Unix(0, 0))
	cookie.MaxAge = -1
	return cookie
}

func (s *Server) requestAuthenticatedViaSession(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}
	return s.sessions.isValid(cookie.Value)
}

// clientAddressKey returns a stable identifier for rate-limit keying. It
// honours X-Forwarded-For only when the immediate peer is a configured
// trusted proxy; otherwise it returns the TCP peer IP. This prevents
// untrusted clients from spoofing rate-limit buckets via header.
func (s *Server) clientAddressKey(r *http.Request) string {
	if s.peerIsTrustedProxy(r) {
		if fwd := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); fwd != "" {
			if h, _, err := net.SplitHostPort(fwd); err == nil {
				return h
			}
			return fwd
		}
	}
	host := strings.TrimSpace(r.RemoteAddr)
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

func (s *Server) sessionStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	writeJSON(w, http.StatusOK, sessionStatusPayload(s.requestAuthenticatedViaSession(r), cfg))
}

func (s *Server) sessionLogin(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	if !s.loginLimiter.allow(s.clientAddressKey(r)) {
		http.Error(w, "too many login attempts", http.StatusTooManyRequests)
		return
	}

	if strings.TrimSpace(cfg.AuthToken) == "" {
		writeJSON(w, http.StatusOK, sessionStatusPayload(true, cfg))
		return
	}

	var req struct {
		Token string `json:"token"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if subtleCompare(strings.TrimSpace(req.Token), strings.TrimSpace(cfg.AuthToken)) {
		s.loginLimiter.reset(s.clientAddressKey(r))
		token, expiresAt, err := s.sessions.create()
		if err != nil {
			writeError(w, err)
			return
		}
		http.SetCookie(w, s.sessionCookie(r, token, expiresAt))
		writeJSON(w, http.StatusOK, sessionStatusPayload(true, cfg))
		return
	}

	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (s *Server) sessionLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.sessions.delete(cookie.Value)
	}
	http.SetCookie(w, s.clearSessionCookie(r))
	writeJSON(w, http.StatusOK, sessionStatusPayload(false, s.currentConfig()))
}

// sessionRotateToken replaces the bootstrap auth token with a caller-
// supplied value. Requires the *current* token in the body even when
// the request is authenticated, so a stolen session alone cannot rotate
// the secret. All existing sessions are invalidated; clients must
// re-login with the new token.
func (s *Server) sessionRotateToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req struct {
		CurrentToken string `json:"currentToken"`
		NewToken     string `json:"newToken"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	current := strings.TrimSpace(req.CurrentToken)
	next := strings.TrimSpace(req.NewToken)
	if len(next) < 16 {
		http.Error(w, "new token must be at least 16 characters", http.StatusBadRequest)
		return
	}
	if next == current {
		http.Error(w, "new token must differ from current", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	cfgCurrent := s.Config.AuthToken
	sourceCurrent := s.Config.AuthTokenSource
	if sourceCurrent == config.AuthTokenSourceEnv || sourceCurrent == config.AuthTokenSourceFile {
		s.mu.Unlock()
		http.Error(w, "auth token is managed outside ZenNotes; update the token source and restart", http.StatusConflict)
		return
	}
	if !subtleCompare(current, strings.TrimSpace(cfgCurrent)) {
		s.mu.Unlock()
		http.Error(w, "current token mismatch", http.StatusUnauthorized)
		return
	}
	s.Config.AuthToken = next
	s.Config.AuthTokenSource = config.AuthTokenSourceConfig
	cfgCopy := s.Config
	s.mu.Unlock()

	if err := config.SaveHost(cfgCopy); err != nil {
		s.mu.Lock()
		s.Config.AuthToken = cfgCurrent
		s.Config.AuthTokenSource = sourceCurrent
		s.mu.Unlock()
		writeError(w, err)
		return
	}
	s.sessions.deleteAll()
	http.SetCookie(w, s.clearSessionCookie(r))
	writeJSON(w, http.StatusOK, map[string]any{"rotated": true})
}

func subtleCompare(left string, right string) bool {
	if len(left) == 0 || len(right) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
