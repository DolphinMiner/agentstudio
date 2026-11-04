package agentproto

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
	"unicode/utf8"
)

// EventType is the "type" discriminator of an AgentEvent.
type EventType string

const (
	EventMessage         EventType = "message"
	EventDrafts          EventType = "drafts"
	EventApprovalRequest EventType = "approval_request"
	EventApprovalCancel  EventType = "approval_cancel"
	EventStatus          EventType = "status"
	EventProfile         EventType = "profile"
)

type MessageEvent struct {
	Text    string `json:"text"`
	ReplyTo string `json:"reply_to,omitempty"`
	// Attachments are files the agent sent along (images show inline).
	Attachments []Attachment `json:"attachments,omitempty"`
	// FromUser marks something the user said in the service's own app (Via
	// names it), so AgentStudio can show both sides of the conversation.
	FromUser bool   `json:"from_user,omitempty"`
	Via      string `json:"via,omitempty"`
	// History marks earlier conversation imported on connect: no notifications.
	History bool `json:"history,omitempty"`
	// TS is when the message was originally sent (RFC 3339), for history.
	TS string `json:"ts,omitempty"`
}

// Attachment is a file the bridge downloads and posts into the chat.
type Attachment struct {
	URL      string `json:"url"`
	Name     string `json:"name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
}

// MaxAttachments limits the files in one message.
const MaxAttachments = 10

// Time is the message's original time, or zero when it has none.
func (m *MessageEvent) Time() time.Time {
	t, err := time.Parse(time.RFC3339Nano, m.TS)
	if err != nil {
		return time.Time{}
	}
	return t
}

type Draft struct {
	Text string `json:"text"`
}

type DraftsEvent struct {
	TaskID string  `json:"task_id"`
	Drafts []Draft `json:"drafts"`
	Text   string  `json:"text,omitempty"`
}

type Detail struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type ChoiceCategory string

const (
	CategoryApprove ChoiceCategory = "approve"
	CategoryDeny    ChoiceCategory = "deny"
)

type Choice struct {
	Key      string         `json:"key"`
	Label    string         `json:"label"`
	Category ChoiceCategory `json:"category"`
}

type ApprovalRequestEvent struct {
	ExternalID       string   `json:"external_id"`
	Title            string   `json:"title"`
	Summary          string   `json:"summary,omitempty"`
	Details          []Detail `json:"details,omitempty"`
	Choices          []Choice `json:"choices"`
	ExpiresInSeconds int      `json:"expires_in_seconds,omitempty"`
}

type ApprovalCancelEvent struct {
	ExternalID string `json:"external_id"`
}

type AgentState string

const (
	StateIdle    AgentState = "idle"
	StateWorking AgentState = "working"
)

type StatusEvent struct {
	State AgentState `json:"state"`
	Text  string     `json:"text,omitempty"`
}

// ProfileEvent updates how the agent shows up (name and avatar) after the
// session started, e.g. once a connector has read them from the service.
type ProfileEvent struct {
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

// AgentEvent is the tagged union an agent posts to {callback_url}/events.
// Exactly one of the pointer fields matching Type is set.
type AgentEvent struct {
	Type            EventType
	Message         *MessageEvent
	Drafts          *DraftsEvent
	ApprovalRequest *ApprovalRequestEvent
	ApprovalCancel  *ApprovalCancelEvent
	Status          *StatusEvent
	Profile         *ProfileEvent
}

// Constructors keep call sites short on the agent side.

func NewMessage(text string) AgentEvent {
	return AgentEvent{Type: EventMessage, Message: &MessageEvent{Text: text}}
}

func NewDrafts(taskID string, drafts ...string) AgentEvent {
	d := make([]Draft, len(drafts))
	for i, t := range drafts {
		d[i] = Draft{Text: t}
	}
	return AgentEvent{Type: EventDrafts, Drafts: &DraftsEvent{TaskID: taskID, Drafts: d}}
}

func NewApprovalRequest(req ApprovalRequestEvent) AgentEvent {
	return AgentEvent{Type: EventApprovalRequest, ApprovalRequest: &req}
}

func NewApprovalCancel(externalID string) AgentEvent {
	return AgentEvent{Type: EventApprovalCancel, ApprovalCancel: &ApprovalCancelEvent{ExternalID: externalID}}
}

func NewStatus(state AgentState, text string) AgentEvent {
	return AgentEvent{Type: EventStatus, Status: &StatusEvent{State: state, Text: text}}
}

func (e AgentEvent) payload() (any, error) {
	var p any
	switch e.Type {
	case EventMessage:
		p = e.Message
	case EventDrafts:
		p = e.Drafts
	case EventApprovalRequest:
		p = e.ApprovalRequest
	case EventApprovalCancel:
		p = e.ApprovalCancel
	case EventStatus:
		p = e.Status
	case EventProfile:
		p = e.Profile
	default:
		return nil, fmt.Errorf("unknown event type %q", e.Type)
	}
	if isNilPtr(p) {
		return nil, fmt.Errorf("%s event has no payload", e.Type)
	}
	return p, nil
}

func isNilPtr(p any) bool {
	switch v := p.(type) {
	case *MessageEvent:
		return v == nil
	case *DraftsEvent:
		return v == nil
	case *ApprovalRequestEvent:
		return v == nil
	case *ApprovalCancelEvent:
		return v == nil
	case *StatusEvent:
		return v == nil
	case *ProfileEvent:
		return v == nil
	}
	return true
}

// MarshalJSON flattens the payload next to "type".
func (e AgentEvent) MarshalJSON() ([]byte, error) {
	p, err := e.payload()
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	fields["type"], _ = json.Marshal(e.Type)
	return json.Marshal(fields)
}

// UnmarshalJSON reads "type" and decodes the rest into the matching payload.
func (e *AgentEvent) UnmarshalJSON(data []byte) error {
	var head struct {
		Type EventType `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return err
	}
	*e = AgentEvent{Type: head.Type}
	var target any
	switch head.Type {
	case EventMessage:
		e.Message = &MessageEvent{}
		target = e.Message
	case EventDrafts:
		e.Drafts = &DraftsEvent{}
		target = e.Drafts
	case EventApprovalRequest:
		e.ApprovalRequest = &ApprovalRequestEvent{}
		target = e.ApprovalRequest
	case EventApprovalCancel:
		e.ApprovalCancel = &ApprovalCancelEvent{}
		target = e.ApprovalCancel
	case EventStatus:
		e.Status = &StatusEvent{}
		target = e.Status
	case EventProfile:
		e.Profile = &ProfileEvent{}
		target = e.Profile
	case "":
		return errors.New("event type is required")
	default:
		return fmt.Errorf("unknown event type %q", head.Type)
	}
	return json.Unmarshal(data, target)
}

