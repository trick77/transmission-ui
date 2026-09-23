// Form login, for deployments with no identity provider. Credentials are the
// daemon's own RPC user and password, so there is nothing extra to provision:
// whoever may drive transmission-remote may drive the web UI.
package httpapi

import (
	"crypto/subtle"
	"embed"
	"html/template"
	"io/fs"
	"net/http"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// The page is served before any bundle loads, so it cannot use the hashed asset
// names Vite emits. Its background and fonts are embedded here instead and
// served from /login-assets/, which keeps the page self-contained.
//
//go:embed assets
var loginAssets embed.FS

// loginPage is served on GET /login and re-served with an error after a failed
// POST. Tokens are copied from ui/src/styles/app.css so the page reads as part
// of the same app: warm editorial dark, terracotta accent, the same fonts.
var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · transmission-ui</title>
<!-- The bundle's /icon.svg sits behind staticHandler, which this page is served
     before, so the icon is embedded here and served from /login-assets/ like
     the fonts and the background. Same file as ui/icons/icon.svg. -->
<link rel="icon" href="{{.Base}}/login-assets/icon.svg" type="image/svg+xml">
<style>
  @font-face{font-family:"Anthropic Sans";src:url("{{.Base}}/login-assets/SansWebVariable-TextRegular.woff2") format("woff2");font-weight:300 800;font-display:swap}
  @font-face{font-family:"Anthropic Serif";src:url("{{.Base}}/login-assets/SerifWebVariable-TextRegular.woff2") format("woff2");font-weight:300 800;font-display:swap}
  :root{
    color-scheme: dark;
    --bg:#1f1f1e; --surface:#1b1b1a; --surface-2:#2c2c2a; --surface-3:#363632;
    --line:#323230; --ink:#faf9f5; --ink-2:#9c9a92; --ink-3:#6f6d66;
    --accent:#d97757; --accent-fill:#c25f34; --accent-ink:#faf9f5;
    --err:#d9584a; --err-soft:rgba(193,70,56,.16);
    --r:10px; --r-lg:12px;
    --font:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --serif:"Anthropic Serif",Georgia,"Times New Roman",Times,serif;
    --shadow-lg:0 24px 60px -18px rgba(0,0,0,.6);
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{
    display:grid; place-items:center; padding:24px;
    color:var(--ink); font:13px/1.45 var(--font); -webkit-font-smoothing:antialiased;
    /* cover: fill the viewport at any aspect, no letterbox bands. The art is
       16:9, so a very tall window crops the sides; its centre is empty by
       design, which is where the card sits. */
    background:var(--bg) url("{{.Base}}/login-assets/login-bg.webp") center/cover no-repeat fixed;
  }
  /* The art has an empty centre; a soft scrim keeps the card legible over it
     without washing the circuitry out at the edges. */
  body::before{content:"";position:fixed;inset:0;background:radial-gradient(52% 44% at 50% 50%,rgba(31,31,30,.92),rgba(31,31,30,.72) 68%,rgba(31,31,30,.52));}
  .card{
    position:relative; width:100%; max-width:340px;
    background:color-mix(in srgb, var(--surface) 92%, transparent);
    border:1px solid var(--line); border-radius:var(--r-lg);
    box-shadow:var(--shadow-lg); padding:26px 24px 24px;
    backdrop-filter:blur(12px);
  }
  .brand{display:flex;align-items:center;gap:9px;margin-bottom:18px}
  /* The mark, drawn as the favicon draws it: a filled gradient chip with the
     glyph painted through it in the page ground. Geometry mirrors
     ui/icons/icon.svg; change one and change the other. */
  .logo{width:22px;height:22px;flex:none;display:block}
  .name{font-family:var(--serif);font-weight:500;font-size:17px;letter-spacing:-.01em}
  h1{margin:0 0 4px;font-family:var(--serif);font-weight:500;font-size:20px;letter-spacing:-.01em}
  p.sub{margin:0 0 20px;color:var(--ink-2);font-size:12px}
  label{display:block;margin-bottom:6px;font-size:12px;font-weight:500;color:var(--ink-2)}
  input{width:100%;height:34px;margin-bottom:14px;padding:0 11px;border-radius:var(--r);
        border:1px solid var(--line);background:var(--surface-2);color:var(--ink);outline:none}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(217,119,87,.16)}
  button{width:100%;height:34px;border:0;border-radius:var(--r);margin-top:4px;
         background:var(--accent-fill);color:var(--accent-ink);font:inherit;font-weight:500;cursor:pointer;
         box-shadow:0 0 0 1px rgba(217,119,87,.25),0 8px 20px -10px rgba(217,119,87,.5)}
  button:hover{filter:brightness(1.08)}
  .err{margin:0 0 14px;padding:8px 11px;border-radius:var(--r);font-size:12px;
       background:var(--err-soft);color:var(--err)}
  /* oidc mode has no form: the single action is a link, painted as the button. */
  .btn{display:block;width:100%;height:34px;border-radius:var(--r);margin-top:4px;
       text-align:center;text-decoration:none;font:inherit;font-weight:500;line-height:34px;cursor:pointer;
       background:var(--accent);color:#1f1512}
  .btn:hover{filter:brightness(1.08)}
  @media (prefers-reduced-motion:no-preference){.card{animation:rise .18s ease-out}}
  @keyframes rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
</style>
{{if .OIDC}}<div class="card">{{else}}<form class="card" method="post" action="{{.Base}}/login">{{end}}
  <div class="brand">
    <svg class="logo" viewBox="3 3 18 18" aria-hidden="true">
      <linearGradient id="logo-grad" x1="0" y1="0" x2="0.72" y2="1">
        <stop offset="0" stop-color="#e08a68"/>
        <stop offset="1" stop-color="#c25f34"/>
      </linearGradient>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="url(#logo-grad)"/>
      <g transform="translate(4.1238 3.8284) scale(0.65635)" fill="#1f1f1e">
        <path d="M10.5 3.4h3v9.6h-3z"/>
        <path d="M5.5 9.9 7.6 7.8 12 12.2l4.4-4.4 2.1 2.1-6.5 6.5z"/>
        <path d="M3.2 14.9h3v3.6h11.6v-3.6h3v6.6H3.2z"/>
      </g>
    </svg>
    <span class="name">transmission-ui</span>
  </div>
  <h1>Sign in</h1>
{{if .OIDC}}
  <p class="sub">This seedbox is behind single sign-on.</p>
  {{if .Error}}<p class="err">{{.Error}}</p>{{end}}
  <a class="btn" href="{{.Base}}/api/auth/login">Continue to sign in</a>
{{else}}
  <p class="sub">Use the daemon's RPC username and password.</p>
  {{if .Error}}<p class="err">{{.Error}}</p>{{end}}
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
{{end}}
{{if .OIDC}}</div>{{else}}</form>{{end}}
</html>`))

func (s *Server) renderLogin(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = loginPage.Execute(w, struct {
		Error, Base string
		OIDC        bool
	}{msg, s.cfg.BasePath, s.cfg.AuthMode == config.AuthModeOIDC})
}

// loginAssetHandler serves the page's embedded background and fonts. They are
// immutable for the life of the binary, so they cache hard.
func loginAssetHandler(basePath string) http.Handler {
	sub, err := fs.Sub(loginAssets, "assets")
	if err != nil {
		panic(err) // the embed is compile-time; a failure here is a build bug
	}
	files := http.FileServer(http.FS(sub))
	return http.StripPrefix(basePath+"/login-assets/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		files.ServeHTTP(w, r)
	}))
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	// Already signed in: no reason to show the form again.
	if _, err := s.sessions.Decode(r); err == nil {
		http.Redirect(w, r, s.cfg.BasePath+"/", http.StatusFound)
		return
	}
	s.renderLogin(w, http.StatusOK, "")
}

// handleLoginSubmitGuard rejects a form POST when no form is on offer. The route
// is registered in every mode so the assets and page resolve, but only form mode
// has credentials to check.
func (s *Server) handleLoginSubmitGuard(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AuthMode != config.AuthModeForm {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	s.handleLoginSubmit(w, r)
}

func (s *Server) handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		s.renderLogin(w, http.StatusBadRequest, "Could not read the form.")
		return
	}
	user := r.PostFormValue("username")
	pass := r.PostFormValue("password")

	// Constant time on both halves: comparing with == would leak the username
	// and password a byte at a time to anyone who can measure the response.
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.cfg.RPCUser)) == 1
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.RPCPass)) == 1
	if !userOK || !passOK {
		// Same delay and the same message either way, so a wrong username is
		// indistinguishable from a wrong password.
		time.Sleep(500 * time.Millisecond)
		s.log.Warn("failed form login", "user", user, "remote", r.RemoteAddr)
		s.renderLogin(w, http.StatusUnauthorized, "Wrong username or password.")
		return
	}

	s.issueSession(w, r, auth.Claims{
		Subject:           user,
		PreferredUsername: user,
		Name:              user,
		// Form mode has no group source; the credential check is the whole
		// authorization decision, so satisfy the configured group directly.
		Groups: []string{s.cfg.OIDCAllowedGroup},
	})
}
