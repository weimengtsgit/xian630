package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const projectPreviewLimitBytes = 1024 * 1024

type appProjectTreeResponse struct {
	App    appProjectInfo    `json:"app"`
	Groups []appProjectGroup `json:"groups"`
}

type appProjectInfo struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type appProjectGroup struct {
	ID              string           `json:"id"`
	Title           string           `json:"title"`
	DefaultExpanded bool             `json:"defaultExpanded"`
	Nodes           []appProjectNode `json:"nodes"`
}

type appProjectNode struct {
	Name     string           `json:"name"`
	Path     string           `json:"path"`
	Type     string           `json:"type"`
	Size     int64            `json:"size,omitempty"`
	Children []appProjectNode `json:"children,omitempty"`
}

type appProjectFileResponse struct {
	Path       string               `json:"path"`
	Name       string               `json:"name"`
	Kind       string               `json:"kind"`
	Mime       string               `json:"mime"`
	Size       int64                `json:"size"`
	ModifiedAt string               `json:"modifiedAt,omitempty"`
	Checksum   string               `json:"checksum,omitempty"`
	Draft      *appProjectDraftInfo `json:"draft,omitempty"`
	Content    string               `json:"content"`
	Formatted  string               `json:"formatted,omitempty"`
	Truncated  bool                 `json:"truncated"`
	Limit      int64                `json:"limit,omitempty"`
}

type appProjectDraftInfo struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	Content         string `json:"content,omitempty"`
	SourceChecksum  string `json:"sourceChecksum"`
	IsStale         bool   `json:"isStale"`
	UpdatedAt       string `json:"updatedAt,omitempty"`
	ConversionError string `json:"conversionError,omitempty"`
}

