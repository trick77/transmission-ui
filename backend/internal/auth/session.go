// Session state in a signed cookie. peeq keeps sessions in its database; this
// app has none, so the claims travel in the cookie itself, authenticated with
// HMAC-SHA256 over the payload. The secret is BACKEND_SESSION_SECRET, so
// rotating it invalidates every outstanding session.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const SessionCookieName = "tmui_session"

var ErrInvalidSession = errors.New("invalid session")

// sessionPayload is what the cookie carries, JSON then base64url.
type sessionPayload struct {
	Claims  Claims `json:"claims"`
	Expires int64  `json:"exp"`
}

// SessionCodec signs and verifies session cookies.
type SessionCodec struct {
	secret []byte
	secure bool
	ttl    time.Duration
}

// NewSessionCodec returns a codec over the given secret.
func NewSessionCodec(secret string, secure bool, ttl time.Duration) *SessionCodec {
	return &SessionCodec{secret: []byte(secret), secure: secure, ttl: ttl}
}

// Encode returns a signed cookie carrying the claims.
func (c *SessionCodec) Encode(claims Claims) (*http.Cookie, error) {
	expires := time.Now().Add(c.ttl)
	body, err := json.Marshal(sessionPayload{Claims: claims, Expires: expires.Unix()})
	if err != nil {
		return nil, fmt.Errorf("encode session: %w", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	value := payload + "." + c.sign(payload)
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   c.secure,
		SameSite: http.SameSiteLaxMode,
	}, nil
}

// Decode verifies the cookie on a request and returns its claims.
func (c *SessionCodec) Decode(r *http.Request) (Claims, error) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil || cookie.Value == "" {
		return Claims{}, ErrInvalidSession
	}
	payload, sig, ok := strings.Cut(cookie.Value, ".")
	if !ok {
		return Claims{}, ErrInvalidSession
	}
	// Constant time: a timing oracle here would leak the signature byte by byte.
	if subtle.ConstantTimeCompare([]byte(sig), []byte(c.sign(payload))) != 1 {
		return Claims{}, ErrInvalidSession
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return Claims{}, ErrInvalidSession
	}
	var decoded sessionPayload
	if err := json.Unmarshal(body, &decoded); err != nil {
		return Claims{}, ErrInvalidSession
	}
	if time.Now().After(time.Unix(decoded.Expires, 0)) {
		return Claims{}, ErrInvalidSession
	}
	return decoded.Claims, nil
}

// ClearCookie returns a cookie that removes the session.
func (c *SessionCodec) ClearCookie() *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   c.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

func (c *SessionCodec) sign(payload string) string {
	mac := hmac.New(sha256.New, c.secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// randomToken returns a URL-safe random token, used for OIDC state and nonce.
func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing is not recoverable and must never silently
		// degrade into a predictable state value.
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}
