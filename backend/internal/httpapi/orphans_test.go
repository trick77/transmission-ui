package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// Without the finder set up, its routes still answer, with a JSON 404: an
// unregistered GET would reach the shell and look like a 200 to the UI.
func TestOrphanRoutesOffAnswer404(t *testing.T) {
	for _, base := range []string{"", "/tm"} {
		srv, sessions := newTestServerAt(t, config.AuthModeOIDC, "media", &fakeOIDC{}, base)
		cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range []string{"GET /api/orphans", "GET /api/orphans/x", "POST /api/orphans/scan", "DELETE /api/orphans/keep"} {
			method, p, _ := strings.Cut(m, " ")
			req := httptest.NewRequest(method, base+p, nil)
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "not set up") {
				t.Fatalf("%s%s: %d %q", base, m, rec.Code, rec.Body)
			}
		}
	}
}

func TestOrphanRoutesNeedSessionAndStripBase(t *testing.T) {
	srv, sessions := newTestServerAt(t, config.AuthModeOIDC, "media", &fakeOIDC{}, "/tm")
	var got string
	srv.SetOrphans(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/tm/api/orphans/scan", nil))
	if rec.Code != http.StatusUnauthorized || got != "" {
		t.Fatalf("anonymous scan: %d, reached %q", rec.Code, got)
	}
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	req := httptest.NewRequest(http.MethodPost, "/tm/api/orphans/delete", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot || got != "/api/orphans/delete" {
		t.Fatalf("signed in: %d, path %q", rec.Code, got)
	}
	// Cross-site POSTs are refused before the finder sees them.
	got = ""
	req = httptest.NewRequest(http.MethodPost, "/tm/api/orphans/delete", nil)
	req.AddCookie(cookie)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || got != "" {
		t.Fatalf("cross-site delete: %d, reached %q", rec.Code, got)
	}
}