func (s *Server) applicationProjectTree(w http.ResponseWriter, r *http.Request) {
	app, root, ok := s.resolveGeneratedAppProject(w, r)
	if !ok {
		return
	}
	resp := appProjectTreeResponse{
		App: appProjectInfo{ID: app.ID, Slug: app.Slug, Name: app.Name, Path: app.Path},
		Groups: []appProjectGroup{
			{ID: "docs", Title: "文档", DefaultExpanded: true, Nodes: s.projectDocs(root)},
			{ID: "code", Title: "代码", DefaultExpanded: true, Nodes: s.projectCode(root)},
			{ID: "config", Title: "配置", DefaultExpanded: true, Nodes: s.projectConfig(root)},
			{ID: "factory-metadata", Title: "工厂元数据", DefaultExpanded: false, Nodes: s.projectFactoryMetadata(root)},
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) applicationProjectFile(w http.ResponseWriter, r *http.Request) {
	app, root, ok := s.resolveGeneratedAppProject(w, r)
	if !ok {
		return
	}
	rel := r.URL.Query().Get("path")
	full, cleanRel, ok := resolveProjectFilePath(root, rel)
	if !ok {
		writeError(w, http.StatusForbidden, "invalid project path")
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "stat project file")
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory")
		return
	}
	resp := appProjectFileResponse{
		Path:       cleanRel,
		Name:       filepath.Base(cleanRel),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		Limit:      projectPreviewLimitBytes,
	}
	if info.Size() > projectPreviewLimitBytes {
		resp.Kind = "large"
		resp.Mime = mime.TypeByExtension(filepath.Ext(cleanRel))
		resp.Truncated = true
		writeJSON(w, http.StatusOK, resp)
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read project file")
		return
	}
	resp.Mime = http.DetectContentType(data)
	if filepath.Ext(cleanRel) == ".md" {
		resp.Checksum = contentChecksum(data)
		if dialogueID := r.URL.Query().Get("dialogueId"); dialogueID != "" {
			if !s.dialogueOwnsApplication(r.Context(), dialogueID, app.ID) {
				writeError(w, http.StatusForbidden, "dialogue does not own application")
				return
			}
			if draft, _ := s.store.GetLatestProjectDocumentDraft(r.Context(), app.ID, dialogueID, cleanRel); draft != nil && draft.Status != model.ProjectDocumentDraftStatusDiscarded {
				resp.Draft = draftInfo(*draft, resp.Checksum)
			}
		}
	}
	kind := classifyProjectPreview(cleanRel, data)
	resp.Kind = kind
	if kind == "binary" {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Content = string(data)
	if kind == "json" {
		var out bytes.Buffer
		if json.Valid(data) && json.Indent(&out, data, "", "  ") == nil {
			resp.Formatted = out.String()
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type projectDraftBody struct {
	DialogueID     string `json:"dialogueId"`
	Path           string `json:"path"`
	SourceChecksum string `json:"sourceChecksum"`
	Content        string `json:"content"`
}

func (s *Server) saveApplicationProjectDraft(w http.ResponseWriter, r *http.Request) {
	app, root, ok := s.resolveGeneratedAppProject(w, r)
	if !ok {
		return
	}
	var body projectDraftBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.DialogueID == "" {
		writeError(w, http.StatusBadRequest, "missing dialogue id")
		return
	}
	if !s.dialogueOwnsApplication(r.Context(), body.DialogueID, app.ID) {
		writeError(w, http.StatusForbidden, "dialogue does not own application")
		return
	}
	full, cleanRel, ok := resolveProjectFilePath(root, body.Path)
	if !ok || !strings.HasPrefix(cleanRel, "docs/") || filepath.Ext(cleanRel) != ".md" {
		writeError(w, http.StatusForbidden, "draft path unsupported")
		return
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read source document")
		return
	}
	current := contentChecksum(raw)
	if body.SourceChecksum != current {
		writeError(w, http.StatusConflict, "stale_source")
		return
	}
	if len([]byte(body.Content)) > projectPreviewLimitBytes || !utf8.ValidString(body.Content) {
		writeError(w, http.StatusBadRequest, "invalid draft content")
		return
	}
	draft, err := s.store.UpsertProjectDocumentDraft(r.Context(), model.ProjectDocumentDraft{ApplicationID: app.ID, DialogueID: body.DialogueID, Path: cleanRel, SourceChecksum: current, Content: body.Content, Status: model.ProjectDocumentDraftStatusDraft})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save draft")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"draft": draft})
}

func (s *Server) discardApplicationProjectDraft(w http.ResponseWriter, r *http.Request) {
	app, _, ok := s.resolveGeneratedAppProject(w, r)
	if !ok {
		return
	}
	var body projectDraftBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.DialogueID == "" {
		writeError(w, http.StatusBadRequest, "missing dialogue id")
		return
	}
	if !s.dialogueOwnsApplication(r.Context(), body.DialogueID, app.ID) {
		writeError(w, http.StatusForbidden, "dialogue does not own application")
		return
	}
	draft, err := s.store.GetLatestProjectDocumentDraft(r.Context(), app.ID, body.DialogueID, body.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get draft")
		return
	}
	if draft == nil {
		writeError(w, http.StatusNotFound, "draft not found")
		return
	}
	if err := s.store.DiscardProjectDocumentDraft(r.Context(), draft.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "discard draft")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"discarded": true})
}

func (s *Server) applyApplicationProjectDraft(w http.ResponseWriter, r *http.Request) {
	app, root, ok := s.resolveGeneratedAppProject(w, r)
	if !ok {
		return
	}
	var body projectDraftBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.DialogueID == "" {
		writeError(w, http.StatusBadRequest, "missing dialogue id")
		return
	}
	if !s.dialogueOwnsApplication(r.Context(), body.DialogueID, app.ID) {
		writeError(w, http.StatusForbidden, "dialogue does not own application")
		return
	}
	full, cleanRel, ok := resolveProjectFilePath(root, body.Path)
	if !ok || !strings.HasPrefix(cleanRel, "docs/") || filepath.Ext(cleanRel) != ".md" {
		writeError(w, http.StatusForbidden, "draft path unsupported")
		return
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read source document")
		return
	}
	current := contentChecksum(raw)
	draft, err := s.store.GetLatestProjectDocumentDraft(r.Context(), app.ID, body.DialogueID, cleanRel)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get draft")
		return
	}
	if draft == nil || draft.Status != model.ProjectDocumentDraftStatusDraft {
		writeError(w, http.StatusConflict, "draft not available")
		return
	}
	if draft.SourceChecksum != current {
		writeError(w, http.StatusConflict, "stale_source")
		return
	}
	added, removed := lineDelta(string(raw), draft.Content)
	excerpt := draftExcerpt(string(raw), draft.Content, 600)
	summary := dialogue.TurnSummary{Intent: model.TurnIntentApplicationModification, UserFacingText: "已根据文档草稿生成变更建议，请确认后应用。", ChangeDescription: fmt.Sprintf("基于 %s 的文档草稿生成变更需求：新增 %d 行、删除 %d 行。关键修改内容：%s", cleanRel, added, removed, excerpt)}
	summaryJSON, _ := json.Marshal(summary)
	now := time.Now()
	turnID := "turn_" + idpkg.New()
	ended := now
	turn := model.DialogueTurn{ID: turnID, DialogueID: body.DialogueID, Intent: model.TurnIntentApplicationModification, Status: model.TurnStatusCompleted, SummaryJSON: string(summaryJSON), CreatedAt: now, EndedAt: &ended}
	if err := s.store.CreateDialogueTurn(r.Context(), turn); err != nil {
		writeError(w, http.StatusInternalServerError, "create draft turn")
		return
	}
	if err := s.store.UpdateDialogueStatus(r.Context(), body.DialogueID, model.DialogueStatusChangeConfirmation, "", ""); err != nil {
		writeError(w, http.StatusInternalServerError, "update dialogue")
		return
	}
	if err := s.store.MarkProjectDocumentDraftProposed(r.Context(), draft.ID, turnID, now); err != nil {
		writeError(w, http.StatusInternalServerError, "mark draft proposed")
		return
	}
	s.publishDialogueSimple("dialogue.change.proposed", body.DialogueID, map[string]any{"turn_id": turnID, "draft_id": draft.ID, "document_path": cleanRel, "summary": summary})
	writeJSON(w, http.StatusOK, map[string]any{"draftId": draft.ID, "turnId": turnID, "status": string(model.DialogueStatusChangeConfirmation), "summary": summary})
}

func draftExcerpt(source, draft string, limit int) string {
	src := map[string]int{}
	for _, line := range strings.Split(source, "\n") {
		src[strings.TrimSpace(line)]++
	}
	var changed []string
	for _, line := range strings.Split(draft, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if src[trimmed] > 0 {
			src[trimmed]--
			continue
		}
		changed = append(changed, trimmed)
	}
	if len(changed) == 0 {
		changed = []string{strings.TrimSpace(draft)}
	}
	text := strings.Join(changed, "；")
	if len([]rune(text)) > limit {
		runes := []rune(text)
		text = string(runes[:limit]) + "…"
	}
	return text
}

func lineDelta(source, draft string) (int, int) {
	src := map[string]int{}
	for _, line := range strings.Split(source, "\n") {
		src[line]++
	}
	added, removed := 0, 0
	for _, line := range strings.Split(draft, "\n") {
		if src[line] > 0 {
			src[line]--
		} else {
			added++
		}
	}
	for _, n := range src {
		removed += n
	}
	return added, removed
}

func (s *Server) resolveGeneratedAppProject(w http.ResponseWriter, r *http.Request) (model.Application, string, bool) {
	id := Param(r, "id")
	app, err := s.store.GetApplication(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return model.Application{}, "", false
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return model.Application{}, "", false
	}
	if app.Source != model.AppSourceGenerated || app.Path == "" || filepath.IsAbs(app.Path) || strings.Contains(filepath.ToSlash(app.Path), "..") || !strings.HasPrefix(filepath.ToSlash(app.Path), "generated-apps/") {
		writeError(w, http.StatusForbidden, "application project unavailable")
		return model.Application{}, "", false
	}
	generatedRoot := filepath.Join(s.cfg.WorkspaceRoot, "generated-apps")
	absGeneratedRoot, err := filepath.Abs(generatedRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve generated apps root")
		return model.Application{}, "", false
	}
	if real, err := filepath.EvalSymlinks(absGeneratedRoot); err == nil {
		absGeneratedRoot = real
	}
	root := filepath.Join(s.cfg.WorkspaceRoot, filepath.FromSlash(app.Path))
	abs, err := filepath.Abs(root)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve project root")
		return model.Application{}, "", false
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	if !pathWithinRoot(absGeneratedRoot, abs) {
		writeError(w, http.StatusForbidden, "application project unavailable")
		return model.Application{}, "", false
	}
	return *app, abs, true
}

func pathWithinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	relSlash := filepath.ToSlash(rel)
	return relSlash == "." || (!filepath.IsAbs(rel) && !strings.HasPrefix(relSlash, "../") && relSlash != "..")
}

func resolveProjectFilePath(root, rel string) (string, string, bool) {
	if strings.TrimSpace(rel) == "" || filepath.IsAbs(rel) {
		return "", "", false
	}
	rel = filepath.ToSlash(rel)
	clean := filepath.Clean(filepath.FromSlash(rel))
	cleanSlash := filepath.ToSlash(clean)
	if clean == "." || strings.HasPrefix(cleanSlash, "../") || cleanSlash == ".." || projectPathDenied(cleanSlash) {
		return "", "", false
	}
	joined := filepath.Join(root, clean)
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		realRoot = root
	}
	realFile, err := filepath.EvalSymlinks(joined)
	if err != nil {
		realFile = joined
	}
	if !pathWithinRoot(realRoot, realFile) {
		return "", "", false
	}
	return realFile, cleanSlash, true
}

