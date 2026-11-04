// Package demo implements the AgentStudio "demo" network: a simulated, deterministic chat
// network bridged to Matrix with mautrix bridgev2. See docs/matrix-events.md "Demo network".
package demo

import (
	"crypto/sha256"
	"encoding/hex"
	"time"

	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// Contact is a simulated remote user. Its ID is the bridgev2 ghost ID (Matrix localpart demo_<ID>,
// passed through id.EncodeUserLocalpart, which keeps "+", so "+15550101" is @demo_+15550101).
type Contact struct {
	ID   networkid.UserID
	Name string
}

// StartMessage is one of a portal's deterministic starting messages.
type StartMessage struct {
	Sender networkid.UserID
	Text   string
	// Age is how long before the login time the message was "sent".
	Age time.Duration
}

// PortalDef describes one simulated chat.
type PortalDef struct {
	ID   networkid.PortalID
	Name string // group name; DMs take their name from the ghost (private_chat_portal_meta)
	Type database.RoomType
	// Members are the remote participants, in order. Members[0] is the "first ghost" that replies.
	Members  []networkid.UserID
	Messages []StartMessage
}

var contacts = map[networkid.UserID]Contact{
	"mom":       {ID: "mom", Name: "Mom"},
	"leo":       {ID: "leo", Name: "Leo Park"},
	"mia":       {ID: "mia", Name: "Mia Chen"},
	"+15550101": {ID: "+15550101", Name: "+1 555 0101"},
}

// portals is the fixed set of chats every demo login has, in creation order.
var portals = []PortalDef{
	{
		ID: "mom", Type: database.RoomTypeDM, Members: []networkid.UserID{"mom"},
		Messages: []StartMessage{{Sender: "mom", Text: "Did you eat yet?", Age: 25 * time.Minute}},
	},
	{
		ID: "leo", Type: database.RoomTypeDM, Members: []networkid.UserID{"leo"},
		Messages: []StartMessage{
			{Sender: "leo", Text: "Hey! Long time", Age: 14 * time.Minute},
			{Sender: "leo", Text: "Are we still on for 7:15?", Age: 12 * time.Minute},
		},
	},
	{
		ID: "bookclub", Name: "Book Club", Type: database.RoomTypeDefault, Members: []networkid.UserID{"mia", "+15550101"},
		Messages: []StartMessage{
			{Sender: "mia", Text: "Chapter 4 tonight?", Age: 8 * time.Minute},
			{Sender: "+15550101", Text: "I'm in", Age: 7 * time.Minute},
		},
	},
}

func getPortal(id networkid.PortalID) *PortalDef {
	for i := range portals {
		if portals[i].ID == id {
			return &portals[i]
		}
	}
	return nil
}

func (p *PortalDef) hasMember(user networkid.UserID) bool {
	for _, m := range p.Members {
		if m == user {
			return true
		}
	}
	return false
}

// LoginID returns the deterministic user_login_id for a Matrix user: demo-<sha256(mxid)[:12]>.
func LoginID(owner id.UserID) networkid.UserLoginID {
	sum := sha256.Sum256([]byte(owner))
	return networkid.UserLoginID("demo-" + hex.EncodeToString(sum[:])[:12])
}

// UserLoginMetadata is stored in the bridge database with each login.
type UserLoginMetadata struct {
	DisplayName string `json:"display_name"`
	// LoginAt (unix ms) anchors the timestamps of the starting messages.
	LoginAt int64 `json:"login_at"`
}
