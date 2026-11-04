package agents

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/status"

	"github.com/DolphinMiner/agentstudio/server/internal/adapters/a2a"
	"github.com/DolphinMiner/agentstudio/server/internal/adapters/acp"
	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

const (
	FlowConcierge = "concierge"
	FlowEndpoint  = "endpoint"
	FlowA2A       = "a2a"
	FlowACP       = "acp"

	stepEndpointInput = "com.agentstudio.agents.endpoint"
	stepA2AInput      = "com.agentstudio.agents.a2a"
	stepACPInput      = "com.agentstudio.agents.acp"
	stepComplete      = "com.agentstudio.agents.complete"
)

func (c *Connector) GetLoginFlows() []bridgev2.LoginFlow {
	flows := []bridgev2.LoginFlow{{
		ID:          FlowEndpoint,
		Name:        "Agent endpoint",
		Description: "Connect any agent that speaks the AgentStudio Agent Protocol.",
	}}
	if c.Config.AdaptersURL != "" {
		flows = append(flows, bridgev2.LoginFlow{
			ID:          FlowA2A,
			Name:        "A2A agent",
			Description: "Connect an agent that speaks A2A (Agent2Agent), such as Hermes Agent.",
		})
		if len(c.acpAgents()) > 0 {
			flows = append(flows, bridgev2.LoginFlow{
				ID:          FlowACP,
				Name:        "ACP agent",
				Description: "Run an agent that speaks ACP (Agent Client Protocol) on the server.",
			})
		}
	}
	if c.Config.ConciergeURL != "" {
		flows = append([]bridgev2.LoginFlow{{
			ID:          FlowConcierge,
			Name:        "Concierge",
			Description: "AgentStudio's built-in reference agent.",
		}}, flows...)
	}
	return flows
}

func (c *Connector) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	switch flowID {
	case FlowConcierge:
		if c.Config.ConciergeURL == "" {
			return nil, errors.New("the concierge is not configured")
		}
		return &conciergeLogin{c: c, user: user}, nil
	case FlowEndpoint:
		return &endpointLogin{c: c, user: user}, nil
	case FlowA2A:
		if c.Config.AdaptersURL == "" {
			return nil, errors.New("A2A agents are not enabled on this server")
		}
		return &a2aLogin{c: c, user: user}, nil
	case FlowACP:
		if c.Config.AdaptersURL == "" || len(c.acpAgents()) == 0 {
			return nil, errors.New("ACP agents are not enabled on this server")
		}
		return &acpLogin{c: c, user: user}, nil
	}
	return nil, fmt.Errorf("unknown login flow %q", flowID)
}

type conciergeLogin struct {
	c    *Connector
	user *bridgev2.User
}

var _ bridgev2.LoginProcess = (*conciergeLogin)(nil)

func (l *conciergeLogin) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return l.c.connectAgent(ctx, l.user, FlowConcierge, l.c.Config.ConciergeURL, "")
}

func (l *conciergeLogin) Cancel() {}

type endpointLogin struct {
	c    *Connector
	user *bridgev2.User
}

var _ bridgev2.LoginProcessUserInput = (*endpointLogin)(nil)

func (l *endpointLogin) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeUserInput,
		StepID:       stepEndpointInput,
		Instructions: "Enter the agent's base URL and, if it needs one, its access token.",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{
			Type:        bridgev2.LoginInputFieldTypeURL,
			ID:          "url",
			Name:        "Agent URL",
			Description: "For example https://agent.example.com",
			Validate:    agentproto.NormalizeBaseURL,
		}, {
			Type:        bridgev2.LoginInputFieldTypeToken,
			ID:          "token",
			Name:        "Access token",
			Description: "Optional. Sent to the agent as a bearer token.",
			Optional:    true,
		}}},
	}, nil
}

func (l *endpointLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	return l.c.connectAgent(ctx, l.user, FlowEndpoint, input["url"], input["token"])
}

func (l *endpointLogin) Cancel() {}

type a2aLogin struct {
	c    *Connector
	user *bridgev2.User
}

var _ bridgev2.LoginProcessUserInput = (*a2aLogin)(nil)

func (l *a2aLogin) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeUserInput,
		StepID:       stepA2AInput,
		Instructions: "Enter the A2A agent's URL (where its agent card is served) and, if it needs one, its access token.",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{
			Type:        bridgev2.LoginInputFieldTypeURL,
			ID:          "url",
			Name:        "Agent URL",
			Description: "For example https://agent.example.com",
			Validate:    agentproto.NormalizeBaseURL,
		}, {
			Type:        bridgev2.LoginInputFieldTypeToken,
			ID:          "token",
			Name:        "Access token",
			Description: "Optional. Sent to the agent as a bearer token.",
			Optional:    true,
		}}},
	}, nil
}

