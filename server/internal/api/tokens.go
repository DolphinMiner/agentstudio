package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	accessTTL     = 15 * time.Minute
	refreshTTL    = 60 * 24 * time.Hour
	codeTTL       = 10 * time.Minute
	codeResendGap = 30 * time.Second
	codeMaxTries  = 5
)

// lowerB32 is base32 with lowercase letters and no padding: safe in Matrix
// localparts, URLs and device ids.
var lowerB32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// newID returns prefix + "_" + 16 random lowercase base32 chars (80 bits).
func newID(prefix string) string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return prefix + "_" + lowerB32.EncodeToString(b)
}

// newSecretToken returns a 32-byte random token, base64url encoded.
func newSecretToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// newOTP returns a uniformly random 6-digit code.
func newOTP() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

// sha256Hex hashes a high-entropy secret (refresh tokens).
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// hashOTP hashes an email code with HMAC-SHA256 keyed by the token secret and
// bound to the email, so a leaked table cannot be brute-forced offline.
func hashOTP(secret []byte, email, code string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(email + "\x00" + code))
	return hex.EncodeToString(m.Sum(nil))
}

func constantTimeEq(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

// normalizeEmail lowercases and validates an email address loosely.
func normalizeEmail(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	at := strings.LastIndexByte(s, '@')
	if at < 1 || at == len(s)-1 || len(s) > 254 || strings.ContainsAny(s, " \t\r\n<>,;") {
		return "", false
	}
	return s, true
}

// emailLocalPart is used as the initial Matrix display name.
func emailLocalPart(email string) string {
	if at := strings.LastIndexByte(email, '@'); at > 0 {
		return email[:at]
	}
	return email
}

// matrixLocalpart derives the Matrix localpart from a user id ("u_" + id).
func matrixLocalpart(userID string) string { return "u_" + strings.ToLower(userID) }

// deviceIDForSession derives the Matrix device id from the session id.
func deviceIDForSession(sessionID string) string {
	return "AGENTSTUDIO_" + strings.ToUpper(strings.TrimPrefix(sessionID, "ses_"))
}

type accessClaims struct {
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

// issueAccessToken mints a 15-minute HS256 access token.
func issueAccessToken(secret []byte, userID, sessionID string, now time.Time) (string, time.Time, error) {
	exp := now.Add(accessTTL)
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims{
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "agentstudio",
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	})
	s, err := tok.SignedString(secret)
	return s, exp, err
}

// parseAccessToken validates an access token and returns (user id, session id).
func parseAccessToken(secret []byte, raw string, now time.Time) (string, string, error) {
	var c accessClaims
	_, err := jwt.ParseWithClaims(raw, &c, func(*jwt.Token) (any, error) { return secret, nil },
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer("agentstudio"),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	if err != nil {
		return "", "", err
	}
	if c.Subject == "" || c.SessionID == "" {
		return "", "", errors.New("missing claims")
	}
	return c.Subject, c.SessionID, nil
}

// synapseLoginJWT mints the short-lived token for Synapse's org.matrix.login.jwt.
func synapseLoginJWT(secret []byte, localpart string, now time.Time) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   localpart,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
	}).SignedString(secret)
}
