// OIDC relying party: authorization code flow against Authelia, with state and
// nonce carried in short-lived cookies. Ported from peeq's internal/auth, minus
// the parts that needed a database.
package auth

import (
	"context"
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
)

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

// VerifiedClaims contains claims plus the ID token nonce after verification.
type VerifiedClaims struct {
	Claims Claims
	Nonce  string
}

// OIDCBackend is the testable seam over oauth2 and go-oidc behavior.
type OIDCBackend interface {
	AuthCodeURL(state string, opts ...oauth2.AuthCodeOption) string
	Exchange(context.Context, string) (*oauth2.Token, error)
	VerifyClaims(context.Context, *oauth2.Token) (VerifiedClaims, error)
}

// OIDCServiceConfig configures OIDC login and callback handling.
type OIDCServiceConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Backend      OIDCBackend
	SecureCookie bool
}

// OIDCService handles OIDC redirects and callback validation.
type OIDCService struct {
	backend OIDCBackend
	secure  bool
}

// NewOIDCService creates a service from a pre-built backend (a fake, in tests).
func NewOIDCService(cfg OIDCServiceConfig) *OIDCService {
	return &OIDCService{backend: cfg.Backend, secure: cfg.SecureCookie}
}

// NewOIDCServiceFromDiscovery discovers the configured provider.
func NewOIDCServiceFromDiscovery(ctx context.Context, cfg OIDCServiceConfig) (*OIDCService, error) {
	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discover oidc provider: %w", err)
	}
	oauthConfig := oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RedirectURL:  cfg.RedirectURL,
		Endpoint:     provider.Endpoint(),
		// "groups" is what the allowed-group check reads; Authelia only emits
		// the claim when the scope is requested.
		Scopes: []string{oidc.ScopeOpenID, "profile", "email", "groups"},
	}
	return &OIDCService{
		backend: realOIDCBackend{
			oauthConfig: oauthConfig,
			verifier:    provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		},
		secure: cfg.SecureCookie,
	}, nil
}

// StartLogin redirects to the provider and stores state/nonce cookies.
func (s *OIDCService) StartLogin(w http.ResponseWriter, r *http.Request) {
	state := randomToken()
	nonce := randomToken()
	http.SetCookie(w, s.transientCookie(oidcStateCookieName, state))
	http.SetCookie(w, s.transientCookie(oidcNonceCookieName, nonce))
	http.Redirect(w, r, s.backend.AuthCodeURL(state, oidc.Nonce(nonce)), http.StatusFound)
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
	token, err := s.backend.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		return Claims{}, fmt.Errorf("exchange oidc code: %w", err)
	}
	verified, err := s.backend.VerifyClaims(r.Context(), token)
	if err != nil {
		return Claims{}, fmt.Errorf("verify oidc claims: %w", err)
	}
	if verified.Nonce == "" || verified.Nonce != nonceCookie.Value {
		return Claims{}, ErrInvalidNonce
	}
	return verified.Claims, nil
}

func (s *OIDCService) transientCookie(name, value string) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Expires:  time.Now().Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearTransientCookies clears the state and nonce cookies set by StartLogin.
func (s *OIDCService) ClearTransientCookies(w http.ResponseWriter) {
	http.SetCookie(w, s.expiredCookie(oidcStateCookieName))
	http.SetCookie(w, s.expiredCookie(oidcNonceCookieName))
}

func (s *OIDCService) expiredCookie(name string) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

type realOIDCBackend struct {
	oauthConfig oauth2.Config
	verifier    *oidc.IDTokenVerifier
}

func (b realOIDCBackend) AuthCodeURL(state string, opts ...oauth2.AuthCodeOption) string {
	return b.oauthConfig.AuthCodeURL(state, opts...)
}

func (b realOIDCBackend) Exchange(ctx context.Context, code string) (*oauth2.Token, error) {
	return b.oauthConfig.Exchange(ctx, code)
}

func (b realOIDCBackend) VerifyClaims(ctx context.Context, token *oauth2.Token) (VerifiedClaims, error) {
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return VerifiedClaims{}, fmt.Errorf("missing id_token")
	}
	idToken, err := b.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return VerifiedClaims{}, err
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
		return VerifiedClaims{}, err
	}
	name := oidcClaims.Name
	if composed := strings.TrimSpace(oidcClaims.GivenName + " " + oidcClaims.FamilyName); composed != "" {
		name = composed
	}
	return VerifiedClaims{
		Claims: Claims{
			Subject:           idToken.Subject,
			PreferredUsername: oidcClaims.PreferredUsername,
			Email:             oidcClaims.Email,
			Name:              name,
			Groups:            oidcClaims.Groups,
		},
		Nonce: idToken.Nonce,
	}, nil
}
