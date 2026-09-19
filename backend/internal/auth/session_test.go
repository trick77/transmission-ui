package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func requestWithCookie(c *http.Cookie) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if c != nil {
		r.AddCookie(c)
	}
	return r
}

func TestSessionRoundTrip(t *testing.T) {
	codec := NewSessionCodec("secret", false, time.Hour, "")
	claims := Claims{Subject: "u1", PreferredUsername: "jan", Groups: []string{"Arr"}}

	cookie, err := codec.Encode(claims)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := codec.Decode(requestWithCookie(cookie))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Subject != "u1" || got.PreferredUsername != "jan" {
		t.Fatalf("claims not preserved: %+v", got)
	}
	if !got.HasGroup("Arr") {
		t.Fatal("group not preserved")
	}
}

// A tampered payload must not verify: this is the whole point of the signature.
func TestSessionRejectsTamperedPayload(t *testing.T) {
	codec := NewSessionCodec("secret", false, time.Hour, "")
	cookie, err := codec.Encode(Claims{Subject: "u1", Groups: []string{"nobody"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	payload, sig, _ := strings.Cut(cookie.Value, ".")
	forged := NewSessionCodec("other-secret", false, time.Hour, "")
	other, _ := forged.Encode(Claims{Subject: "attacker", Groups: []string{"Arr"}})
	otherPayload, _, _ := strings.Cut(other.Value, ".")

	// Attacker payload, original signature.
	cookie.Value = otherPayload + "." + sig
	if _, err := codec.Decode(requestWithCookie(cookie)); err == nil {
		t.Fatal("tampered payload accepted")
	}
	// Original payload, attacker signature.
	cookie.Value = payload + ".AAAA"
	if _, err := codec.Decode(requestWithCookie(cookie)); err == nil {
		t.Fatal("bad signature accepted")
	}
}

// A cookie signed with a different secret must not verify, so rotating
// BACKEND_SESSION_SECRET really does invalidate outstanding sessions.
func TestSessionRejectsForeignSecret(t *testing.T) {
	cookie, err := NewSessionCodec("secret-a", false, time.Hour, "").Encode(Claims{Subject: "u1"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, err := NewSessionCodec("secret-b", false, time.Hour, "").Decode(requestWithCookie(cookie)); err == nil {
		t.Fatal("cookie from another secret accepted")
	}
}

func TestSessionRejectsExpired(t *testing.T) {
	codec := NewSessionCodec("secret", false, -time.Minute, "")
	cookie, err := codec.Encode(Claims{Subject: "u1"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, err := codec.Decode(requestWithCookie(cookie)); err == nil {
		t.Fatal("expired session accepted")
	}
}

func TestSessionRejectsMissingOrMalformed(t *testing.T) {
	codec := NewSessionCodec("secret", false, time.Hour, "")
	if _, err := codec.Decode(requestWithCookie(nil)); err == nil {
		t.Fatal("missing cookie accepted")
	}
	if _, err := codec.Decode(requestWithCookie(&http.Cookie{Name: SessionCookieName, Value: "no-dot"})); err == nil {
		t.Fatal("malformed cookie accepted")
	}
}

// A user in more groups than the cap must keep the one that gets checked, or
// requireAuth would reject a legitimate member on the next request.
func TestSessionKeepsCheckedGroupWhenTrimming(t *testing.T) {
	many := make([]string, 0, 40)
	for i := range 40 {
		many = append(many, fmt.Sprintf("group-%02d", i))
	}
	many = append(many, "Arr") // last, so a naive head-truncation drops it
	codec := NewSessionCodec("secret", false, time.Hour, "Arr")

	cookie, err := codec.Encode(Claims{Subject: "u1", Groups: many})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(cookie.Value) > 4096 {
		t.Fatalf("cookie too large: %d bytes", len(cookie.Value))
	}
	got, err := codec.Decode(requestWithCookie(cookie))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.HasGroup("Arr") {
		t.Fatalf("checked group dropped by trimming: %v", got.Groups)
	}
	if len(got.Groups) > maxCookieGroups {
		t.Fatalf("group list not capped: %d", len(got.Groups))
	}
}

// The cookie must carry the IdP's spelling of the group, not the configured
// one, so /api/auth/me does not report a name the IdP never issued.
func TestSessionKeepsIdPGroupSpelling(t *testing.T) {
	many := make([]string, 0, 30)
	for i := range 30 {
		many = append(many, fmt.Sprintf("group-%02d", i))
	}
	many = append(many, "Arr")
	// Configured lower-case; the IdP emits "Arr".
	codec := NewSessionCodec("secret", false, time.Hour, "arr")

	cookie, err := codec.Encode(Claims{Subject: "u1", Groups: many})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := codec.Decode(requestWithCookie(cookie))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	found := ""
	for _, g := range got.Groups {
		if strings.EqualFold(g, "arr") {
			found = g
		}
	}
	if found != "Arr" {
		t.Fatalf("group spelling rewritten: got %q, want %q", found, "Arr")
	}
}

func TestHasGroup(t *testing.T) {
	c := Claims{Groups: []string{"Arr", "Tools"}}
	if !c.HasGroup("arr") {
		t.Fatal("group match should ignore case")
	}
	if c.HasGroup("Media") {
		t.Fatal("unexpected group matched")
	}
	// Empty required group = no check configured.
	if !c.HasGroup("") {
		t.Fatal("empty group should match")
	}
	if (Claims{}).HasGroup("Arr") {
		t.Fatal("claims without groups should not match")
	}
}