func (l *a2aLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	target, err := agentproto.NormalizeBaseURL(input["url"])
	if err != nil {
		return nil, loginError("COM.AGENTSTUDIO.AGENTS.BAD_URL", "Invalid agent URL", err)
	}
	return l.c.connectAgent(ctx, l.user, FlowA2A, l.c.Config.AdaptersURL+"/a2a/"+a2a.EncodeTarget(target), input["token"])
}

func (l *a2aLogin) Cancel() {}

type acpLogin struct {
	c    *Connector
	user *bridgev2.User
}

var _ bridgev2.LoginProcessUserInput = (*acpLogin)(nil)

func (l *acpLogin) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	var names []string
	for _, a := range l.c.acpAgents() {
		names = append(names, a.ID)
	}
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeUserInput,
		StepID:       stepACPInput,
		Instructions: "Pick the ACP agent to run.",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{
			Type:         bridgev2.LoginInputFieldTypeSelect,
			ID:           "agent",
			Name:         "Agent",
			Options:      names,
			DefaultValue: names[0],
		}}},
	}, nil
}

func (l *acpLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	for _, a := range l.c.acpAgents() {
		if a.ID == input["agent"] {
			return l.c.connectAgent(ctx, l.user, FlowACP, l.c.Config.AdaptersURL+"/acp/"+url.PathEscape(a.ID), "")
		}
	}
	return nil, loginError("COM.AGENTSTUDIO.AGENTS.UNKNOWN_AGENT", "Unknown agent", errors.New(input["agent"]))
}

func (l *acpLogin) Cancel() {}

func (c *Connector) acpAgents() []acp.AgentSpec {
	specs, err := acp.ParseAgents(c.Config.ACPAgents)
	if err != nil {
		return nil
	}
	return specs
}

// loginError is shown to the user by the provisioning API.
func loginError(code, msg string, err error) error {
	return bridgev2.RespError{ErrCode: code, Err: fmt.Sprintf("%s: %v", msg, err), StatusCode: 400}
}

// connectAgent runs the handshake (GET info, POST sessions), stores the login,
// creates the DM portal and registers the agent with agentstudio-api.
func (c *Connector) connectAgent(ctx context.Context, user *bridgev2.User, flow, rawURL, token string) (*bridgev2.LoginStep, error) {
	baseURL, err := agentproto.NormalizeBaseURL(rawURL)
	if err != nil {
		return nil, loginError("COM.AGENTSTUDIO.AGENTS.BAD_URL", "Invalid agent URL", err)
	}
	loginID := LoginIDFor(user.MXID, baseURL)
	meta := &UserLoginMetadata{Flow: flow, BaseURL: baseURL, AgentToken: token}
	// Connecting the same agent again reuses the old session (as a resume hint) and callback key.
	if existing, _ := c.br.GetExistingUserLoginByID(ctx, loginID); existing != nil && existing.UserMXID == user.MXID {
		if old, ok := existing.Client.(*AgentClient); ok {
			m := old.snapshot()
			meta.SessionID, meta.CallbackKey, meta.RoomID, meta.Approvals = m.SessionID, m.CallbackKey, m.RoomID, m.Approvals
		}
	}
	// Handshake before storing anything, so an unreachable agent leaves no login behind.
	res, err := c.registerSession(ctx, user.MXID, meta)
	if err != nil {
		return nil, loginError("COM.AGENTSTUDIO.AGENTS.UNREACHABLE", "Couldn't connect to the agent", err)
	}
	meta.apply(res)
	// NewLogin calls LoadUserLogin, which registers the callback key.
	ul, err := user.NewLogin(ctx, &database.UserLogin{
		ID:            loginID,
		RemoteName:    meta.Info.Name,
		RemoteProfile: status.RemoteProfile{Name: meta.Info.Name},
		Metadata:      meta,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to save login: %w", err)
	}
	ul.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
	// Create the room and register the agent before completing, so clients can open it right away.
	client := ul.Client.(*AgentClient)
	bgCtx := ul.Log.WithContext(c.br.BackgroundCtx)
	roomID, err := client.ensurePortal(bgCtx)
	if err != nil {
		ul.Log.Err(err).Msg("Failed to create agent room after login")
		return nil, fmt.Errorf("connected, but failed to create the agent room: %w", err)
	}
	if err = client.registerAgent(ctx, roomID); err != nil {
		// Don't fail the login over it: the room exists, keep retrying in the background.
		ul.Log.Warn().Err(err).Msg("Agent registration failed, retrying in the background")
		go func() {
			if err := client.syncPortalAndAgent(bgCtx); err != nil {
				ul.Log.Err(err).Msg("Giving up on agent registration")
			}
		}()
	}
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeComplete,
		StepID:       stepComplete,
		Instructions: "Connected to " + meta.Info.Name,
		CompleteParams: &bridgev2.LoginCompleteParams{
			UserLoginID: ul.ID,
			UserLogin:   ul,
		},
	}, nil
}
