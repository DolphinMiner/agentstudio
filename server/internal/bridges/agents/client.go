package agents

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/matrix"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// UserLoginMetadata is persisted by bridgev2 in the user_login table.
type UserLoginMetadata struct {
	Flow        string `json:"flow"`
	BaseURL     string `json:"base_url"`
	AgentToken  string `json:"agent_token,omitempty"` // the user's access token for the agent, if any
	SessionID   string `json:"session_id"`
	CallbackKey string `json:"callback_key"`
	// SHA-256 of the current callback token; the token itself is only sent to the agent.
	CallbackTokenHash []byte               `json:"callback_token_hash"`
	Info              agentproto.AgentInfo `json:"info"`
	RoomID            id.RoomID            `json:"room_id,omitempty"`
	Approvals         []approvalRef        `json:"approvals,omitempty"`
}

// maxApprovalRefs bounds the external_id -> approval id memory per login.
const maxApprovalRefs = 200

func networkIDLogin(s string) networkid.UserLoginID { return networkid.UserLoginID(s) }

// LoginIDFor is the stable user_login_id for a user's connection to one agent:
// "agent-" + the first 12 hex chars of sha256(owner mxid + "\n" + base url).
// Connecting the same agent again reuses the login, its room and its session.
func LoginIDFor(owner id.UserID, baseURL string) networkid.UserLoginID {
	sum := sha256.Sum256([]byte(owner.String() + "\n" + baseURL))
	return networkid.UserLoginID("agent-" + hex.EncodeToString(sum[:])[:12])
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// AgentClient is the bridgev2 NetworkAPI for one agent login.
type AgentClient struct {
	conn  *Connector
	login *bridgev2.UserLogin

	metaLock      sync.Mutex // guards login.Metadata contents
	handshakeLock sync.Mutex // serializes session (re)registration

	stopLock sync.Mutex
	stop     context.CancelFunc
}

var (
	_ bridgev2.NetworkAPI = (*AgentClient)(nil)
	_ callbackSession     = (*AgentClient)(nil)
	_ decisionReceiver    = (*AgentClient)(nil)
)

func (ac *AgentClient) meta() *UserLoginMetadata {
	return ac.login.Metadata.(*UserLoginMetadata)
}

// snapshot returns a copy of the metadata fields that are read concurrently.
func (ac *AgentClient) snapshot() UserLoginMetadata {
	ac.metaLock.Lock()
	defer ac.metaLock.Unlock()
	m := *ac.meta()
	m.Approvals = slices.Clone(m.Approvals)
	return m
}

func (ac *AgentClient) agentID() string { return AgentIDPrefix + string(ac.login.ID) }

func (ac *AgentClient) ghostID() networkid.UserID { return networkid.UserID(ac.login.ID) }

func (ac *AgentClient) selfID() networkid.UserID {
	return networkid.UserID("self-" + string(ac.login.ID))
}

func (ac *AgentClient) portalKey() networkid.PortalKey {
	return networkid.PortalKey{ID: networkid.PortalID(ac.login.ID), Receiver: ac.login.ID}
}

func (ac *AgentClient) agent() *agentproto.Client {
	m := ac.snapshot()
	return &agentproto.Client{BaseURL: m.BaseURL, Token: m.AgentToken, HTTP: ac.conn.HTTP}
}

// --- callbackSession / decisionReceiver ---

func (ac *AgentClient) tokenHash() []byte {
	return ac.snapshot().CallbackTokenHash
}

func (ac *AgentClient) target() *eventTarget {
	return &eventTarget{
		AgentID:       ac.agentID(),
		OwnerMXID:     ac.login.UserMXID.String(),
		Send:          ac.sendAsGhost,
		SendFile:      ac.sendFile,
		GetApproval:   ac.getApproval,
		PutApproval:   ac.putApproval,
		UpdateProfile: ac.updateProfile,
	}
}

// updateProfile applies a profile event: the ghost's name and avatar in
// Matrix, and the agent record in agentstudio-api.
func (ac *AgentClient) updateProfile(ctx context.Context, name, avatarURL string) error {
	ac.metaLock.Lock()
	m := ac.meta()
	if name != "" {
		m.Info.Name = name
		ac.login.RemoteName = name
		ac.login.RemoteProfile.Name = name
	}
	if avatarURL != "" {
		m.Info.AvatarURL = avatarURL
	}
	roomID := m.RoomID
	ac.metaLock.Unlock()
	ac.save(ctx)
	if ghost, err := ac.conn.br.GetGhostByID(ctx, ac.ghostID()); err == nil && ghost != nil {
		ghost.UpdateInfo(ctx, ac.userInfo())
	}
	return ac.registerAgent(ctx, roomID)
}

func (ac *AgentClient) getApproval(externalID string) *approvalRef {
	ac.metaLock.Lock()
	defer ac.metaLock.Unlock()
	for _, ref := range ac.meta().Approvals {
		if ref.ExternalID == externalID {
			return &ref
		}
	}
	return nil
}

func (ac *AgentClient) putApproval(ref approvalRef) {
	ac.metaLock.Lock()
	m := ac.meta()
	m.Approvals = slices.DeleteFunc(m.Approvals, func(r approvalRef) bool { return r.ExternalID == ref.ExternalID })
	m.Approvals = append(m.Approvals, ref)
	if len(m.Approvals) > maxApprovalRefs {
		m.Approvals = m.Approvals[len(m.Approvals)-maxApprovalRefs:]
	}
	ac.metaLock.Unlock()
	ac.save(context.Background())
}

func (ac *AgentClient) save(ctx context.Context) {
	ac.metaLock.Lock()
	defer ac.metaLock.Unlock()
	if err := ac.login.Save(ctx); err != nil {
		ac.login.Log.Err(err).Msg("Failed to save login metadata")
	}
}

func (ac *AgentClient) deliverDecision(ctx context.Context, externalID string, req *agentproto.DecisionRequest) error {
	return ac.withSession(ctx, func(sessionID string) error {
		return ac.agent().SendDecision(ctx, sessionID, externalID, req)
	})
}

// withSession runs fn with the current session id. If the agent says the
// session is gone, it re-registers the session once and retries.
func (ac *AgentClient) withSession(ctx context.Context, fn func(sessionID string) error) error {
	sessionID := ac.snapshot().SessionID
	err := fn(sessionID)
	if !errors.Is(err, agentproto.ErrSessionNotFound) {
		return err
	}
	zerolog.Ctx(ctx).Info().Msg("Agent lost the session, registering it again")
	if err = ac.handshake(ctx, sessionID); err != nil {
		return fmt.Errorf("failed to re-register session: %w", err)
	}
	return fn(ac.snapshot().SessionID)
}

// sessionResult is the outcome of a successful handshake.
type sessionResult struct {
	Info        *agentproto.AgentInfo
	SessionID   string
	CallbackKey string
	TokenHash   []byte
}

// registerSession runs GET info + POST sessions for the agent described by m.
// It keeps m's callback key (or makes one), issues a fresh callback token and
// passes m's session id as a resume hint.
func (c *Connector) registerSession(ctx context.Context, owner id.UserID, m *UserLoginMetadata) (*sessionResult, error) {
	client := &agentproto.Client{BaseURL: m.BaseURL, Token: m.AgentToken, HTTP: c.HTTP}
	info, err := client.Info(ctx)
	if err != nil {
		return nil, err
	}
	key := m.CallbackKey
	if key == "" {
		key = randomHex(16)
	}
	token := randomHex(32)
	sessionID, err := client.CreateSession(ctx, &agentproto.CreateSessionRequest{
		CallbackURL:   c.callbackURL(key),
		CallbackToken: token,
		User:          agentproto.SessionUser{DisplayName: c.displayName(ctx, owner)},
		SessionID:     m.SessionID,
	})
	if err != nil {
		return nil, err
	}
	hash := agentproto.HashToken(token)
	return &sessionResult{Info: info, SessionID: sessionID, CallbackKey: key, TokenHash: hash[:]}, nil
}

func (m *UserLoginMetadata) apply(res *sessionResult) {
	m.Info = *res.Info
	m.SessionID = res.SessionID
	m.CallbackKey = res.CallbackKey
	m.CallbackTokenHash = res.TokenHash
}

// handshake re-registers this login's session with the agent. If staleSessionID
// is set and the session already changed since, it does nothing.
func (ac *AgentClient) handshake(ctx context.Context, staleSessionID string) error {
	ac.handshakeLock.Lock()
	defer ac.handshakeLock.Unlock()
	m := ac.snapshot()
	if staleSessionID != "" && m.SessionID != staleSessionID {
		return nil
	}
	res, err := ac.conn.registerSession(ctx, ac.login.UserMXID, &m)
	if err != nil {
		return err
	}
	ac.metaLock.Lock()
	ac.meta().apply(res)
	ac.login.RemoteName = res.Info.Name
	ac.login.RemoteProfile.Name = res.Info.Name
	ac.metaLock.Unlock()
	ac.save(ctx)
	ac.conn.setCallback(res.CallbackKey, ac)
	if m.SessionID != "" && m.SessionID != res.SessionID {
		zerolog.Ctx(ctx).Info().Msg("Agent issued a new session id")
	}
	if m.Info.Name != res.Info.Name || m.Info.AvatarURL != res.Info.AvatarURL {
		if ghost, err := ac.conn.br.GetGhostByID(ctx, ac.ghostID()); err == nil && ghost != nil {
			ghost.UpdateInfo(ctx, ac.userInfo())
		}
	}
	return nil
}

// --- bridgev2.NetworkAPI ---

// Connect re-registers the session with the agent (so agents that keep
// sessions in memory survive bridge restarts), then makes sure the portal
// exists and the agent is registered with agentstudio-api. It retries in the
// background until it succeeds or Disconnect is called.
func (ac *AgentClient) Connect(ctx context.Context) {
	ctx, cancel := context.WithCancel(ac.login.Log.WithContext(ac.conn.br.BackgroundCtx))
	ac.stopLock.Lock()
	if ac.stop != nil {
		ac.stop()
	}
	ac.stop = cancel
	ac.stopLock.Unlock()
	ac.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnecting})
	go ac.connectLoop(ctx)
}

