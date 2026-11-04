// Command agentstudio-bridge-demo is the AgentStudio "demo" bridge: a mautrix bridgev2 bridge for a
// simulated, deterministic chat network (docs/matrix-events.md "Demo network").
//
// Run: agentstudio-bridge-demo -n -c .local/bridges/demo.yaml -r .local/synapse/registration-demo.yaml
//
// With AGENTSTUDIO_DEV=1 and AGENTSTUDIO_INTERNAL_SECRET set, the dev hook
// POST /agentstudio/dev/v1/incoming is served on the appservice listener (port 18101).
package main

import (
	"os"

	"maunium.net/go/mautrix/bridgev2/matrix/mxmain"

	"github.com/DolphinMiner/agentstudio/server/internal/bridges/demo"
)

func main() {
	conn := demo.NewConnector()
	m := mxmain.BridgeMain{
		Name:        "agentstudio-bridge-demo",
		Description: "AgentStudio demo network bridge",
		URL:         "https://github.com/DolphinMiner/agentstudio",
		Version:     "0.1.0",
		Connector:   conn,
	}
	m.PostInit = func() {
		if os.Getenv("AGENTSTUDIO_DEV") == "1" {
			secret := os.Getenv("AGENTSTUDIO_INTERNAL_SECRET")
			if secret == "" {
				m.Log.Warn().Msg("AGENTSTUDIO_DEV=1 but AGENTSTUDIO_INTERNAL_SECRET is empty, dev hooks disabled")
				return
			}
			conn.RegisterDevRoutes(m.Matrix.AS.Router, secret)
			m.Log.Info().Str("path", demo.DevIncomingPath).Msg("Dev hooks enabled")
		}
	}
	m.InitVersion("", "", "")
	m.Run()
}
