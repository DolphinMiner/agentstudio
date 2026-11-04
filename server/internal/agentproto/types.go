// Package agentproto holds the wire types and small HTTP helpers for the
// AgentStudio Agent Protocol v0 (docs/agent-protocol.md). It is shared by the
// agents bridge (bridge side) and the concierge reference agent (agent side).
package agentproto

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

// ProtocolVersion is the value of AgentInfo.Protocol.
const ProtocolVersion = "agentstudio-agent/0"

// HeaderSession carries the session id on every bridge -> agent call.
const HeaderSession = "X-AgentStudio-Session"

// Limits from docs/agent-protocol.md and docs/matrix-events.md, plus a few
// sanity caps that keep a misbehaving agent from flooding a room.
const (
	MaxAskLines      = 5
	MaxAskLineText   = 2000
	MinDrafts        = 1
	MaxDrafts        = 5
	MinChoices       = 2
	MaxChoices       = 4
	MaxTextLength    = 20000 // message text, drafts, titles, summaries
	MaxDetails       = 20
	MaxIDLength      = 200 // external_id, task_id, choice keys
	MaxEventBodySize = 256 << 10
)

type Capability string

const (
	CapabilityChat      Capability = "chat"
	CapabilityAsk       Capability = "ask"
	CapabilityApprovals Capability = "approvals"
)

// AgentInfo is returned by GET {base}/agentstudio/v0/info.
type AgentInfo struct {
	Name         string       `json:"name"`
	Description  string       `json:"description,omitempty"`
	AvatarURL    string       `json:"avatar_url,omitempty"`
	Capabilities []Capability `json:"capabilities"`
	Protocol     string       `json:"protocol"`
}

func (ai *AgentInfo) Validate() error {
	if ai.Name == "" {
		return errors.New("name is required")
	} else if utf8.RuneCountInString(ai.Name) > 100 {
		return errors.New("name is too long")
	} else if ai.Protocol != ProtocolVersion {
		return fmt.Errorf("unsupported protocol %q (want %q)", ai.Protocol, ProtocolVersion)
	}
	for _, c := range ai.Capabilities {
		switch c {
		case CapabilityChat, CapabilityAsk, CapabilityApprovals:
		default:
			return fmt.Errorf("unknown capability %q", c)
		}
	}
	return nil
}

// SessionUser describes the AgentStudio user in a session request.
type SessionUser struct {
	DisplayName string `json:"display_name"`
}

// CreateSessionRequest is the body of POST {base}/agentstudio/v0/sessions.
type CreateSessionRequest struct {
	CallbackURL   string      `json:"callback_url"`
	CallbackToken string      `json:"callback_token"`
	User          SessionUser `json:"user"`
	// SessionID is set when the bridge re-registers a session it already had
	// (for example after a bridge restart). Agents may resume that session and
	// return the same id, or ignore it and return a new one.
	SessionID string `json:"session_id,omitempty"`
}

// CreateSessionResponse is the reply to POST /sessions.
type CreateSessionResponse struct {
	SessionID string `json:"session_id"`
}

// AskLine is one line of origin-chat context in an ask.
type AskLine struct {
	Speaker string `json:"speaker"`
	Own     bool   `json:"own"`
	TS      int64  `json:"ts"`
	Text    string `json:"text"`
}

// Ask is the "Ask an agent" payload of an inbound message.
type Ask struct {
	TaskID  string    `json:"task_id"`
	App     string    `json:"app"`
	Chat    string    `json:"chat"`
	Request string    `json:"request"`
	Lines   []AskLine `json:"lines"`
}

func (a *Ask) Validate() error {
	if a.TaskID == "" {
		return errors.New("ask.task_id is required")
	} else if len(a.TaskID) > MaxIDLength {
		return errors.New("ask.task_id is too long")
	} else if len(a.Lines) > MaxAskLines {
		return fmt.Errorf("ask.lines has more than %d entries", MaxAskLines)
	}
	for i, l := range a.Lines {
		if utf8.RuneCountInString(l.Text) > MaxAskLineText {
			return fmt.Errorf("ask.lines[%d].text is longer than %d characters", i, MaxAskLineText)
		}
	}
	return nil
}

// InboundMessage is the body of POST {base}/agentstudio/v0/messages.
type InboundMessage struct {
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id"`
	Text      string `json:"text"`
	SentAt    string `json:"sent_at"`
	Ask       *Ask   `json:"ask,omitempty"`
}

func (m *InboundMessage) Validate() error {
	if m.SessionID == "" || m.MessageID == "" {
		return errors.New("session_id and message_id are required")
	}
	if m.Ask != nil {
		return m.Ask.Validate()
	}
	return nil
}

// DecisionRequest is the body of POST {base}/agentstudio/v0/approvals/{external_id}/decision.
type DecisionRequest struct {
	ApprovalID string `json:"approval_id"`
	Choice     string `json:"choice"`
}