func (ac *AgentClient) connectLoop(ctx context.Context) {
	backoff := 2 * time.Second
	for {
		err := ac.handshake(ctx, "")
		if err == nil {
			ac.markConnected(ctx)
			return
		}
		if ctx.Err() != nil {
			return
		}
		if agentproto.IsStatus(err, http.StatusUnauthorized) || agentproto.IsStatus(err, http.StatusForbidden) {
			ac.login.Log.Warn().Err(err).Msg("Agent rejected our access token")
			ac.login.BridgeState.Send(status.BridgeState{
				StateEvent: status.StateBadCredentials,
				Error:      "agentstudio-agent-unauthorized",
				Message:    "The agent rejected the access token",
			})
			return
		}
		ac.login.Log.Warn().Err(err).Dur("retry_in", backoff).Msg("Failed to connect to agent")
		ac.login.BridgeState.Send(status.BridgeState{
			StateEvent: status.StateTransientDisconnect,
			Error:      "agentstudio-agent-unreachable",
			Message:    "Can't reach the agent",
		})
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

// markConnected reports the login as connected, then syncs the portal and the API registration.
func (ac *AgentClient) markConnected(ctx context.Context) {
	ac.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
	if err := ac.syncPortalAndAgent(ctx); err != nil {
		ac.login.Log.Err(err).Msg("Failed to sync agent room or registration")
	}
}

// syncPortalAndAgent creates (or refreshes) the DM portal and upserts the agent
// in agentstudio-api, retrying the API call a few times since the API may start
// after the bridge.
func (ac *AgentClient) syncPortalAndAgent(ctx context.Context) error {
	roomID, err := ac.ensurePortal(ctx)
	if err != nil {
		return err
	}
	for attempt := range 5 {
		if err = ac.registerAgent(ctx, roomID); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Second):
		}
	}
	return err
}

