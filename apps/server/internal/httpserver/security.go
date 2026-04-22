package httpserver

import (
	"crypto/subtle"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
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

func newSessionStore() *sessionStore {
	return &sessionStore{sessions: make(map[string]time.Time)}
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
	if len(history) >= l.maxHits {
		l.hits[key] = history
		return false
	}
	history = append(history, now)
	l.hits[key] = history
	return true
}

func (l *attemptLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

func normalizeOrigin(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return fmt.Sprintf("%s://%s", strings.ToLower(parsed.Scheme), strings.ToLower(parsed.Host))
}

func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		scheme = strings.ToLower(forwarded)
	}
	host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = strings.TrimSpace(r.Host)
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
	if host == "" || strings.EqualFold(host, "localhost") {
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

func (s *Server) isAllowedOrigin(r *http.Request, origin string) bool {
	if origin == "" {
		return true
	}
	normalized := normalizeOrigin(origin)
	if normalized == "" {
		return false
	}
	if normalized == requestOrigin(r) {
		return true
	}

	cfg := s.currentConfig()
	for _, allowed := range cfg.AllowedOrigins {
		if normalizeOrigin(allowed) == normalized {
			return true
		}
	}

	if (cfg.DevMode || isLoopbackBind(cfg.Bind)) && isLoopbackOrigin(normalized) {
		return true
	}

	return false
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" && s.isAllowedOrigin(r, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, If-Match")
			w.Header().Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
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
		"frame-src 'self' data: blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		"manifest-src 'self'",
	}, "; ")
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy())
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func sessionStatusPayload(authenticated bool, cfg config.Config) map[string]any {
	return map[string]any{
		"authenticated":       authenticated,
		"authRequired":        strings.TrimSpace(cfg.AuthToken) != "",
		"supportsSessionLogin": true,
	}
}

func sessionCookie(r *http.Request, token string, expiresAt time.Time) *http.Cookie {
	cookie := &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/api",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Expires:  expiresAt,
	}
	if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		cookie.Secure = true
	}
	return cookie
}

func clearSessionCookie(r *http.Request) *http.Cookie {
	cookie := sessionCookie(r, "", time.Unix(0, 0))
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

func clientAddressKey(r *http.Request) string {
	host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if host == "" {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		return parsedHost
	}
	return host
}

func (s *Server) sessionStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	writeJSON(w, http.StatusOK, sessionStatusPayload(s.requestAuthenticatedViaSession(r), cfg))
}

func (s *Server) sessionLogin(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	if !s.loginLimiter.allow(clientAddressKey(r)) {
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
		s.loginLimiter.reset(clientAddressKey(r))
		token, expiresAt, err := s.sessions.create()
		if err != nil {
			writeError(w, err)
			return
		}
		http.SetCookie(w, sessionCookie(r, token, expiresAt))
		writeJSON(w, http.StatusOK, sessionStatusPayload(true, cfg))
		return
	}

	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (s *Server) sessionLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.sessions.delete(cookie.Value)
	}
	http.SetCookie(w, clearSessionCookie(r))
	writeJSON(w, http.StatusOK, sessionStatusPayload(false, s.currentConfig()))
}

func subtleCompare(left string, right string) bool {
	if len(left) == 0 || len(right) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
