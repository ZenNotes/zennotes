package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	VaultPath            string   `json:"vaultPath"`
	DefaultVaultPath     string   `json:"-"`
	BrowseRoots          []string `json:"-"`
	AllowedOrigins       []string `json:"-"`
	Bind                 string   `json:"bind"`
	AuthToken            string   `json:"authToken"`
	AllowUnscopedBrowse  bool     `json:"-"`
	AllowInsecureNoAuth  bool     `json:"-"`
	DevMode              bool     `json:"-"`
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
		Bind: "127.0.0.1:7878",
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
			if stored.AuthToken != "" {
				cfg.AuthToken = stored.AuthToken
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
	if v := os.Getenv("ZENNOTES_AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
	}
	cfg.AllowUnscopedBrowse = envEnabled("ZENNOTES_ALLOW_UNSCOPED_BROWSE")
	cfg.AllowInsecureNoAuth = envEnabled("ZENNOTES_ALLOW_INSECURE_NOAUTH")
	cfg.DevMode = envEnabled("ZENNOTES_DEV")
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
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
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

func envEnabled(name string) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}