// registerAgent upserts the agent with PUT /internal/v1/agents.
func (ac *AgentClient) registerAgent(ctx context.Context, roomID id.RoomID) error {
	m := ac.snapshot()
	req := &AgentUpsert{
		OwnerMXID:    ac.login.UserMXID.String(),
		ConnectionID: ac.agentID(),
		Name:         m.Info.Name,
		Description:  m.Info.Description,
		AvatarURL:    m.Info.AvatarURL,
		Capabilities: m.Info.Capabilities,
		RoomID:       roomID.String(),
	}
	if req.Capabilities == nil {
		req.Capabilities = []agentproto.Capability{}
	}
	if err := ac.conn.api.UpsertAgent(ctx, req); err != nil {
		return fmt.Errorf("failed to register agent with agentstudio-api: %w", err)
	}
	return nil
}

// ensurePortal queues a chat resync that creates the DM portal if needed and
// waits until it has been handled. It returns the portal's room id.
func (ac *AgentClient) ensurePortal(ctx context.Context) (id.RoomID, error) {
	done := make(chan struct{})
	res := ac.login.QueueRemoteEvent(&simplevent.ChatResync{
		EventMeta: simplevent.EventMeta{
			Type:           bridgev2.RemoteEventChatResync,
			PortalKey:      ac.portalKey(),
			CreatePortal:   true,
			PostHandleFunc: func(context.Context, *bridgev2.Portal) { close(done) },
		},
		GetChatInfoFunc: func(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
			return ac.chatInfo(), nil
		},
	})
	if !res.Success {
		return "", fmt.Errorf("failed to queue portal sync: %w", res.Error)
	}
	select {
	case <-done:
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(60 * time.Second):
		return "", errors.New("timed out creating the agent room")
	}
	portal, err := ac.conn.br.GetExistingPortalByKey(ctx, ac.portalKey())
	if err != nil {
		return "", err
	} else if portal == nil || portal.MXID == "" {
		return "", errors.New("agent room was not created")
	}
	ac.metaLock.Lock()
	changed := ac.meta().RoomID != portal.MXID
	ac.meta().RoomID = portal.MXID
	ac.metaLock.Unlock()
	if changed {
		ac.save(ctx)
	}
	return portal.MXID, nil
}

