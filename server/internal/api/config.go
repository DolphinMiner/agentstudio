// Package api implements the AgentStudio REST API (docs/api.md): email-code auth,
// sessions with per-session Matrix credentials, the /_matrix reverse proxy,
// bridge provisioning, agents, approvals, tasks and the internal bridge API.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config is read from the environment (see dev/README.md for the variables).
type Config struct {
	Addr           string // AGENTSTUDIO_API_ADDR
	ServerURL      string // AGENTSTUDIO_SERVER_URL, the public base URL clients use
	DatabaseURL    string // AGENTSTUDIO_DATABASE_URL
	SynapseURL     string // SYNAPSE_URL
	ServerName     string // MATRIX_SERVER_NAME
	Dev            bool   // AGENTSTUDIO_DEV=1
	Local          bool   // AGENTSTUDIO_LOCAL=1: the API serves one person on their own Mac (see handleLocalSignIn)
	TokenSecret    []byte // AGENTSTUDIO_TOKEN_SECRET
	InternalSecret string // AGENTSTUDIO_INTERNAL_SECRET
	SynapseJWT     []byte // SYNAPSE_JWT_SECRET
	AllowedOrigins []string
	Bridges        []BridgeConfig
}

// BridgeConfig describes one bridge the API talks to (built-in or from
// AGENTSTUDIO_EXTRA_BRIDGES).
type BridgeConfig struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"` // "chat" | "agent"
	BotMXID         string `json:"bot_mxid"`
	ProvisionURL    string `json:"provision_url"` // bridge base URL; /_matrix/provision/v3 is appended
	ProvisionSecret string `json:"provision_secret"`
	ASToken         string `json:"as_token"` // authenticates bridge-state posts
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ConfigFromEnv builds the configuration and validates required secrets.
func ConfigFromEnv() (*Config, error) {
	c := &Config{
		Addr:           envOr("AGENTSTUDIO_API_ADDR", "127.0.0.1:18090"),
		ServerURL:      strings.TrimRight(envOr("AGENTSTUDIO_SERVER_URL", "http://127.0.0.1:18090"), "/"),
		DatabaseURL:    os.Getenv("AGENTSTUDIO_DATABASE_URL"),
		SynapseURL:     strings.TrimRight(envOr("SYNAPSE_URL", "http://127.0.0.1:18008"), "/"),
		ServerName:     envOr("MATRIX_SERVER_NAME", "agentstudio.local"),
		Dev:            os.Getenv("AGENTSTUDIO_DEV") == "1",
		Local:          os.Getenv("AGENTSTUDIO_LOCAL") == "1",
		TokenSecret:    []byte(os.Getenv("AGENTSTUDIO_TOKEN_SECRET")),
		InternalSecret: os.Getenv("AGENTSTUDIO_INTERNAL_SECRET"),
		SynapseJWT:     []byte(os.Getenv("SYNAPSE_JWT_SECRET")),
	}
	for _, o := range strings.Split(os.Getenv("AGENTSTUDIO_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	var missing []string
	for k, v := range map[string]string{
		"AGENTSTUDIO_DATABASE_URL":    c.DatabaseURL,
		"AGENTSTUDIO_TOKEN_SECRET":    string(c.TokenSecret),
		"AGENTSTUDIO_INTERNAL_SECRET": c.InternalSecret,
		"SYNAPSE_JWT_SECRET":          string(c.SynapseJWT),
	} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}
	c.Bridges = []BridgeConfig{
		{
			ID: "demo", Name: "Demo", Kind: "chat",
			BotMXID:         "@demobot:" + c.ServerName,
			ProvisionURL:    envOr("DEMO_BRIDGE_URL", "http://127.0.0.1:18101"),
			ProvisionSecret: os.Getenv("DEMO_PROVISION_SECRET"),
			ASToken:         os.Getenv("DEMO_AS_TOKEN"),
		},
		{
			ID: "agentstudio-agents", Name: "Agents", Kind: "agent",
			BotMXID:         "@agentsbot:" + c.ServerName,
			ProvisionURL:    envOr("AGENTS_BRIDGE_URL", "http://127.0.0.1:18102"),
			ProvisionSecret: os.Getenv("AGENTS_PROVISION_SECRET"),
			ASToken:         os.Getenv("AGENTS_AS_TOKEN"),
		},
	}
	extra, err := parseExtraBridges(os.Getenv("AGENTSTUDIO_EXTRA_BRIDGES"))
	if err != nil {
		return nil, err
	}
	c.Bridges = append(c.Bridges, extra...)
	return c, nil
}

func parseExtraBridges(raw string) ([]BridgeConfig, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []BridgeConfig
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("AGENTSTUDIO_EXTRA_BRIDGES: %w", err)
	}
	for _, b := range out {
		if b.ID == "" || b.ProvisionURL == "" || b.BotMXID == "" {
			return nil, errors.New("AGENTSTUDIO_EXTRA_BRIDGES: id, bot_mxid and provision_url are required")
		}
		if b.Kind != "chat" && b.Kind != "agent" {
			return nil, fmt.Errorf("AGENTSTUDIO_EXTRA_BRIDGES: bridge %q: kind must be chat or agent", b.ID)
		}
	}
	return out, nil
}

// AgentsBridge returns the agentstudio-agents bridge config.
func (c *Config) AgentsBridge() *BridgeConfig { return c.Bridge("agentstudio-agents") }

// Bridge looks a bridge up by network id.
func (c *Config) Bridge(id string) *BridgeConfig {
	for i := range c.Bridges {
		if c.Bridges[i].ID == id {
			return &c.Bridges[i]
		}
	}
	return nil
}

// MatrixUserID returns the full Matrix ID for a localpart.
func (c *Config) MatrixUserID(localpart string) string {
	return "@" + localpart + ":" + c.ServerName
}
