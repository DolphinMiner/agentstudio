package demo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
)

// maxTextLength bounds message bodies accepted from Matrix and from the dev hook.
const maxTextLength = 10000

// errMediaNotSupported is returned for any non-text Matrix message.
var errMediaNotSupported = bridgev2.WrapErrorInStatus(errors.New("the demo network only supports text messages")).
	WithErrorAsMessage().WithIsCertain(true).WithSendNotice(true).WithErrorReason(event.MessageStatusUnsupported)

// Client is the NetworkAPI for one demo login. The demo network has no remote connection;
// all behaviour is simulated in process.
type Client struct {
	conn      *Connector
	login     *bridgev2.UserLogin
	connected atomic.Bool
}

var (
	_ bridgev2.NetworkAPI            = (*Client)(nil)
	_ bridgev2.BackfillingNetworkAPI = (*Client)(nil)
	_ bridgev2.NetworkAPIWithUserID  = (*Client)(nil)
)

func (c *Client) meta() *UserLoginMetadata {
	if m, ok := c.login.Metadata.(*UserLoginMetadata); ok && m != nil {
		return m
	}
	return &UserLoginMetadata{}
}

// ownID is the remote user ID of the logged-in user. It equals the login ID.
func (c *Client) ownID() networkid.UserID { return networkid.UserID(c.login.ID) }

func (c *Client) portalKey(id networkid.PortalID) networkid.PortalKey {
	return networkid.PortalKey{ID: id, Receiver: c.login.ID}
}

// Connect marks the login connected and makes sure all demo portals exist. The resync is
// idempotent: existing rooms only get their info refreshed, and the starting messages are
// backfilled only into empty rooms.
func (c *Client) Connect(ctx context.Context) {
	c.connected.Store(true)
	c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
	for _, p := range portals {
		c.login.QueueRemoteEvent(&simplevent.ChatResync{
			EventMeta: simplevent.EventMeta{
				Type:         bridgev2.RemoteEventChatResync,
				PortalKey:    c.portalKey(p.ID),
				CreatePortal: true,
				LogContext: func(lc zerolog.Context) zerolog.Context {
					return lc.Str("demo_portal", string(p.ID))
				},
			},
			GetChatInfoFunc: c.GetChatInfo,
			CheckNeedsBackfillFunc: func(ctx context.Context, latest *database.Message) (bool, error) {
				return latest == nil, nil
			},
		})
	}
}

func (c *Client) Disconnect()      { c.connected.Store(false) }
func (c *Client) IsLoggedIn() bool { return c.connected.Load() }

func (c *Client) LogoutRemote(ctx context.Context) { c.connected.Store(false) }

func (c *Client) GetUserID() networkid.UserID { return c.ownID() }

func (c *Client) IsThisUser(ctx context.Context, userID networkid.UserID) bool {
	return userID == c.ownID()
}

func userInfo(id networkid.UserID) *bridgev2.UserInfo {
	ct, ok := contacts[id]
	if !ok {
		return nil
	}
	name := ct.Name
	return &bridgev2.UserInfo{Name: &name, Identifiers: []string{"demo:" + string(id)}}
}

func (c *Client) GetChatInfo(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	def := getPortal(portal.ID)
	if def == nil {
		return nil, fmt.Errorf("unknown demo portal %q", portal.ID)
	}
	members := bridgev2.ChatMemberMap{}
	members.Set(bridgev2.ChatMember{
		EventSender: bridgev2.EventSender{IsFromMe: true, SenderLogin: c.login.ID, Sender: c.ownID()},
		Membership:  event.MembershipJoin,
	})
	for _, m := range def.Members {
		members.Set(bridgev2.ChatMember{
			EventSender: bridgev2.EventSender{Sender: m},
			Membership:  event.MembershipJoin,
			UserInfo:    userInfo(m),
		})
	}
	roomType := def.Type
	info := &bridgev2.ChatInfo{
		Type:        &roomType,
		CanBackfill: true,
		Members:     &bridgev2.ChatMemberList{IsFull: true, MemberMap: members, TotalMemberCount: len(members)},
	}
	if def.Type == database.RoomTypeDM {
		info.Members.OtherUserID = def.Members[0]
	} else {
		name := def.Name
		info.Name = &name
	}
	return info, nil
}