func projectPathDenied(path string) bool {
	path = filepath.ToSlash(path)
	if path == "output.json" || strings.HasSuffix(path, "/output.json") {
		return true
	}
	parts := strings.Split(path, "/")
	for _, p := range parts {
		switch p {
		case "dist", "node_modules", ".factory-runs", "versions", "audit", "audits":
			return true
		}
	}
	return false
}

func contentChecksum(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func draftInfo(d model.ProjectDocumentDraft, currentChecksum string) *appProjectDraftInfo {
	return &appProjectDraftInfo{
		ID:              d.ID,
		Status:          string(d.Status),
		Content:         d.Content,
		SourceChecksum:  d.SourceChecksum,
		IsStale:         d.SourceChecksum != currentChecksum,
		UpdatedAt:       d.UpdatedAt.UTC().Format(time.RFC3339),
		ConversionError: d.ConversionError,
	}
}

func (s *Server) dialogueOwnsApplication(ctx context.Context, dialogueID, appID string) bool {
	dlg, err := s.store.GetDialogueSession(ctx, dialogueID)
	return err == nil && dlg != nil && dlg.ResolvedApplicationID == appID
}

func classifyProjectPreview(path string, data []byte) string {
	base := filepath.Base(path)
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".md" {
		return "markdown"
	}
	if ext == ".json" {
		return "json"
	}
	if isTextProjectFile(base, ext) && utf8.Valid(data) {
		return "text"
	}
	if strings.HasPrefix(http.DetectContentType(data), "text/") && utf8.Valid(data) {
		return "text"
	}
	return "binary"
}

func isTextProjectFile(base, ext string) bool {
	switch base {
	case "Dockerfile", "nginx.conf", "package.json", "index.html", ".env.example":
		return true
	}
	if strings.HasPrefix(base, "vite.config.") {
		return true
	}
	switch ext {
	case ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".html", ".txt", ".conf", ".yml", ".yaml", ".toml":
		return true
	}
	return false
}

func (s *Server) projectDocs(root string) []appProjectNode {
	matches, _ := filepath.Glob(filepath.Join(root, "docs", "*.md"))
	return fileNodes(root, matches)
}

func (s *Server) projectCode(root string) []appProjectNode {
	var nodes []appProjectNode
	for _, p := range []string{"src", "tests"} {
		if n, ok := treeNode(root, filepath.Join(root, p)); ok {
			nodes = append(nodes, n)
		}
	}
	for _, p := range []string{"package.json", "index.html"} {
		if n, ok := fileNode(root, filepath.Join(root, p)); ok {
			nodes = append(nodes, n)
		}
	}
	matches, _ := filepath.Glob(filepath.Join(root, "vite.config.*"))
	nodes = append(nodes, fileNodes(root, matches)...)
	return nodes
}

func (s *Server) projectConfig(root string) []appProjectNode {
	return fileNodes(root, []string{filepath.Join(root, "Dockerfile"), filepath.Join(root, "nginx.conf"), filepath.Join(root, ".factory", "app.json")})
}

func (s *Server) projectFactoryMetadata(root string) []appProjectNode {
	return fileNodes(root, []string{filepath.Join(root, ".factory", "project-docs.json")})
}

func treeNode(root, path string) (appProjectNode, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return appProjectNode{}, false
	}
	rel, _ := filepath.Rel(root, path)
	node := appProjectNode{Name: filepath.Base(path), Path: filepath.ToSlash(rel), Type: "directory"}
	entries, _ := os.ReadDir(path)
	for _, entry := range entries {
		child := filepath.Join(path, entry.Name())
		childRel, _ := filepath.Rel(root, child)
		if projectPathDenied(filepath.ToSlash(childRel)) {
			continue
		}
		if entry.IsDir() {
			if n, ok := treeNode(root, child); ok {
				node.Children = append(node.Children, n)
			}
		} else if n, ok := fileNode(root, child); ok {
			node.Children = append(node.Children, n)
		}
	}
	sort.Slice(node.Children, func(i, j int) bool {
		if node.Children[i].Type != node.Children[j].Type {
			return node.Children[i].Type == "directory"
		}
		return node.Children[i].Name < node.Children[j].Name
	})
	return node, true
}

func fileNodes(root string, paths []string) []appProjectNode {
	var nodes []appProjectNode
	for _, p := range paths {
		if n, ok := fileNode(root, p); ok {
			nodes = append(nodes, n)
		}
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Path < nodes[j].Path })
	return nodes
}

func fileNode(root, path string) (appProjectNode, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return appProjectNode{}, false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return appProjectNode{}, false
	}
	relSlash := filepath.ToSlash(rel)
	if projectPathDenied(relSlash) {
		return appProjectNode{}, false
	}
	return appProjectNode{Name: filepath.Base(path), Path: relSlash, Type: "file", Size: info.Size()}, true
}
