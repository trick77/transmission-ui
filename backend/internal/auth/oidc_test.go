package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

var b64 = base64.RawURLEncoding

// fakeIDP is the provider side of the authorization code flow: discovery, keys
// and a token endpoint that enforces PKCE the way a real one does.
type fakeIDP struct {
	*httptest.Server
	key       *rsa.PrivateKey
	challenge string // code_challenge from the authorization request
	nonce     string // nonce to put in the ID token
	exchanges int
}

func newFakeIDP(t *testing.T) *fakeIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIDP{key: key}
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		reply(w, map[string]any{
			"issuer": idp.URL, "authorization_endpoint": idp.URL + "/auth", "token_endpoint": idp.URL + "/token",
			"jwks_uri": idp.URL + "/jwks", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		reply(w, map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": b64.EncodeToString(key.N.Bytes()), "e": b64.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		idp.exchanges++
		sum := sha256.Sum256([]byte(r.PostFormValue("code_verifier")))
		if r.PostFormValue("code") != "the-code" || idp.challenge == "" || b64.EncodeToString(sum[:]) != idp.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		reply(w, map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": idp.idToken(t)})
	})
	idp.Server = httptest.NewServer(mux)
	t.Cleanup(idp.Close)
	return idp
}

func (idp *fakeIDP) idToken(t *testing.T) string {
	t.Helper()
	part := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b64.EncodeToString(raw)
	}
	signed := part(map[string]string{"alg": "RS256", "kid": "k1"}) + "." + part(map[string]any{
		"iss": idp.URL, "sub": "user-1", "aud": "client", "nonce": idp.nonce,
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
		"given_name": "Ada", "family_name": "Lovelace", "groups": []string{"media"},
	})
	sum := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, idp.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + b64.EncodeToString(sig)
}

// login runs StartLogin and returns the callback request a browser would make,
// having told the IdP what the authorization request carried.
func login(t *testing.T, idp *fakeIDP) (*OIDCService, *http.Request) {
	t.Helper()
	svc, err := NewOIDCServiceFromDiscovery(context.Background(), OIDCServiceConfig{
		Issuer: idp.URL, ClientID: "client", ClientSecret: "secret", RedirectURL: "https://app.example/api/auth/callback",
	})
	if err != nil {
		t.Fatalf("discovery: %v", err)
	}
	rec := httptest.NewRecorder()
	svc.StartLogin(rec, httptest.NewRequest(http.MethodGet, "/api/auth/login", nil))
	to, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	q := to.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		t.Fatalf("authorization request carries no S256 challenge: %s", to.RawQuery)
	}
	idp.challenge, idp.nonce = q.Get("code_challenge"), q.Get("nonce")

	back := httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=the-code&state="+url.QueryEscape(q.Get("state")), nil)
	for _, c := range rec.Result().Cookies() {
		back.AddCookie(c)
	}
	return svc, back
}

func TestCallbackCompletesWithPKCE(t *testing.T) {
	idp := newFakeIDP(t)
	svc, back := login(t, idp)
	claims, err := svc.HandleCallback(back)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if claims.Subject != "user-1" || claims.Name != "Ada Lovelace" || !claims.HasGroup("Media") {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

// The verifier lives only in the cookie. A callback without it must not reach
// the token endpoint, and one with the wrong verifier must be refused there.
func TestCallbackNeedsTheVerifier(t *testing.T) {
	idp := newFakeIDP(t)
	svc, back := login(t, idp)

	without := httptest.NewRequest(http.MethodGet, back.URL.String(), nil)
	wrong := httptest.NewRequest(http.MethodGet, back.URL.String(), nil)
	for _, c := range back.Cookies() {
		if c.Name != oidcPKCECookieName {
			without.AddCookie(c)
			wrong.AddCookie(c)
		}
	}
	if _, err := svc.HandleCallback(without); !errors.Is(err, ErrInvalidState) || idp.exchanges != 0 {
		t.Fatalf("no verifier: want ErrInvalidState before any exchange, got %v after %d", err, idp.exchanges)
	}
	wrong.AddCookie(&http.Cookie{Name: oidcPKCECookieName, Value: "not-the-verifier-that-was-challenged-0123456789"})
	if _, err := svc.HandleCallback(wrong); err == nil {
		t.Fatal("a wrong verifier was accepted")
	}
}

func TestCallbackRejectsForgedStateAndNonce(t *testing.T) {
	idp := newFakeIDP(t)
	svc, back := login(t, idp)

	forged := httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=the-code&state=someone-elses", nil)
	for _, c := range back.Cookies() {
		forged.AddCookie(c)
	}
	if _, err := svc.HandleCallback(forged); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("forged state: want ErrInvalidState, got %v", err)
	}

	idp.nonce = "replayed-from-another-login"
	if _, err := svc.HandleCallback(back); !errors.Is(err, ErrInvalidNonce) {
		t.Fatalf("foreign nonce: want ErrInvalidNonce, got %v", err)
	}
}

func TestClearTransientCookiesCoversAllThree(t *testing.T) {
	rec := httptest.NewRecorder()
	(&OIDCService{path: "/"}).ClearTransientCookies(rec)
	if n := len(rec.Result().Cookies()); n != 3 {
		t.Fatalf("want state, nonce and verifier cleared, got %d cookies", n)
	}
}
