package demo

import (
	"context"
	"time"

	"go.mau.fi/util/configupgrade"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
)

// Connector is the bridgev2 NetworkConnector for the demo network.
type Connector struct {
	br *bridgev2.Bridge
	// EchoDelay is how long a ghost waits before replying to the user (default 300 ms).
	EchoDelay time.Duration
}

var _ bridgev2.NetworkConnector = (*Connector)(nil)

// NewConnector returns a demo connector with the documented reply delay.
func NewConnector() *Connector {
	return &Connector{EchoDelay: 300 * time.Millisecond}
}

func (c *Connector) Init(br *bridgev2.Bridge)        { c.br = br }
func (c *Connector) Start(ctx context.Context) error { return nil }

func (c *Connector) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{
		DisplayName: "Demo",
		NetworkURL:  "https://github.com/DolphinMiner/agentstudio",
		NetworkID:   "demo",
		// BeeperBridgeType becomes m.bridge content.protocol.id, which clients use to classify rooms.
		BeeperBridgeType: "demo",
		DefaultPort:      18101,
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

// GetConfig: the demo network has no network-specific config.
func (c *Connector) GetConfig() (string, any, configupgrade.Upgrader) { return "", nil, nil }

func (c *Connector) GetBridgeInfoVersion() (info, capabilities int) { return 1, 1 }

func (c *Connector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	login.Client = &Client{conn: c, login: login}
	return nil
}
