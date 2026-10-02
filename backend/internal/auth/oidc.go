// OIDC relying party: authorization code flow with PKCE against Authelia, with
// state, nonce and the PKCE verifier carried in short-lived cookies. Ported from peeq's internal/auth, minus
// the parts that needed a database.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	oidcStateCookieName = "tmui_oidc_state"
	oidcNonceCookieName = "tmui_oidc_nonce"
	oidcPKCECookieName  = "tmui_oidc_pkce"
)

// Errors returned when an OIDC callback fails its anti-forgery checks: the
// state parameter or the id token's nonce did not match the one issued with
// the redirect.
var (
	ErrInvalidState = errors.New("invalid oidc state")
	ErrInvalidNonce = errors.New("invalid oidc nonce")
)

// Claims is the identity we keep from the ID token.
type Claims struct {
	Subject           string
	PreferredUsername string
	Email             string
	Name              string
	Groups            []string
}

// HasGroup reports whether the claims carry the given group. An empty group
// means "no group check configured", which matches every authenticated user.
func (c Claims) HasGroup(group string) bool {
	if group == "" {
		return true
	}
	for _, g := range c.Groups {
		if strings.EqualFold(g, group) {
			return true
		}
	}
	return false
}

// OIDCServiceConfig configures OIDC login and callback handling.
type OIDCServiceConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	SecureCookie bool
	BasePath     string
}

// OIDCService handles OIDC redirects and callback validation.
type OIDCService struct {
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	secure   bool
	path     string
}

// NewOIDCServiceFromDiscovery discovers the configured provider.
func NewOIDCServiceFromDiscovery(ctx context.Context, cfg OIDCServiceConfig) (*OIDCService, error) {
	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discover oidc provider: %w", err)
	}
	return &OIDCService{
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Endpoint:     provider.Endpoint(),
			// "groups" is what the allowed-group check reads; Authelia only emits
			// the claim when the scope is requested.
			Scopes: []string{oidc.ScopeOpenID, "profile", "email", "groups"},
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		secure:   cfg.SecureCookie,
		path:     cookiePath(cfg.BasePath),
	}, nil
}

// StartLogin redirects to the provider and stores the state, nonce and PKCE
// verifier in cookies for the callback.
func (s *OIDCService) StartLogin(w http.ResponseWriter, r *http.Request) {
	state := randomToken()
	nonce := randomToken()
	// PKCE on top of the client secret: an authorization code lifted off the
	// redirect is useless without the verifier, which never leaves this cookie.
	verifier := oauth2.GenerateVerifier()
	http.SetCookie(w, s.transientCookie(oidcStateCookieName, state))
	http.SetCookie(w, s.transientCookie(oidcNonceCookieName, nonce))
	http.SetCookie(w, s.transientCookie(oidcPKCECookieName, verifier))
	http.Redirect(w, r, s.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

// HandleCallback validates callback state, verifies tokens, and returns claims.
func (s *OIDCService) HandleCallback(r *http.Request) (Claims, error) {
	stateCookie, err := r.Cookie(oidcStateCookieName)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		return Claims{}, ErrInvalidState
	}
	nonceCookie, err := r.Cookie(oidcNonceCookieName)
	if err != nil || nonceCookie.Value == "" {
		return Claims{}, ErrInvalidNonce
	}
	pkceCookie, err := r.Cookie(oidcPKCECookieName)
	if err != nil || pkceCookie.Value == "" {
		return Claims{}, ErrInvalidState
	}
	token, err := s.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(pkceCookie.Value))
	if err != nil {
		return Claims{}, fmt.Errorf("exchange oidc code: %w", err)
	}
	claims, nonce, err := s.verify(r.Context(), token)
	if err != nil {
		return Claims{}, fmt.Errorf("verify oidc claims: %w", err)
	}
	if nonce == "" || nonce != nonceCookie.Value {
		return Claims{}, ErrInvalidNonce
	}
	return claims, nil
}

func (s *OIDCService) transientCookie(name, value string) *http.Cookie {
	return &http.Cookie{ //nolint:gosec // HttpOnly and SameSite are set below; Secure is config-driven so local development over plain HTTP still works
		Name:     name,
		Value:    value,
		Path:     s.path,
		Expires:  time.Now().Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearTransientCookies clears the cookies set by StartLogin.
func (s *OIDCService) ClearTransientCookies(w http.ResponseWriter) {
	for _, name := range []string{oidcStateCookieName, oidcNonceCookieName, oidcPKCECookieName} {
		http.SetCookie(w, s.expiredCookie(name))
	}
}

func (s *OIDCService) expiredCookie(name string) *http.Cookie {
	return &http.Cookie{ //nolint:gosec // HttpOnly and SameSite are set below; Secure is config-driven so local development over plain HTTP still works
		Name:     name,
		Value:    "",
		Path:     s.path,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// verify checks the ID token and returns its claims and nonce.
func (s *OIDCService) verify(ctx context.Context, token *oauth2.Token) (Claims, string, error) {
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return Claims{}, "", errors.New("missing id_token")
	}
	idToken, err := s.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return Claims{}, "", err
	}
	var oidcClaims struct {
		PreferredUsername string   `json:"preferred_username"`
		Email             string   `json:"email"`
		Name              string   `json:"name"`
		GivenName         string   `json:"given_name"`
		FamilyName        string   `json:"family_name"`
		Groups            []string `json:"groups"`
	}
	if err := idToken.Claims(&oidcClaims); err != nil {
		return Claims{}, "", err
	}
	// Prefer given_name + family_name so the full name (incl. last name) is
	// shown, but only when BOTH are present: composing from one half would turn
	// an IdP's "Jan Mueller" into "Jan".
	name := oidcClaims.Name
	if oidcClaims.GivenName != "" && oidcClaims.FamilyName != "" {
		name = oidcClaims.GivenName + " " + oidcClaims.FamilyName
	} else if name == "" {
		name = strings.TrimSpace(oidcClaims.GivenName + " " + oidcClaims.FamilyName)
	}
	return Claims{
		Subject:           idToken.Subject,
		PreferredUsername: oidcClaims.PreferredUsername,
		Email:             oidcClaims.Email,
		Name:              name,
		Groups:            oidcClaims.Groups,
	}, idToken.Nonce, nil
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