// sendAsGhost queues a message from the agent ghost into the DM portal and
// waits until it has been sent, returning its event id and room id.
func (ac *AgentClient) sendAsGhost(ctx context.Context, content *event.MessageEventContent, extra map[string]any, replyTo string, ts time.Time) (id.EventID, id.RoomID, error) {
	converted := &bridgev2.ConvertedMessage{
		Parts: []*bridgev2.ConvertedMessagePart{{Type: event.EventMessage, Content: content, Extra: extra}},
	}
	if replyTo != "" {
		converted.ReplyTo = &networkid.MessageOptionalPartID{MessageID: networkid.MessageID(replyTo)}
	}
	return ac.sendConverted(ctx, ts, func(context.Context, bridgev2.MatrixAPI, id.RoomID) (*bridgev2.ConvertedMessage, error) {
		return converted, nil
	})
}

// sendFile uploads a file to the agent's room and posts it, as an image when it is one.
func (ac *AgentClient) sendFile(ctx context.Context, data []byte, name, mimeType string, extra map[string]any, ts time.Time) (id.EventID, error) {
	eventID, _, err := ac.sendConverted(ctx, ts, func(ctx context.Context, intent bridgev2.MatrixAPI, roomID id.RoomID) (*bridgev2.ConvertedMessage, error) {
		mxc, file, err := intent.UploadMedia(ctx, roomID, data, name, mimeType)
		if err != nil {
			return nil, fmt.Errorf("upload: %w", err)
		}
		msgType := event.MsgFile
		if strings.HasPrefix(mimeType, "image/") {
			msgType = event.MsgImage
		}
		content := &event.MessageEventContent{
			MsgType:  msgType,
			Body:     name,
			FileName: name,
			URL:      mxc,
			File:     file,
			Info:     &event.FileInfo{MimeType: mimeType, Size: len(data)},
		}
		return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{Type: event.EventMessage, Content: content, Extra: extra}}}, nil
	})
	return eventID, err
}

