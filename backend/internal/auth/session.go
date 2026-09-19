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

// Enough to keep a useful group list for display without approaching the
// per-cookie size limit.
const maxCookieGroups = 16

var ErrInvalidSession = errors.New("invalid session")

// sessionPayload is what the cookie carries, JSON then base64url. The claims
// are trimmed first: a user in many IdP groups could otherwise push the cookie
// past the ~4KB browser limit, at which point the browser silently drops it and
// the user loops through login with no server-side error to show for it.
type sessionPayload struct {
	Claims  Claims `json:"claims"`
	Expires int64  `json:"exp"`
}

// SessionCodec signs and verifies session cookies.
type SessionCodec struct {
	secret    []byte
	secure    bool
	ttl       time.Duration
	keepGroup string // the group requireAuth checks; never trimmed away
}

// NewSessionCodec returns a codec over the given secret. keepGroup is the group
// the authorization check reads; it is preserved when the group list is capped.
func NewSessionCodec(secret string, secure bool, ttl time.Duration, keepGroup string) *SessionCodec {
	return &SessionCodec{secret: []byte(secret), secure: secure, ttl: ttl, keepGroup: keepGroup}
}

// Encode returns a signed cookie carrying the claims.
func (c *SessionCodec) Encode(claims Claims) (*http.Cookie, error) {
	expires := time.Now().Add(c.ttl)
	body, err := json.Marshal(sessionPayload{Claims: trimForCookie(claims, c.keepGroup), Expires: expires.Unix()})
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

// trimForCookie caps the group list. The group the request path checks must
// survive the cut, or requireAuth would reject a user who is in fact a member:
// keep it first, then fill the rest up to the cap.
func trimForCookie(claims Claims, keep string) Claims {
	if len(claims.Groups) <= maxCookieGroups {
		return claims
	}
	trimmed := make([]string, 0, maxCookieGroups)
	// Append the IdP's own spelling, not the configured one: authorization is
	// case-insensitive, but /api/auth/me would otherwise report a group name
	// the IdP never issued.
	for _, g := range claims.Groups {
		if keep != "" && strings.EqualFold(g, keep) {
			trimmed = append(trimmed, g)
			break
		}
	}
	for _, g := range claims.Groups {
		if len(trimmed) == maxCookieGroups {
			break
		}
		if keep == "" || !strings.EqualFold(g, keep) {
			trimmed = append(trimmed, g)
		}
	}
	claims.Groups = trimmed
	return claims
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
