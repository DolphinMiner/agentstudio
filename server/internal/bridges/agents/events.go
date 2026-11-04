package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// Content keys from docs/matrix-events.md.
const (
	KeyAsk      = "com.agentstudio.ask"
	KeyDrafts   = "com.agentstudio.drafts"
	KeyApproval = "com.agentstudio.approval"
	// KeyFromUser marks what the user said in the service's own app; KeyVia names it.
	KeyFromUser = "com.agentstudio.from_user"
	KeyVia      = "com.agentstudio.via"
	// KeyHistory marks earlier conversation imported on connect (clients don't notify).
	KeyHistory = "com.agentstudio.history"
)

// approvalRef remembers which approval and card belong to an agent's external_id.
type approvalRef struct {
	ExternalID string `json:"external_id"`
	ApprovalID string `json:"approval_id"`
	EventID    string `json:"event_id,omitempty"`
}

// eventTarget is everything applyEvent needs to act on one agent session.
// AgentClient builds it from a UserLogin; tests build it by hand.
type eventTarget struct {
	AgentID   string
	OwnerMXID string
	// Send posts a message from the agent ghost into the agent's DM and returns its event and room ids.
	// A zero ts means now.
	Send func(ctx context.Context, content *event.MessageEventContent, extra map[string]any, replyTo string, ts time.Time) (id.EventID, id.RoomID, error)
	// SendFile uploads a file and posts it (as an image when it is one), like Send.
	SendFile func(ctx context.Context, data []byte, name, mimeType string, extra map[string]any, ts time.Time) (id.EventID, error)
	// GetApproval and PutApproval keep external_id -> approval mappings.
	GetApproval func(externalID string) *approvalRef
	PutApproval func(ref approvalRef)
	// UpdateProfile changes the agent's name and/or avatar (ghost profile and API record).
	UpdateProfile func(ctx context.Context, name, avatarURL string) error
}

// errUpstream marks failures the agent may retry (we answer 502).
type errUpstream struct{ error }

func (e errUpstream) Unwrap() error { return e.error }

// applyEvent performs what docs/agent-protocol.md says the bridge does with each event.
func (c *Connector) applyEvent(ctx context.Context, t *eventTarget, evt *agentproto.AgentEvent) error {
	log := zerolog.Ctx(ctx).With().Str("agent_id", t.AgentID).Str("event_type", string(evt.Type)).Logger()
	switch evt.Type {
	case agentproto.EventMessage:
		return c.applyMessage(ctx, log, t, evt.Message)
	case agentproto.EventDrafts:
		d := evt.Drafts
		content, extra := draftsContent(d)
		eventID, _, err := t.Send(ctx, content, extra, "", time.Time{})
		if err != nil {
			return errUpstream{fmt.Errorf("failed to send drafts: %w", err)}
		}
		// The drafts are visible in the room either way; a failed answer only leaves the task pending.
		if err = c.api.AnswerTask(ctx, d.TaskID, &TaskAnswer{EventID: eventID.String(), Drafts: d.Drafts}); err != nil {
			log.Warn().Err(err).Str("task_id", d.TaskID).Msg("Failed to mark task answered")
		}
	case agentproto.EventApprovalRequest:
		return c.applyApprovalRequest(ctx, log, t, evt.ApprovalRequest)
	case agentproto.EventApprovalCancel:
		ref := t.GetApproval(evt.ApprovalCancel.ExternalID)
		if ref == nil {
			log.Debug().Str("external_id", evt.ApprovalCancel.ExternalID).Msg("Cancel for unknown approval, ignoring")
			return nil
		}
		if err := c.api.PatchApproval(ctx, ref.ApprovalID, &ApprovalPatch{State: "cancelled"}); err != nil {
			return errUpstream{fmt.Errorf("failed to cancel approval: %w", err)}
		}
	case agentproto.EventStatus:
		text := evt.Status.Text
		if err := c.api.PatchAgent(ctx, t.AgentID, &AgentPatch{Status: string(evt.Status.State), StatusText: &text}); err != nil {
			return errUpstream{fmt.Errorf("failed to update agent status: %w", err)}
		}
	case agentproto.EventProfile:
		if t.UpdateProfile == nil {
			return nil
		}
		if err := t.UpdateProfile(ctx, evt.Profile.Name, evt.Profile.AvatarURL); err != nil {
			return errUpstream{fmt.Errorf("failed to update agent profile: %w", err)}
		}
	default:
		return fmt.Errorf("unknown event type %q", evt.Type)
	}
	return nil
}

func (c *Connector) applyMessage(ctx context.Context, log zerolog.Logger, t *eventTarget, m *agentproto.MessageEvent) error {
	extra := map[string]any{}
	if m.FromUser {
		extra[KeyFromUser] = true
		if m.Via != "" {
			extra[KeyVia] = m.Via
		}
	}
	if m.History {
		extra[KeyHistory] = true
	}
	if len(extra) == 0 {
		extra = nil
	}
	ts := m.Time()
	if m.Text != "" {
		if _, _, err := t.Send(ctx, &event.MessageEventContent{MsgType: event.MsgText, Body: m.Text}, extra, m.ReplyTo, ts); err != nil {
			return errUpstream{fmt.Errorf("failed to send message: %w", err)}
		}
	}
	for _, a := range m.Attachments {
		name := a.Name
		if name == "" {
			name = path.Base(a.URL)
		}
		data, mimeType, err := c.downloadFile(ctx, a.URL)
		if err == nil {
			if a.MimeType != "" {
				mimeType = a.MimeType
			}
			_, err = t.SendFile(ctx, data, name, mimeType, extra, ts)
		}
		if err != nil {
			// The file couldn't come over: a link is better than nothing.
			log.Warn().Err(err).Str("name", name).Msg("Failed to bring an attachment over, sending a link")
			if _, _, err := t.Send(ctx, &event.MessageEventContent{MsgType: event.MsgText, Body: fmt.Sprintf("📎 %s: %s", name, a.URL)}, extra, "", ts); err != nil {
				return errUpstream{fmt.Errorf("failed to send attachment link: %w", err)}
			}
		}
	}
	return nil
}

