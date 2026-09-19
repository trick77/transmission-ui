// Form login, for deployments with no identity provider. Credentials are the
// daemon's own RPC user and password, so there is nothing extra to provision:
// whoever may drive transmission-remote may drive the web UI.
package httpapi

import (
	"crypto/subtle"
	"html/template"
	"net/http"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
)

// loginPage is served on GET /login and re-served with an error after a failed
// POST. Self-contained: no bundle, no fonts, nothing to fetch, so it renders
// even when the app's assets do not.
var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · transmission-ui</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --surface:#1b1e24; --border:#2a2f38;
          --text:#e6e8ec; --muted:#9aa3b2; --accent:#4a9eff; --danger:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:var(--bg); color:var(--text);
         font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
  form { width:100%; max-width:320px; background:var(--surface);
         border:1px solid var(--border); border-radius:10px; padding:24px; }
  h1 { margin:0 0 4px; font-size:16px; font-weight:600; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label { display:block; margin-bottom:6px; font-size:12px; color:var(--muted); }
  input { width:100%; margin-bottom:14px; padding:9px 11px; border-radius:6px;
          border:1px solid var(--border); background:var(--bg); color:var(--text);
          font-size:14px; }
  input:focus { outline:none; border-color:var(--accent); }
  button { width:100%; padding:9px; border:0; border-radius:6px;
           background:var(--accent); color:#fff; font-size:14px; font-weight:500;
           cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .err { margin:0 0 14px; padding:8px 11px; border-radius:6px; font-size:13px;
         background:rgba(255,107,107,.12); color:var(--danger); }
</style>
<form method="post" action="/login">
  <h1>transmission-ui</h1>
  <p class="sub">Sign in with the daemon's RPC credentials.</p>
  {{if .Error}}<p class="err">{{.Error}}</p>{{end}}
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</html>`))

func (s *Server) renderLogin(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = loginPage.Execute(w, struct{ Error string }{msg})
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	// Already signed in: no reason to show the form again.
	if _, err := s.sessions.Decode(r); err == nil {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	s.renderLogin(w, http.StatusOK, "")
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
