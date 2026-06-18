package server

import (
	"context"
	"net/http"
	"strings"
)

// Router is a tiny method-aware router with ":param" path segments. It exists
// because Go 1.21's net/http ServeMux lacks wildcard path parameters (added in
// 1.22), and we want to stay on the user's installed toolchain.
type Router struct {
	routes []route
}

type route struct {
	method string
	segs   []string
	h      http.HandlerFunc
}

// Handle registers a handler for "METHOD /a/:b/c" style patterns.
func (r *Router) Handle(method, pattern string, h http.HandlerFunc) {
	r.routes = append(r.routes, route{method: method, segs: splitPath(pattern), h: h})
}

type ctxKey int

const paramsKey ctxKey = 0

// Param reads a path parameter from the request context.
func Param(r *http.Request, name string) string {
	if p, ok := r.Context().Value(paramsKey).(map[string]string); ok {
		return p[name]
	}
	return ""
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	segs := splitPath(req.URL.Path)
	for _, rt := range r.routes {
		if rt.method != "" && rt.method != req.Method {
			continue
		}
		params, ok := match(rt.segs, segs)
		if !ok {
			continue
		}
		ctx := context.WithValue(req.Context(), paramsKey, params)
		rt.h(w, req.WithContext(ctx))
		return
	}
	http.NotFound(w, req)
}

func splitPath(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

func match(pattern, path []string) (map[string]string, bool) {
	if len(pattern) != len(path) {
		return nil, false
	}
	params := map[string]string{}
	for i := range pattern {
		if strings.HasPrefix(pattern[i], ":") {
			params[pattern[i][1:]] = path[i]
		} else if pattern[i] != path[i] {
			return nil, false
		}
	}
	return params, true
}