func (c *Connector) applyApprovalRequest(ctx context.Context, log zerolog.Logger, t *eventTarget, ar *agentproto.ApprovalRequestEvent) error {
	if ref := t.GetApproval(ar.ExternalID); ref != nil && ref.EventID != "" {
		// The agent retried an approval we already carded; the API call is idempotent anyway.
		return nil
	}
	req := &ApprovalCreate{
		OwnerMXID:  t.OwnerMXID,
		AgentID:    t.AgentID,
		ExternalID: ar.ExternalID,
		Title:      ar.Title,
		Summary:    ar.Summary,
		Details:    ar.Details,
		Choices:    ar.Choices,
	}
	if req.Details == nil {
		req.Details = []agentproto.Detail{}
	}
	if ar.ExpiresInSeconds > 0 {
		req.ExpiresAt = time.Now().UTC().Add(time.Duration(ar.ExpiresInSeconds) * time.Second).Format(time.RFC3339)
	}
	approvalID, err := c.api.CreateApproval(ctx, req)
	if err != nil {
		return errUpstream{fmt.Errorf("failed to create approval: %w", err)}
	}
	t.PutApproval(approvalRef{ExternalID: ar.ExternalID, ApprovalID: approvalID})
	content := &event.MessageEventContent{MsgType: event.MsgText, Body: "Approval needed: " + ar.Title}
	extra := map[string]any{KeyApproval: map[string]any{"v": 1, "approval_id": approvalID}}
	eventID, roomID, err := t.Send(ctx, content, extra, "", time.Time{})
	if err != nil {
		return errUpstream{fmt.Errorf("failed to send approval card: %w", err)}
	}
	t.PutApproval(approvalRef{ExternalID: ar.ExternalID, ApprovalID: approvalID, EventID: eventID.String()})
	if err = c.api.PatchApproval(ctx, approvalID, &ApprovalPatch{RoomID: roomID.String(), EventID: eventID.String()}); err != nil {
		log.Warn().Err(err).Str("approval_id", approvalID).Msg("Failed to attach card to approval")
	}
	return nil
}

func draftsContent(d *agentproto.DraftsEvent) (*event.MessageEventContent, map[string]any) {
	var body strings.Builder
	if d.Text != "" {
		body.WriteString(d.Text)
	} else if len(d.Drafts) == 1 {
		body.WriteString("Here is a draft:")
	} else {
		fmt.Fprintf(&body, "Here are %d drafts:", len(d.Drafts))
	}
	for i, dr := range d.Drafts {
		fmt.Fprintf(&body, "\n%d. %s", i+1, dr.Text)
	}
	drafts := make([]map[string]string, len(d.Drafts))
	for i, dr := range d.Drafts {
		drafts[i] = map[string]string{"text": dr.Text}
	}
	return &event.MessageEventContent{MsgType: event.MsgNotice, Body: body.String()},
		map[string]any{KeyDrafts: map[string]any{"v": 1, "task_id": d.TaskID, "drafts": drafts}}
}

// askContent is the com.agentstudio.ask object as clients send it.
type askContent struct {
	V int `json:"v"`
	agentproto.Ask
}

// buildInbound converts a user's Matrix message into an InboundMessage.
// Ask context is trimmed to the documented limits rather than rejected.
func buildInbound(sessionID string, evt *event.Event, content *event.MessageEventContent) (*agentproto.InboundMessage, error) {
	msg := &agentproto.InboundMessage{
		SessionID: sessionID,
		MessageID: evt.ID.String(),
		Text:      content.Body,
		SentAt:    time.UnixMilli(evt.Timestamp).UTC().Format(time.RFC3339),
	}
	if evt.Timestamp == 0 {
		msg.SentAt = time.Now().UTC().Format(time.RFC3339)
	}
	rawAsk, ok := evt.Content.Raw[KeyAsk]
	if !ok || rawAsk == nil {
		return msg, nil
	}
	data, err := json.Marshal(rawAsk)
	if err != nil {
		return nil, err
	}
	var ask askContent
	if err = json.Unmarshal(data, &ask); err != nil {
		return nil, fmt.Errorf("invalid %s content: %w", KeyAsk, err)
	}
	if ask.TaskID == "" {
		return nil, fmt.Errorf("invalid %s content: task_id is missing", KeyAsk)
	}
	if n := len(ask.Lines); n > agentproto.MaxAskLines {
		ask.Lines = ask.Lines[n-agentproto.MaxAskLines:] // keep the newest, including the anchor
	}
	for i := range ask.Lines {
		ask.Lines[i].Text = truncateRunes(ask.Lines[i].Text, agentproto.MaxAskLineText)
	}
	if ask.Lines == nil {
		ask.Lines = []agentproto.AskLine{}
	}
	msg.Ask = &ask.Ask
	return msg, msg.Validate()
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}
