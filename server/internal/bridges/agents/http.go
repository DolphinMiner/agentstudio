package agents

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/rs/zerolog"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// RegisterRoutes adds the agent callback and approval decision routes to mux.
func (c *Connector) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /agentstudio/v0/callback/{key}/events", c.handleCallback)
	mux.HandleFunc("POST /agentstudio/internal/v1/approval-decisions", c.handleDecision)
}

func (c *Connector) logger() *zerolog.Logger {
	if c.br != nil {
		return &c.br.Log
	}
	l := zerolog.Nop()
	return &l
}

// handleCallback serves POST /agentstudio/v0/callback/{key}/events (agent -> bridge).
func (c *Connector) handleCallback(w http.ResponseWriter, r *http.Request) {
	sess := c.getCallback(r.PathValue("key"))
	if sess == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown session")
		return
	}
	if !agentproto.TokenMatches(agentproto.BearerToken(r), sess.tokenHash()) {
		agentproto.WriteError(w, http.StatusUnauthorized, "unauthenticated", "bad callback token")
		return
	}
	var evt agentproto.AgentEvent
	if err := agentproto.ReadJSON(r, agentproto.MaxEventBodySize, &evt); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid event: "+err.Error())
		return
	} else if err = evt.Validate(); err != nil {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "invalid event: "+err.Error())
		return
	}
	t := sess.target()
	log := c.logger().With().Str("component", "agent_callback").Str("agent_id", t.AgentID).Logger()
	ctx, cancel := context.WithTimeout(log.WithContext(context.Background()), 60*time.Second)
	defer cancel()
	// Events are handled synchronously, so an agent that waits for our reply gets in-order delivery.
	if err := c.applyEvent(ctx, t, &evt); err != nil {
		log.Err(err).Str("event_type", string(evt.Type)).Msg("Failed to handle agent event")
		var up errUpstream
		if errors.As(err, &up) {
			agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", "the event could not be delivered, try again")
		} else {
			agentproto.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		}
		return
	}
	log.Debug().Str("event_type", string(evt.Type)).Msg("Handled agent event")
	agentproto.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type decisionHook struct {
	ApprovalID string `json:"approval_id"`
	AgentID    string `json:"agent_id"`
	ExternalID string `json:"external_id"`
	Choice     string `json:"choice"`
}

// handleDecision serves POST /agentstudio/internal/v1/approval-decisions (agentstudio-api -> bridge).
func (c *Connector) handleDecision(w http.ResponseWriter, r *http.Request) {
	if !agentproto.SecretMatches(agentproto.BearerToken(r), c.Config.InternalSecret) {
		agentproto.WriteError(w, http.StatusUnauthorized, "unauthenticated", "bad internal secret")
		return
	}
	var req decisionHook
	if err := agentproto.ReadJSON(r, 64<<10, &req); err != nil || req.AgentID == "" || req.ExternalID == "" || req.Choice == "" {
		agentproto.WriteError(w, http.StatusBadRequest, "bad_request", "agent_id, external_id and choice are required")
		return
	}
	log := c.logger().With().Str("component", "approval_decision").
		Str("agent_id", req.AgentID).Str("approval_id", req.ApprovalID).Logger()
	ctx, cancel := context.WithTimeout(log.WithContext(r.Context()), 10*time.Second)
	defer cancel()
	recv, err := c.findReceiver(ctx, req.AgentID)
	if err != nil {
		log.Err(err).Msg("Failed to look up agent")
		agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", "failed to look up agent")
		return
	} else if recv == nil {
		agentproto.WriteError(w, http.StatusNotFound, "not_found", "unknown agent")
		return
	}
	err = recv.deliverDecision(ctx, req.ExternalID, &agentproto.DecisionRequest{ApprovalID: req.ApprovalID, Choice: req.Choice})
	if err != nil {
		log.Warn().Err(err).Msg("Failed to deliver decision to agent")
		agentproto.WriteError(w, http.StatusBadGateway, "upstream_error", "the agent did not accept the decision")
		return
	}
	log.Info().Str("choice", req.Choice).Msg("Delivered decision to agent")
	agentproto.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