func (c *Client) GetUserInfo(ctx context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	return userInfo(ghost.ID), nil
}

func (c *Client) GetCapabilities(ctx context.Context, portal *bridgev2.Portal) *event.RoomFeatures {
	// No file features: bridgev2 rejects media before HandleMatrixMessage is called.
	return &event.RoomFeatures{
		ID:            "com.agentstudio.demo.capabilities.v1",
		MaxTextLength: maxTextLength,
		Reply:         event.CapLevelPartialSupport,
	}
}

func textContent(text string) *bridgev2.ConvertedMessage {
	return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
		Type:    event.EventMessage,
		Content: &event.MessageEventContent{MsgType: event.MsgText, Body: text},
	}}}
}

// FetchMessages serves the deterministic starting messages for the first forward backfill
// of an empty portal. Everything else (paging back, catch-up) has nothing to return.
func (c *Client) FetchMessages(ctx context.Context, params bridgev2.FetchMessagesParams) (*bridgev2.FetchMessagesResponse, error) {
	def := getPortal(params.Portal.ID)
	if def == nil || !params.Forward || params.AnchorMessage != nil {
		return &bridgev2.FetchMessagesResponse{HasMore: false, Forward: params.Forward}, nil
	}
	loginAt := time.UnixMilli(c.meta().LoginAt)
	if c.meta().LoginAt == 0 {
		loginAt = time.Now()
	}
	msgs := make([]*bridgev2.BackfillMessage, 0, len(def.Messages))
	for i, m := range def.Messages {
		msgs = append(msgs, &bridgev2.BackfillMessage{
			ConvertedMessage: textContent(m.Text),
			Sender:           bridgev2.EventSender{Sender: m.Sender},
			ID:               networkid.MessageID(fmt.Sprintf("%s-start-%d", def.ID, i)),
			Timestamp:        loginAt.Add(-m.Age),
			StreamOrder:      int64(i + 1),
		})
	}
	return &bridgev2.FetchMessagesResponse{Messages: msgs, HasMore: false, Forward: true}, nil
}

func randomID(prefix string) networkid.MessageID {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return networkid.MessageID(prefix + "-" + hex.EncodeToString(b))
}

// HandleMatrixMessage "sends" a text message to the demo network and schedules the
// first ghost's echo reply.
func (c *Client) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	def := getPortal(msg.Portal.ID)
	if def == nil {
		return nil, fmt.Errorf("unknown demo portal %q", msg.Portal.ID)
	}
	var text string
	switch msg.Content.MsgType {
	case event.MsgText, event.MsgNotice:
		text = msg.Content.Body
	case event.MsgEmote:
		text = "* " + msg.Content.Body
	default:
		return nil, errMediaNotSupported
	}
	if strings.TrimSpace(text) == "" {
		return nil, bridgev2.WrapErrorInStatus(errors.New("empty message")).WithErrorAsMessage().WithIsCertain(true)
	}
	if len(text) > maxTextLength {
		return nil, bridgev2.WrapErrorInStatus(errors.New("message too long")).WithErrorAsMessage().WithIsCertain(true)
	}
	now := time.Now()
	resp := &bridgev2.MatrixMessageResponse{DB: &database.Message{
		ID:        randomID("out"),
		SenderID:  c.ownID(),
		Timestamp: now,
	}}
	replier := def.Members[0]
	portalID := def.ID
	go func() {
		time.Sleep(c.conn.EchoDelay)
		c.queueIncoming(portalID, replier, "Echo: "+text)
	}()
	return resp, nil
}

// queueIncoming injects a message from a demo contact into one of this login's portals.
func (c *Client) queueIncoming(portalID networkid.PortalID, sender networkid.UserID, text string) networkid.MessageID {
	msgID := randomID("in")
	c.login.QueueRemoteEvent(&simplevent.PreConvertedMessage{
		EventMeta: simplevent.EventMeta{
			Type:         bridgev2.RemoteEventMessage,
			PortalKey:    c.portalKey(portalID),
			Sender:       bridgev2.EventSender{Sender: sender},
			CreatePortal: true,
			Timestamp:    time.Now(),
		},
		ID:   msgID,
		Data: textContent(text),
	})
	return msgID
}
