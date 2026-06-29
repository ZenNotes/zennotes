package config

import (
	"encoding/json"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultMaxAssetBytes int64 = 50 << 20 // 50 MiB
	defaultMaxNoteBytes  int64 = 10 << 20 // 10 MiB
	defaultVaultFileMode       = fs.FileMode(0o600)
	defaultVaultDirMode        = fs.FileMode(0o700)
)

const (
	AuthTokenSourceNone   = ""
	AuthTokenSourceConfig = "config"
	AuthTokenSourceEnv    = "env"
	AuthTokenSourceFile   = "file"
)

type Config struct {
	VaultPath           string   `json:"vaultPath"`
	DefaultVaultPath    string   `json:"-"`
	BrowseRoots         []string `json:"-"`
	AllowedOrigins      []string `json:"-"`
	Bind                string   `json:"bind"`
	BasePath            string   `json:"basePath"`
	AuthToken           string   `json:"authToken"`
	AuthTokenSource     string   `json:"-"`
	AllowUnscopedBrowse bool     `json:"-"`
	AllowInsecureNoAuth bool     `json:"-"`
	DevMode             bool     `json:"-"`
	// DisableWatcher turns off the inotify file watcher (ZENNOTES_DISABLE_WATCHER).
	// Live updates stop; the vault is still fully served. Useful where inotify is
	// restricted and can hang the process (e.g. unprivileged LXC). (#179)
	DisableWatcher bool `json:"-"`

	// Limits and security knobs.
	MaxAssetBytes  int64       `json:"-"`
	MaxNoteBytes   int64       `json:"-"`
	BehindTLS      bool        `json:"-"`
	TrustedProxies []net.IPNet `json:"-"`
	VaultFileMode  fs.FileMode `json:"-"`
	VaultDirMode   fs.FileMode `json:"-"`
}

func configFilePath() string {
	if v := os.Getenv("ZENNOTES_CONFIG_PATH"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".zennotes", "server.json")
	}
	return ".zennotes-server.json"
}

