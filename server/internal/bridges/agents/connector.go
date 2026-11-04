// Package agents is the "agentstudio-agents" bridge: a mautrix bridgev2 network
// connector that turns agents speaking the AgentStudio Agent Protocol
// (docs/agent-protocol.md) into Matrix contacts.
//
// Model: one UserLogin per (Matrix user, agent base URL). Each login has one
// agent session, one ghost (agents_<login id>) and one DM portal with that ghost.
// The agent id / connection id registered with agentstudio-api is
// "agentstudio-agents:<login id>".
package agents

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"go.mau.fi/util/configupgrade"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/matrix"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// NetworkID is both the bridge's network id and the m.bridge protocol.id clients classify rooms by.
const NetworkID = "agentstudio-agents"

// AgentIDPrefix prefixes login ids to form agent/connection ids in agentstudio-api.
const AgentIDPrefix = NetworkID + ":"

// Config is the "network:" section of the bridge config. Empty values fall back
// to the environment variables named in the comments.
type Config struct {
	ConciergeURL   string `yaml:"concierge_url"`   // AGENTSTUDIO_CONCIERGE_URL
	APIURL         string `yaml:"api_url"`         // AGENTSTUDIO_SERVER_URL
	InternalSecret string `yaml:"internal_secret"` // AGENTSTUDIO_INTERNAL_SECRET
	PublicURL      string `yaml:"public_url"`      // AGENTS_BRIDGE_URL: base of callback_url
	// AdaptersURL is agentstudio-agent-adapters, which fronts A2A and ACP agents.
	AdaptersURL string `yaml:"adapters_url"` // AGENT_ADAPTERS_URL
	// ACPAgents lists the ACP agents users may pick (same JSON as the adapters).
	ACPAgents string `yaml:"acp_agents"` // AGENTSTUDIO_ACP_AGENTS
}

//go:embed example-config.yaml
var exampleConfig string

func upgradeConfig(helper configupgrade.Helper) {
	for _, key := range []string{"concierge_url", "api_url", "internal_secret", "public_url", "adapters_url", "acp_agents"} {
		helper.Copy(configupgrade.Str|configupgrade.Null, key)
	}
}

func (c *Config) fillFromEnv() {
	fill := func(dst *string, env string) {
		if *dst == "" {
			*dst = os.Getenv(env)
		}
		*dst = strings.TrimRight(*dst, "/")
	}
	fill(&c.ConciergeURL, "AGENTSTUDIO_CONCIERGE_URL")
	fill(&c.APIURL, "AGENTSTUDIO_SERVER_URL")
	fill(&c.InternalSecret, "AGENTSTUDIO_INTERNAL_SECRET")
	fill(&c.PublicURL, "AGENTS_BRIDGE_URL")
	fill(&c.AdaptersURL, "AGENT_ADAPTERS_URL")
	if c.ACPAgents == "" {
		c.ACPAgents = os.Getenv("AGENTSTUDIO_ACP_AGENTS")
	}
}

// callbackSession is what the callback endpoint needs from a login. AgentClient
// implements it; tests use fakes.
type callbackSession interface {
	tokenHash() []byte
	target() *eventTarget
}

// decisionReceiver delivers an approval decision to an agent.
type decisionReceiver interface {
	deliverDecision(ctx context.Context, externalID string, req *agentproto.DecisionRequest) error
}

// Connector implements bridgev2.NetworkConnector.
type Connector struct {
	br     *bridgev2.Bridge
	Config Config
	api    *APIClient
	// HTTP is used for agent calls and avatar downloads.
	HTTP *http.Client

	mu        sync.RWMutex
	callbacks map[string]callbackSession // by callback key

	// findReceiver resolves an agent id to its login. Overridden in tests.
	findReceiver func(ctx context.Context, agentID string) (decisionReceiver, error)
}

var (
	_ bridgev2.NetworkConnector        = (*Connector)(nil)
	_ bridgev2.ConfigValidatingNetwork = (*Connector)(nil)
)

func NewConnector() *Connector {
	c := &Connector{
		HTTP:      &http.Client{Timeout: 15 * time.Second},
		callbacks: make(map[string]callbackSession),
	}
	c.findReceiver = c.findLoginByAgentID
	return c
}

func (c *Connector) Init(br *bridgev2.Bridge) {
	c.br = br
}

func (c *Connector) ValidateConfig() error {
	c.Config.fillFromEnv()
	if c.Config.PublicURL == "" {
		return errors.New("network.public_url (or AGENTS_BRIDGE_URL) is required for agent callbacks")
	} else if c.Config.APIURL == "" || c.Config.InternalSecret == "" {
		return errors.New("network.api_url and network.internal_secret (or AGENTSTUDIO_SERVER_URL / AGENTSTUDIO_INTERNAL_SECRET) are required")
	}
	return nil
}

func (c *Connector) Start(ctx context.Context) error {
	c.Config.fillFromEnv()
	c.api = &APIClient{BaseURL: c.Config.APIURL, Secret: c.Config.InternalSecret, HTTP: c.HTTP}
	mc, ok := c.br.Matrix.(*matrix.Connector)
	if !ok {
		return fmt.Errorf("unexpected matrix connector type %T", c.br.Matrix)
	}
	// The appservice listener (127.0.0.1:18102) also serves our agent-facing routes.
	c.RegisterRoutes(mc.AS.Router)
	return nil
}

func (c *Connector) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{
		DisplayName: "Agents",
		NetworkURL:  "https://github.com/DolphinMiner/agentstudio",
		NetworkID:   NetworkID,
		// BeeperBridgeType becomes m.bridge content.protocol.id, which clients use to classify rooms.
		BeeperBridgeType:     NetworkID,
		DefaultPort:          18102,
		DefaultCommandPrefix: "!agents",
	}
}

func (c *Connector) GetDBMetaTypes() database.MetaTypes {
	return database.MetaTypes{
		UserLogin: func() any { return &UserLoginMetadata{} },
	}
}

func (c *Connector) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}

func (c *Connector) GetConfig() (string, any, configupgrade.Upgrader) {
	return exampleConfig, &c.Config, configupgrade.SimpleUpgrader(upgradeConfig)
}

func (c *Connector) GetBridgeInfoVersion() (info, capabilities int) { return 1, 1 }

func (c *Connector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	client := &AgentClient{conn: c, login: login}
	login.Client = client
	if key := client.meta().CallbackKey; key != "" {
		c.setCallback(key, client)
	}
	return nil
}

func (c *Connector) setCallback(key string, s callbackSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s == nil {
		delete(c.callbacks, key)
	} else {
		c.callbacks[key] = s
	}
}

func (c *Connector) getCallback(key string) callbackSession {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.callbacks[key]
}

func (c *Connector) findLoginByAgentID(ctx context.Context, agentID string) (decisionReceiver, error) {
	loginID, ok := strings.CutPrefix(agentID, AgentIDPrefix)
	if !ok || loginID == "" {
		return nil, nil
	}
	login, err := c.br.GetExistingUserLoginByID(ctx, networkIDLogin(loginID))
	if err != nil || login == nil {
		return nil, err
	}
	client, ok := login.Client.(*AgentClient)
	if !ok {
		return nil, nil
	}
	return client, nil
}

func (c *Connector) callbackURL(key string) string {
	return c.Config.PublicURL + "/agentstudio/v0/callback/" + key
}