// sendConverted queues a message from the agent ghost into the DM portal and
// waits until it has been sent. A zero ts means now.
func (ac *AgentClient) sendConverted(ctx context.Context, ts time.Time, convert func(context.Context, bridgev2.MatrixAPI, id.RoomID) (*bridgev2.ConvertedMessage, error)) (id.EventID, id.RoomID, error) {
	msgID := networkid.MessageID("agt_" + randomHex(12))
	if ts.IsZero() {
		ts = time.Now()
	}
	done := make(chan struct{})
	res := ac.login.QueueRemoteEvent(&simplevent.Message[struct{}]{
		EventMeta: simplevent.EventMeta{
			Type:           bridgev2.RemoteEventMessage,
			PortalKey:      ac.portalKey(),
			Sender:         bridgev2.EventSender{Sender: ac.ghostID()},
			CreatePortal:   true,
			Timestamp:      ts,
			PostHandleFunc: func(context.Context, *bridgev2.Portal) { close(done) },
		},
		ID:   msgID,
		Data: struct{}{},
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, _ struct{}) (*bridgev2.ConvertedMessage, error) {
			return convert(ctx, intent, portal.MXID)
		},
	})
	if !res.Success {
		return "", "", fmt.Errorf("failed to queue message: %w", res.Error)
	}
	select {
	case <-done:
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
	dbMsg, err := ac.conn.br.DB.Message.GetFirstPartByID(ctx, ac.login.ID, msgID)
	if err != nil {
		return "", "", err
	} else if dbMsg == nil || dbMsg.HasFakeMXID() {
		return "", "", errors.New("message was not sent to Matrix")
	}
	portal, err := ac.conn.br.GetExistingPortalByKey(ctx, ac.portalKey())
	if err != nil || portal == nil {
		return "", "", fmt.Errorf("agent room not found: %w", err)
	}
	return dbMsg.MXID, portal.MXID, nil
}

func (ac *AgentClient) Disconnect() {
	ac.stopLock.Lock()
	defer ac.stopLock.Unlock()
	if ac.stop != nil {
		ac.stop()
		ac.stop = nil
	}
}

func (ac *AgentClient) IsLoggedIn() bool { return ac.snapshot().SessionID != "" }

func (ac *AgentClient) LogoutRemote(ctx context.Context) {
	m := ac.snapshot()
	if m.SessionID != "" {
		if err := ac.agent().DeleteSession(ctx, m.SessionID); err != nil {
			ac.login.Log.Warn().Err(err).Msg("Failed to delete session at the agent")
		}
	}
	if m.CallbackKey != "" {
		ac.conn.setCallback(m.CallbackKey, nil)
	}
}

func (ac *AgentClient) IsThisUser(_ context.Context, userID networkid.UserID) bool {
	return userID == ac.selfID()
}

func (ac *AgentClient) chatInfo() *bridgev2.ChatInfo {
	roomType := database.RoomTypeDM
	members := bridgev2.ChatMemberMap{}
	members.Set(bridgev2.ChatMember{
		EventSender: bridgev2.EventSender{IsFromMe: true, SenderLogin: ac.login.ID, Sender: ac.selfID()},
		Membership:  event.MembershipJoin,
	})
	members.Set(bridgev2.ChatMember{
		EventSender: bridgev2.EventSender{Sender: ac.ghostID()},
		Membership:  event.MembershipJoin,
		UserInfo:    ac.userInfo(),
	})
	return &bridgev2.ChatInfo{
		Type: &roomType,
		Members: &bridgev2.ChatMemberList{
			IsFull:      true,
			OtherUserID: ac.ghostID(),
			MemberMap:   members,
		},
	}
}

