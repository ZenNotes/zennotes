package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	VaultPath         string   `json:"vaultPath"`
	DefaultVaultPath  string   `json:"-"`
	BrowseRoots       []string `json:"-"`
	Bind              string   `json:"bind"`
	AuthToken         string   `json:"authToken"`
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
	if v := os.Getenv("ZENNOTES_BROWSE_ROOTS"); v != "" {
		parts := strings.Split(v, ",")
		cfg.BrowseRoots = make([]string, 0, len(parts))
		for _, part := range parts {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				cfg.BrowseRoots = append(cfg.BrowseRoots, trimmed)
			}
		}
	}
	if v := os.Getenv("ZENNOTES_BIND"); v != "" {
		cfg.Bind = v
	}
	if v := os.Getenv("ZENNOTES_AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
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
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(target, out, 0o644)
}

// Save writes the effective config inside the vault, for transparency.
func Save(cfg Config, vaultRoot string) error {
	dir := filepath.Join(vaultRoot, ".zennotes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "server.json"), out, 0o644)
}
