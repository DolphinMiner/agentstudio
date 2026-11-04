package api

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

const (
	corsMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	corsHeaders = "Authorization, Content-Type, X-Requested-With"
)

// originAllowed implements docs/api.md § CORS.
func originAllowed(origin string, allowed []string, dev bool) bool {
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	if !dev {
		return false
	}
	if origin == "null" || strings.HasPrefix(origin, "file://") {
		return true
	}
	for _, prefix := range []string{"http://127.0.0.1", "http://localhost"} {
		if rest, ok := strings.CutPrefix(origin, prefix); ok {
			if rest == "" {
				return true
			}
			if port, ok := strings.CutPrefix(rest, ":"); ok && port != "" && strings.Trim(port, "0123456789") == "" {
				return true
			}
		}
	}
	return false
}

// cors adds CORS headers for /v1 and /_matrix and answers their preflights.
// /internal is never CORS-enabled.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		public := strings.HasPrefix(p, "/v1/") || strings.HasPrefix(p, "/_matrix/")
		origin := r.Header.Get("Origin")
		if !public || origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		ok := originAllowed(origin, s.cfg.AllowedOrigins, s.cfg.Dev)
		w.Header().Add("Vary", "Origin")
		if ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if ok {
				w.Header().Set("Access-Control-Allow-Methods", corsMethods)
				w.Header().Set("Access-Control-Allow-Headers", corsHeaders)
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
			} else {
				w.WriteHeader(http.StatusForbidden)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

// matrixProxy forwards /_matrix/* to Synapse unchanged, streaming responses
// (FlushInterval -1) so long polls such as /sync work.
func (s *Server) matrixProxy() http.Handler {
	target, err := url.Parse(s.cfg.SynapseURL)
	if err != nil {
		panic(err)
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
			// The Authorization header is preserved as is.
		},
		FlushInterval: -1,
		ModifyResponse: func(resp *http.Response) error {
			// Our CORS middleware owns these headers; Synapse's would duplicate them.
			for k := range resp.Header {
				if strings.HasPrefix(k, "Access-Control-") {
					resp.Header.Del(k)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			s.log.Warn("matrix proxy error", "path", r.URL.Path, "err", err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"errcode": "M_UNKNOWN", "error": "homeserver unreachable"})
		},
	}
}