func checkText(field, s string, required bool) error {
	if required && s == "" {
		return fmt.Errorf("%s is required", field)
	} else if utf8.RuneCountInString(s) > MaxTextLength {
		return fmt.Errorf("%s is longer than %d characters", field, MaxTextLength)
	}
	return nil
}

func checkID(field, s string) error {
	if s == "" {
		return fmt.Errorf("%s is required", field)
	} else if len(s) > MaxIDLength {
		return fmt.Errorf("%s is longer than %d bytes", field, MaxIDLength)
	}
	return nil
}

// Validate checks an event against the protocol's rules and limits.
func (e *AgentEvent) Validate() error {
	if _, err := e.payload(); err != nil {
		return err
	}
	switch e.Type {
	case EventMessage:
		return e.Message.validate()
	case EventDrafts:
		d := e.Drafts
		if err := checkID("task_id", d.TaskID); err != nil {
			return err
		} else if len(d.Drafts) < MinDrafts || len(d.Drafts) > MaxDrafts {
			return fmt.Errorf("drafts must have %d to %d entries", MinDrafts, MaxDrafts)
		}
		for i, dr := range d.Drafts {
			if err := checkText(fmt.Sprintf("drafts[%d].text", i), dr.Text, true); err != nil {
				return err
			}
		}
		return checkText("text", d.Text, false)
	case EventApprovalRequest:
		return e.ApprovalRequest.validate()
	case EventApprovalCancel:
		return checkID("external_id", e.ApprovalCancel.ExternalID)
	case EventStatus:
		if e.Status.State != StateIdle && e.Status.State != StateWorking {
			return fmt.Errorf("unknown status state %q", e.Status.State)
		}
		return checkText("text", e.Status.Text, false)
	case EventProfile:
		if e.Profile.Name == "" && e.Profile.AvatarURL == "" {
			return errors.New("profile needs a name or an avatar_url")
		} else if utf8.RuneCountInString(e.Profile.Name) > 100 {
			return errors.New("name is too long")
		}
		if e.Profile.AvatarURL != "" {
			if _, err := NormalizeAvatarURL(e.Profile.AvatarURL); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *MessageEvent) validate() error {
	if err := checkText("text", m.Text, len(m.Attachments) == 0); err != nil {
		return err
	}
	if len(m.Attachments) > MaxAttachments {
		return fmt.Errorf("attachments has more than %d entries", MaxAttachments)
	}
	for i, a := range m.Attachments {
		if _, err := NormalizeAvatarURL(a.URL); err != nil {
			return fmt.Errorf("attachments[%d].url must be an absolute http(s) URL", i)
		} else if utf8.RuneCountInString(a.Name) > 255 || len(a.MimeType) > 255 {
			return fmt.Errorf("attachments[%d] name or mime_type is too long", i)
		}
	}
	if utf8.RuneCountInString(m.Via) > 100 {
		return errors.New("via is too long")
	}
	if m.TS != "" {
		t, err := time.Parse(time.RFC3339Nano, m.TS)
		if err != nil {
			return errors.New("ts must be an RFC 3339 time")
		} else if t.After(time.Now().Add(time.Minute)) {
			return errors.New("ts is in the future")
		}
	}
	return nil
}

// NormalizeAvatarURL accepts absolute http(s) URLs without credentials.
func NormalizeAvatarURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", errors.New("avatar_url must be an absolute http(s) URL")
	} else if len(raw) > 2048 {
		return "", errors.New("avatar_url is too long")
	}
	return u.String(), nil
}

