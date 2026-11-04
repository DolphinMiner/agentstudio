package demo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/status"
)

const (
	FlowID             = "demo"
	stepIDDisplayName  = "com.agentstudio.demo.display_name"
	stepIDComplete     = "com.agentstudio.demo.complete"
	defaultDisplayName = "Demo User"
	maxDisplayNameLen  = 100
)

func (c *Connector) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{{
		ID:          FlowID,
		Name:        "Demo",
		Description: "Connect a simulated account with a few deterministic contacts.",
	}}
}

func (c *Connector) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	if flowID != FlowID {
		return nil, fmt.Errorf("unknown login flow %q", flowID)
	}
	return &loginProcess{conn: c, user: user}, nil
}

// loginProcess asks for a display name and completes immediately.
type loginProcess struct {
	conn *Connector
	user *bridgev2.User
}

var _ bridgev2.LoginProcessUserInput = (*loginProcess)(nil)

func (lp *loginProcess) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeUserInput,
		StepID:       stepIDDisplayName,
		Instructions: "Choose the name your demo contacts know you by.",
		UserInputParams: &bridgev2.LoginUserInputParams{
			Fields: []bridgev2.LoginInputDataField{{
				Type:         bridgev2.LoginInputFieldTypeUsername,
				ID:           "display_name",
				Name:         "Display name",
				Description:  "Shown to your simulated contacts",
				DefaultValue: defaultDisplayName,
				MaxLength:    maxDisplayNameLen,
			}},
		},
	}, nil
}

func (lp *loginProcess) Cancel() {}

func (lp *loginProcess) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	name := strings.TrimSpace(input["display_name"])
	if name == "" {
		name = defaultDisplayName
	}
	if len([]rune(name)) > maxDisplayNameLen {
		name = string([]rune(name)[:maxDisplayNameLen])
	}
	ul, err := lp.user.NewLogin(ctx, &database.UserLogin{
		ID:            LoginID(lp.user.MXID),
		RemoteName:    name,
		RemoteProfile: status.RemoteProfile{Name: name},
		Metadata:      &UserLoginMetadata{DisplayName: name, LoginAt: time.Now().UnixMilli()},
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to save login: %w", err)
	}
	// bridgev2 only connects logins on startup; new logins must be connected by the connector.
	go ul.Client.Connect(ul.Log.WithContext(context.Background()))
	return &bridgev2.LoginStep{
		Type:           bridgev2.LoginStepTypeComplete,
		StepID:         stepIDComplete,
		Instructions:   fmt.Sprintf("Connected to Demo as %s", name),
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: ul.ID, UserLogin: ul},
	}, nil
}
