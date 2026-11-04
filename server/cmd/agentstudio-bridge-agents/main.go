// Command agentstudio-bridge-agents is the AgentStudio "agentstudio-agents" bridge, built on
// mautrix bridgev2. It connects agents that speak the AgentStudio Agent Protocol
// (docs/agent-protocol.md) and serves the agent callback and approval decision
// routes on its appservice listener.
//
// Run: agentstudio-bridge-agents -n -c .local/bridges/agents.yaml -r .local/synapse/registration-agents.yaml
package main

import (
	"maunium.net/go/mautrix/bridgev2/matrix/mxmain"

	"github.com/DolphinMiner/agentstudio/server/internal/bridges/agents"
)

func main() {
	m := mxmain.BridgeMain{
		Name:        "agentstudio-bridge-agents",
		Description: "AgentStudio bridge for agents speaking the AgentStudio Agent Protocol",
		URL:         "https://github.com/DolphinMiner/agentstudio",
		Version:     "0.1.0",
		Connector:   agents.NewConnector(),
	}
	m.InitVersion("", "", "")
	m.Run()
}