func Load() Config {
	cfg := Config{
		Bind:          "127.0.0.1:7878",
		MaxAssetBytes: defaultMaxAssetBytes,
		MaxNoteBytes:  defaultMaxNoteBytes,
		VaultFileMode: defaultVaultFileMode,
		VaultDirMode:  defaultVaultDirMode,
	}
	if raw, err := os.ReadFile(configFilePath()); err == nil {
		var stored Config
		if json.Unmarshal(raw, &stored) == nil {
			if stored.VaultPath != "" {
				cfg.VaultPath = stored.VaultPath
			}
			if stored.Bind != "" {
				cfg.Bind = stored.Bind
			}
			if stored.BasePath != "" {
				cfg.BasePath = stored.BasePath
			}
			if stored.AuthToken != "" {
				cfg.AuthToken = stored.AuthToken
				cfg.AuthTokenSource = AuthTokenSourceConfig
			}
		}
	}
	if v := os.Getenv("ZENNOTES_VAULT_PATH"); v != "" {
		cfg.VaultPath = v
	}
	if v := os.Getenv("ZENNOTES_DEFAULT_VAULT_PATH"); v != "" {
		cfg.DefaultVaultPath = v
	}
	cfg.BrowseRoots = parseListEnv("ZENNOTES_BROWSE_ROOTS")
	cfg.AllowedOrigins = parseListEnv("ZENNOTES_ALLOWED_ORIGINS")
	if v := os.Getenv("ZENNOTES_BIND"); v != "" {
		cfg.Bind = v
	}
	if v := os.Getenv("ZENNOTES_BASE_PATH"); v != "" {
		cfg.BasePath = v
	}
	cfg.BasePath = NormalizeBasePath(cfg.BasePath)
	if v := os.Getenv("ZENNOTES_AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
		cfg.AuthTokenSource = AuthTokenSourceEnv
	} else if path := os.Getenv("ZENNOTES_AUTH_TOKEN_FILE"); path != "" {
		if raw, err := os.ReadFile(path); err == nil {
			cfg.AuthToken = strings.TrimSpace(string(raw))
			if cfg.AuthToken != "" {
				cfg.AuthTokenSource = AuthTokenSourceFile
			}
		}
	}
	cfg.AllowUnscopedBrowse = envEnabled("ZENNOTES_ALLOW_UNSCOPED_BROWSE")
	cfg.AllowInsecureNoAuth = envEnabled("ZENNOTES_ALLOW_INSECURE_NOAUTH")
	cfg.DevMode = envEnabled("ZENNOTES_DEV")
	cfg.DisableWatcher = envEnabled("ZENNOTES_DISABLE_WATCHER")
	cfg.BehindTLS = envEnabled("ZENNOTES_BEHIND_TLS")
	cfg.TrustedProxies = parseCIDRListEnv("ZENNOTES_TRUSTED_PROXIES")
	if v := parseInt64Env("ZENNOTES_MAX_ASSET_BYTES"); v > 0 {
		cfg.MaxAssetBytes = v
	}
	if v := parseInt64Env("ZENNOTES_MAX_NOTE_BYTES"); v > 0 {
		cfg.MaxNoteBytes = v
	}
	if m, ok := parseFileModeEnv("ZENNOTES_VAULT_FILE_MODE"); ok {
		cfg.VaultFileMode = m
	}
	if m, ok := parseFileModeEnv("ZENNOTES_VAULT_DIR_MODE"); ok {
		cfg.VaultDirMode = m
	}
	if cfg.VaultPath == "" {
		if cfg.DefaultVaultPath != "" {
			cfg.VaultPath = cfg.DefaultVaultPath
		} else {
			if home, err := os.UserHomeDir(); err == nil {
				cfg.VaultPath = filepath.Join(home, "ZenNotesVault")
			} else {
				cfg.VaultPath = "./vault"
			}
		}
	}
	return cfg
}

func SaveHost(cfg Config) error {
	target := configFilePath()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(target, out, 0o600)
}

func LegacyVaultConfigPath(vaultRoot string) string {
	return filepath.Join(vaultRoot, ".zennotes", "server.json")
}

func LegacyVaultConfigExists(vaultRoot string) bool {
	_, err := os.Stat(LegacyVaultConfigPath(vaultRoot))
	return err == nil
}

// NormalizeBasePath coerces a raw base-path string into the form the
// server uses everywhere: empty (meaning "serve at root") or a path that
// starts with `/` and has no trailing slash, e.g. "/zennotes". Multiple
// adjacent slashes are collapsed.
func NormalizeBasePath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "/" {
		return ""
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	// Collapse repeated slashes ("/foo//bar" → "/foo/bar").
	for strings.Contains(trimmed, "//") {
		trimmed = strings.ReplaceAll(trimmed, "//", "/")
	}
	trimmed = strings.TrimRight(trimmed, "/")
	if trimmed == "" {
		return ""
	}
	return trimmed
}

func parseListEnv(name string) []string {
	raw := os.Getenv(name)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}

func parseCIDRListEnv(name string) []net.IPNet {
	parts := parseListEnv(name)
	if len(parts) == 0 {
		return nil
	}
	out := make([]net.IPNet, 0, len(parts))
	for _, p := range parts {
		if !strings.Contains(p, "/") {
			if ip := net.ParseIP(p); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				out = append(out, net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
				continue
			}
		}
		if _, n, err := net.ParseCIDR(p); err == nil {
			out = append(out, *n)
		}
	}
	return out
}

func parseInt64Env(name string) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func parseFileModeEnv(name string) (fs.FileMode, bool) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, false
	}
	if !strings.HasPrefix(raw, "0") {
		raw = "0" + raw
	}
	v, err := strconv.ParseUint(raw, 8, 32)
	if err != nil {
		return 0, false
	}
	return fs.FileMode(v), true
}

func envEnabled(name string) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}
