// Package server exposes the cc-status HTTP API (REST resources + SSE stream)
// and runs the background maintenance loops (skill scan, ghost reaper, TTL
// retention).
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"time"

	"github.com/weimengtsgit/xian630/cc-status/internal/config"
	"github.com/weimengtsgit/xian630/cc-status/internal/hook"
	"github.com/weimengtsgit/xian630/cc-status/internal/ingest"
	"github.com/weimengtsgit/xian630/cc-status/internal/model"
	"github.com/weimengtsgit/xian630/cc-status/internal/runlog"
	"github.com/weimengtsgit/xian630/cc-status/internal/skills"
	"github.com/weimengtsgit/xian630/cc-status/internal/store"
)

// Server is the cc-status HTTP server.
type Server struct {
	cfg     config.Config
	store   *store.Store
	ingest  *ingest.Ingest
	skills  *skills.Scanner
	hub     *Hub
	srv     *http.Server
	runLog  *runlog.Logger
	Version string
}

// New constructs a server and wires ingest publication to the SSE hub.
func New(cfg config.Config, st *store.Store, ig *ingest.Ingest, sc *skills.Scanner) *Server {
	h := NewHub()
	ig.Publish = h.Publish
	return &Server{
		cfg:    cfg,
		store:  st,
		ingest: ig,
		skills: sc,
		hub:    h,
		runLog: runlog.New(cfg.LogPath, cfg.LogMaxBytes, cfg.LogMaxBackups),
	}
}

// Start runs the HTTP server and background loops until ctx is canceled.
func (s *Server) Start(ctx context.Context) error {
	s.skills.Refresh()
	go s.loop(ctx, s.cfg.ScanInterval, s.skills.Refresh)
	go s.loop(ctx, s.cfg.ReaperInterval, s.reap)
	go s.loop(ctx, s.cfg.RetainInterval, s.prune)

	s.srv = &http.Server{Addr: s.cfg.Addr, Handler: s.routes()}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(c)
	}()

	s.logEvent("server_started", map[string]any{
		"pid":     os.Getpid(),
		"addr":    s.cfg.Addr,
		"db_path": s.cfg.DBPath,
	})
	log.Printf("cc-status listening on http://%s", s.cfg.Addr)
	err := s.srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) loop(ctx context.Context, interval time.Duration, fn func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

func (s *Server) reap() {
	n, err := s.store.ReapGhosts(time.Now().Add(-s.cfg.GhostTimeout))
	if err != nil {
		log.Printf("reap: %v", err)
		return
	}
	if n > 0 {
		log.Printf("reaped %d ghost entities", n)
	}
}

func (s *Server) prune() {
	n, err := s.store.PruneBefore(time.Now().Add(-s.cfg.TTL))
	if err != nil {
		log.Printf("prune: %v", err)
		return
	}
	if n > 0 {
		log.Printf("pruned %d old rows", n)
	}
}

func (s *Server) routes() *Router {
	r := &Router{}
	r.Handle("GET", "/healthz", s.health)
	r.Handle("POST", "/api/v1/events/ingest", s.ingestEvent)

	r.Handle("GET", "/api/v1/sessions", s.listSessions)
	r.Handle("GET", "/api/v1/sessions/:id", s.getSession)
	r.Handle("GET", "/api/v1/sessions/:id/agents", s.sessionAgents)
	r.Handle("GET", "/api/v1/sessions/:id/skills", s.sessionSkills)
	r.Handle("GET", "/api/v1/sessions/:id/tasks", s.sessionTasks)

	r.Handle("GET", "/api/v1/agents", s.listAgents)
	r.Handle("GET", "/api/v1/agents/:id", s.getAgent)
	r.Handle("GET", "/api/v1/agents/:id/skills", s.agentSkills)

	r.Handle("GET", "/api/v1/skills", s.listSkills)
	r.Handle("GET", "/api/v1/skills/:id", s.getSkill)

	r.Handle("GET", "/api/v1/tasks", s.listTasks)
	r.Handle("GET", "/api/v1/tasks/:id", s.getTask)

	r.Handle("GET", "/running", s.running)
	r.Handle("GET", "/api/v1/events", s.events) // SSE
	return r
}

// ------------------------------- handlers -----------------------------------

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "db ping: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.Version})
}

func (s *Server) ingestEvent(w http.ResponseWriter, r *http.Request) {
	e, err := hook.Parse(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.ingest.Handle(e); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.logEvent("hook_ingested", map[string]any{
		"hook_event":      e.HookEventName,
		"session_id":      e.SessionID,
		"agent_id":        e.AgentID,
		"agent_type":      e.AgentType,
		"tool_name":       e.ToolName,
		"tool_use_id":     e.ToolUseID,
		"transcript_path": e.TranscriptPath,
		"cwd":             e.Cwd,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) logEvent(name string, fields map[string]any) {
	if s.runLog != nil {
		s.runLog.Event(name, fields)
	}
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSessions(r.URL.Query().Get("status"), qInt(r, "limit", 500), qInt(r, "offset", 0))
	respondList(w, out, err)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.GetSession(Param(r, "id"))
	respondOne(w, v, err)
}

func (s *Server) sessionAgents(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSubagents(Param(r, "id"), "", qInt(r, "limit", 500), 0)
	respondList(w, out, err)
}

func (s *Server) sessionSkills(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSkills(Param(r, "id"), "", qInt(r, "limit", 500), 0)
	respondList(w, out, err)
}

func (s *Server) sessionTasks(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListBackgroundTasks(Param(r, "id"), "", qInt(r, "limit", 500), 0)
	respondList(w, out, err)
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSubagents("", r.URL.Query().Get("status"), qInt(r, "limit", 500), qInt(r, "offset", 0))
	respondList(w, out, err)
}

func (s *Server) getAgent(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.GetSubagent(Param(r, "id"))
	respondOne(w, v, err)
}

func (s *Server) agentSkills(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSkillsByAgent(Param(r, "id"))
	respondList(w, out, err)
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListSkills("", r.URL.Query().Get("status"), qInt(r, "limit", 500), qInt(r, "offset", 0))
	respondList(w, out, err)
}

func (s *Server) getSkill(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.GetSkill(Param(r, "id"))
	respondOne(w, v, err)
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.ListBackgroundTasks("", r.URL.Query().Get("status"), qInt(r, "limit", 500), qInt(r, "offset", 0))
	respondList(w, out, err)
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.GetBackgroundTask(Param(r, "id"))
	respondOne(w, v, err)
}

func (s *Server) running(w http.ResponseWriter, r *http.Request) {
	snap, err := s.store.RunningSnapshot()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// events is the Server-Sent Events endpoint. Optional ?since=<seq> replays
// missed events before going live.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Catch-up replay.
	if since := qInt64(r, "since", 0); since > 0 {
		if rows, err := s.store.ListEventsAfter(since, 1000); err == nil {
			for _, er := range rows {
				writeSSE(w, er)
			}
		}
	}
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case er, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, er)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, er model.EventRow) {
	data, _ := json.Marshal(er)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", er.HookEventName, data)
}

// ------------------------------- helpers ------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func respondList(w http.ResponseWriter, list any, err error) {
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// respondOne writes a single entity or 404 when not found. It handles both an
// untyped nil and a typed-nil pointer (the latter is what the store getters
// return on miss).
func respondOne(w http.ResponseWriter, v any, err error) {
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if v == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Pointer && rv.IsNil() {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func qInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

func qInt64(r *http.Request, key string, def int64) int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return def
	}
	return n
}