func (a *ApprovalRequestEvent) validate() error {
	if err := checkID("external_id", a.ExternalID); err != nil {
		return err
	} else if err = checkText("title", a.Title, true); err != nil {
		return err
	} else if err = checkText("summary", a.Summary, false); err != nil {
		return err
	} else if len(a.Details) > MaxDetails {
		return fmt.Errorf("details has more than %d entries", MaxDetails)
	} else if a.ExpiresInSeconds < 0 {
		return errors.New("expires_in_seconds must not be negative")
	} else if len(a.Choices) < MinChoices || len(a.Choices) > MaxChoices {
		return fmt.Errorf("choices must have %d to %d entries", MinChoices, MaxChoices)
	}
	for i, d := range a.Details {
		if d.Label == "" {
			return fmt.Errorf("details[%d].label is required", i)
		} else if err := checkText("details value", d.Value, false); err != nil {
			return err
		}
	}
	seen := make(map[string]bool, len(a.Choices))
	var approve, deny bool
	for i, c := range a.Choices {
		if err := checkID(fmt.Sprintf("choices[%d].key", i), c.Key); err != nil {
			return err
		} else if c.Label == "" {
			return fmt.Errorf("choices[%d].label is required", i)
		} else if seen[c.Key] {
			return fmt.Errorf("duplicate choice key %q", c.Key)
		}
		seen[c.Key] = true
		switch c.Category {
		case CategoryApprove:
			approve = true
		case CategoryDeny:
			deny = true
		default:
			return fmt.Errorf("choices[%d].category must be approve or deny", i)
		}
	}
	if !approve || !deny {
		return errors.New("choices need at least one approve and one deny")
	}
	return nil
}
