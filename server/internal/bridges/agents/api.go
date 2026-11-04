package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// APIClient calls agentstudio-api's internal routes (docs/api.md, "Internal API").
type APIClient struct {
	BaseURL string
	Secret  string
	HTTP    *http.Client
}

type AgentUpsert struct {
	OwnerMXID    string                  `json:"owner_mxid"`
	ConnectionID string                  `json:"connection_id"`
	Name         string                  `json:"name"`
	Description  string                  `json:"description,omitempty"`
	AvatarURL    string                  `json:"avatar_url,omitempty"`
	Capabilities []agentproto.Capability `json:"capabilities"`
	RoomID       string                  `json:"room_id,omitempty"`
}

type AgentPatch struct {
	Status     string  `json:"status,omitempty"`
	StatusText *string `json:"status_text,omitempty"`
	RoomID     string  `json:"room_id,omitempty"`
}

type ApprovalCreate struct {
	OwnerMXID  string              `json:"owner_mxid"`
	AgentID    string              `json:"agent_id"`
	ExternalID string              `json:"external_id"`
	Title      string              `json:"title"`
	Summary    string              `json:"summary,omitempty"`
	Details    []agentproto.Detail `json:"details"`
	Choices    []agentproto.Choice `json:"choices"`
	ExpiresAt  string              `json:"expires_at,omitempty"`
	RoomID     string              `json:"room_id,omitempty"`
	EventID    string              `json:"event_id,omitempty"`
}

type ApprovalPatch struct {
	RoomID  string `json:"room_id,omitempty"`
	EventID string `json:"event_id,omitempty"`
	State   string `json:"state,omitempty"`
}

type TaskAnswer struct {
	EventID string             `json:"event_id"`
	Drafts  []agentproto.Draft `json:"drafts"`
}

func (a *APIClient) do(ctx context.Context, method, path string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, a.BaseURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.Secret)
	hc := a.HTTP
	if hc == nil {
		hc = agentproto.DefaultHTTPClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return &agentproto.HTTPError{Method: method, Path: path, Status: resp.StatusCode}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("%s %s: bad response: %w", method, path, err)
	}
	return nil
}

// UpsertAgent calls PUT /internal/v1/agents.
func (a *APIClient) UpsertAgent(ctx context.Context, req *AgentUpsert) error {
	return a.do(ctx, http.MethodPut, "/internal/v1/agents", req, nil)
}

// PatchAgent calls PATCH /internal/v1/agents/{agent_id}.
func (a *APIClient) PatchAgent(ctx context.Context, agentID string, req *AgentPatch) error {
	return a.do(ctx, http.MethodPatch, "/internal/v1/agents/"+url.PathEscape(agentID), req, nil)
}

// CreateApproval calls POST /internal/v1/approvals and returns the approval id.
func (a *APIClient) CreateApproval(ctx context.Context, req *ApprovalCreate) (string, error) {
	var resp struct {
		ID string `json:"id"`
	}
	if err := a.do(ctx, http.MethodPost, "/internal/v1/approvals", req, &resp); err != nil {
		return "", err
	} else if resp.ID == "" {
		return "", fmt.Errorf("POST /internal/v1/approvals: response has no id")
	}
	return resp.ID, nil
}

// PatchApproval calls PATCH /internal/v1/approvals/{id}.
func (a *APIClient) PatchApproval(ctx context.Context, approvalID string, req *ApprovalPatch) error {
	return a.do(ctx, http.MethodPatch, "/internal/v1/approvals/"+url.PathEscape(approvalID), req, nil)
}

// AnswerTask calls POST /internal/v1/tasks/{id}/answer.
func (a *APIClient) AnswerTask(ctx context.Context, taskID string, req *TaskAnswer) error {
	return a.do(ctx, http.MethodPost, "/internal/v1/tasks/"+url.PathEscape(taskID)+"/answer", req, nil)
}

// FailTask calls POST /internal/v1/tasks/{id}/fail.
func (a *APIClient) FailTask(ctx context.Context, taskID, reason string) error {
	return a.do(ctx, http.MethodPost, "/internal/v1/tasks/"+url.PathEscape(taskID)+"/fail", map[string]string{"reason": reason}, nil)
}