func (ac *AgentClient) GetChatInfo(_ context.Context, _ *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	return ac.chatInfo(), nil
}

func (ac *AgentClient) userInfo() *bridgev2.UserInfo {
	info := ac.snapshot().Info
	name := info.Name
	ui := &bridgev2.UserInfo{Name: &name}
	if info.AvatarURL == "" {
		ui.Avatar = &bridgev2.Avatar{Remove: true}
	} else {
		avatarURL := info.AvatarURL
		ui.Avatar = &bridgev2.Avatar{
			ID: networkid.AvatarID(avatarURL),
			Get: func(ctx context.Context) ([]byte, error) {
				return ac.conn.downloadAvatar(ctx, avatarURL)
			},
		}
	}
	return ui
}

func (ac *AgentClient) GetUserInfo(_ context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	if ghost.ID != ac.ghostID() {
		return nil, nil
	}
	return ac.userInfo(), nil
}

func (ac *AgentClient) GetCapabilities(_ context.Context, _ *bridgev2.Portal) *event.RoomFeatures {
	return &event.RoomFeatures{
		ID:            "com.agentstudio.agents.v0",
		MaxTextLength: agentproto.MaxTextLength,
		Reply:         event.CapLevelPartialSupport,
	}
}

// HandleMatrixMessage forwards the user's text (and any com.agentstudio.ask) to the agent.
// The agent answers 202 quickly and replies later through callbacks.
func (ac *AgentClient) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	switch msg.Content.MsgType {
	case event.MsgText, event.MsgNotice, event.MsgEmote:
	default:
		return nil, bridgev2.ErrUnsupportedMessageType
	}
	var inbound *agentproto.InboundMessage
	err := ac.withSession(ctx, func(sessionID string) error {
		var err error
		inbound, err = buildInbound(sessionID, msg.Event, msg.Content)
		if err != nil {
			return bridgev2.WrapErrorInStatus(err).WithIsCertain(true).WithSendNotice(true)
		}
		sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return ac.agent().SendMessage(sendCtx, inbound)
	})
	if err != nil {
		if inbound != nil && inbound.Ask != nil {
			ac.failTask(inbound.Ask.TaskID)
		}
		return nil, err
	}
	return &bridgev2.MatrixMessageResponse{
		DB: &database.Message{
			ID:        networkid.MessageID(msg.Event.ID),
			SenderID:  ac.selfID(),
			Timestamp: time.UnixMilli(msg.Event.Timestamp),
		},
	}, nil
}

func (ac *AgentClient) failTask(taskID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := ac.conn.api.FailTask(ctx, taskID, "The agent could not be reached."); err != nil {
			ac.login.Log.Warn().Err(err).Str("task_id", taskID).Msg("Failed to mark task failed")
		}
	}()
}

// displayName returns the user's Matrix display name, or their localpart.
func (c *Connector) displayName(ctx context.Context, mxid id.UserID) string {
	if mc, ok := c.br.Matrix.(*matrix.Connector); ok {
		if p, err := mc.Bot.GetProfile(ctx, mxid); err == nil && p.DisplayName != "" {
			return p.DisplayName
		}
	}
	return mxid.Localpart()
}

// downloadFile fetches an agent's attachment (up to 25 MiB) and its type.
func (c *Connector) downloadFile(ctx context.Context, fileURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	const maxFile = 25 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxFile+1))
	if err != nil {
		return nil, "", err
	} else if len(data) > maxFile {
		return nil, "", errors.New("file is larger than 25 MiB")
	}
	mimeType := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(mimeType, ';'); i >= 0 {
		mimeType = mimeType[:i]
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	return data, strings.TrimSpace(mimeType), nil
}

func (c *Connector) downloadAvatar(ctx context.Context, avatarURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, avatarURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("avatar download: HTTP %d", resp.StatusCode)
	}
	const maxAvatar = 5 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAvatar+1))
	if err != nil {
		return nil, err
	} else if len(data) > maxAvatar {
		return nil, errors.New("avatar is larger than 5 MiB")
	}
	return data, nil
}
