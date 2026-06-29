package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

func newProjectTestServer(t *testing.T) (*Router, *store.Store, string, model.Application) {
	t.Helper()
	root := t.TempDir()
	appDir := filepath.Join(root, "generated-apps", "demo")
	mustWrite(t, filepath.Join(appDir, "docs", "overview.md"), "# Overview\nHello")
	mustWrite(t, filepath.Join(appDir, "src", "App.jsx"), "export default function App() { return <div/> }\n")
	mustWrite(t, filepath.Join(appDir, "tests", "app.test.js"), "test('ok', () => {})\n")
	mustWrite(t, filepath.Join(appDir, "package.json"), `{"scripts":{"build":"vite build"}}`)
	mustWrite(t, filepath.Join(appDir, "vite.config.js"), "export default {}\n")
	mustWrite(t, filepath.Join(appDir, "index.html"), "<div id=\"root\"></div>\n")
	mustWrite(t, filepath.Join(appDir, "Dockerfile"), "FROM nginx\n")
	mustWrite(t, filepath.Join(appDir, "nginx.conf"), "server {}\n")
	mustWrite(t, filepath.Join(appDir, ".factory", "app.json"), `{"id":"app_demo"}`)
	mustWrite(t, filepath.Join(appDir, ".factory", "project-docs.json"), `{"documents":[]}`)
	mustWrite(t, filepath.Join(appDir, "dist", "bundle.js"), "hidden")
	mustWrite(t, filepath.Join(appDir, "node_modules", "pkg", "index.js"), "hidden")
	mustWrite(t, filepath.Join(appDir, ".factory-runs", "run", "output.json"), "hidden")
	mustWrite(t, filepath.Join(appDir, "output.json"), "hidden")
	mustWriteBytes(t, filepath.Join(appDir, "src", "logo.png"), []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	mustWrite(t, filepath.Join(appDir, "src", "large.txt"), string(make([]byte, projectPreviewLimitBytes+1)))

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	app := model.Application{ID: "app_demo", Slug: "demo", Name: "Demo", Source: model.AppSourceGenerated, Path: "generated-apps/demo", ManifestPath: "generated-apps/demo/.factory/app.json", Status: model.AppStatusStopped}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert app: %v", err)
	}
	preset := model.Application{ID: "app_preset", Slug: "preset", Name: "Preset", Source: model.AppSourcePreset, Path: "scene/preset", Status: model.AppStatusStopped}
	if err := st.UpsertApplication(context.Background(), preset); err != nil {
		t.Fatalf("upsert preset: %v", err)
	}
	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
	return srv.routes(), st, root, app
}

func TestApplicationProjectTreeReturnsGroupsAndHidesDeniedPaths(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-tree", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got appProjectTreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Groups) != 4 || got.Groups[0].ID != "docs" || !got.Groups[0].DefaultExpanded || got.Groups[3].DefaultExpanded {
		t.Fatalf("groups = %#v", got.Groups)
	}
	body := rec.Body.String()
	for _, hidden := range []string{"dist", "node_modules", ".factory-runs", "output.json"} {
		if contains := jsonContains(body, hidden); contains {
			t.Fatalf("tree leaked denied path %q: %s", hidden, body)
		}
	}
}

func TestApplicationProjectFileRejectsUnsafePaths(t *testing.T) {
	r, _, root, _ := newProjectTestServer(t)
	_ = os.WriteFile(filepath.Join(root, "generated-apps", "secret.txt"), []byte("secret"), 0o644)
	_ = os.Symlink(filepath.Join(root, "generated-apps", "secret.txt"), filepath.Join(root, "generated-apps", "demo", "src", "leak.txt"))
	for _, path := range []string{"", "../secret.txt", "/etc/passwd", "output.json", "src/leak.txt"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path="+path, nil)
		r.ServeHTTP(rec, req)
		if rec.Code < 400 {
			t.Fatalf("path %q status=%d want error body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestApplicationProjectRejectsSymlinkedProjectRootEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "docs", "secret.md"), "# Secret")
	if err := os.MkdirAll(filepath.Join(root, "generated-apps"), 0o755); err != nil {
		t.Fatalf("mkdir generated-apps: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "generated-apps", "demo")); err != nil {
		t.Fatalf("symlink project root: %v", err)
	}

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	app := model.Application{ID: "app_demo", Slug: "demo", Name: "Demo", Source: model.AppSourceGenerated, Path: "generated-apps/demo", Status: model.AppStatusStopped}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert app: %v", err)
	}
	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
	r := srv.routes()

	for _, target := range []string{
		"/api/apps/app_demo/project-tree",
		"/api/apps/app_demo/project-file?path=docs/secret.md",
	} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s status=%d want 403 body=%s", target, rec.Code, rec.Body.String())
		}
	}
}

func TestApplicationProjectFilePreviewsTextJsonBinaryAndLarge(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	cases := []struct{ path, kind string }{
		{"docs/overview.md", "markdown"},
		{"package.json", "json"},
		{"src/App.jsx", "text"},
		{"src/logo.png", "binary"},
		{"src/large.txt", "large"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path="+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
		var got appProjectFileResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode %s: %v", tc.path, err)
		}
		if got.Kind != tc.kind {
			t.Fatalf("%s kind=%q want %q", tc.path, got.Kind, tc.kind)
		}
		if tc.kind == "json" && got.Formatted == "" {
			t.Fatalf("json formatted empty: %#v", got)
		}
		if (tc.kind == "binary" || tc.kind == "large") && got.Content != "" {
			t.Fatalf("%s returned content for %s", tc.path, tc.kind)
		}
	}
}

func TestApplicationProjectMarkdownPreviewAndDraftSave(t *testing.T) {
	r, st, root, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path=docs/overview.md&dialogueId=dlg_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", rec.Code, rec.Body.String())
	}
	var preview appProjectFileResponse
	if err := json.NewDecoder(rec.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	if preview.Checksum == "" {
		t.Fatalf("checksum empty: %#v", preview)
	}
	orig, _ := os.ReadFile(filepath.Join(root, "generated-apps", "demo", "docs", "overview.md"))

	rec = doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": "# Edited"})
	if rec.Code != http.StatusOK {
		t.Fatalf("save draft status=%d body=%s", rec.Code, rec.Body.String())
	}
	after, _ := os.ReadFile(filepath.Join(root, "generated-apps", "demo", "docs", "overview.md"))
	if string(after) != string(orig) {
		t.Fatalf("source doc changed: %s", after)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path=docs/overview.md&dialogueId=dlg_1", nil))
	if err := json.NewDecoder(rec.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	if preview.Draft == nil || preview.Draft.Content != "# Edited" || preview.Draft.IsStale {
		t.Fatalf("draft overlay = %#v", preview.Draft)
	}
}

func TestApplicationProjectDiscardedDraftIsNotReturnedInPreview(t *testing.T) {
	r, st, _, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	preview := getMarkdownPreview(t, r, "dlg_1")
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": "# Edited"})
	if rec.Code != http.StatusOK {
		t.Fatalf("save draft status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, body := range []map[string]any{{"dialogueId": "dlg_1", "path": "docs/overview.md"}} {
		rec = doJSON(t, r, http.MethodDelete, "/api/apps/app_demo/project-drafts", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("discard status=%d body=%s", rec.Code, rec.Body.String())
		}
	}
	preview = getMarkdownPreview(t, r, "dlg_1")
	if preview.Draft != nil {
		t.Fatalf("discarded draft returned in preview: %#v", preview.Draft)
	}
}

func TestApplicationProjectDraftRejectsDialogueWithoutAppOwnership(t *testing.T) {
	r, st, _, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_other", "other_app")
	preview := getMarkdownPreview(t, r, "")
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_other", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": "# Edited"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("save status=%d want 403 body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": "# Edited"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty dialogue status=%d want 400 body=%s", rec.Code, rec.Body.String())
	}
}

func TestApplicationProjectDraftApplySummaryIncludesDraftContent(t *testing.T) {
	r, st, _, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	preview := getMarkdownPreview(t, r, "dlg_1")
	draft := "# Overview\n\n将告警阈值改为 150 海里\n新增舰队筛选条件"
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": draft})
	if rec.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status=%d body=%s", rec.Code, rec.Body.String())
	}
	turn, err := st.GetLatestCompletedDialogueTurnByIntent(context.Background(), "dlg_1", model.TurnIntentApplicationModification)
	if err != nil || turn == nil {
		t.Fatalf("latest turn: %#v %v", turn, err)
	}
	if !strings.Contains(turn.SummaryJSON, "150 海里") || !strings.Contains(turn.SummaryJSON, "舰队筛选") {
		t.Fatalf("summary lost draft content: %s", turn.SummaryJSON)
	}
}

func TestApplicationProjectDraftApplySummaryIncludesDeletedContent(t *testing.T) {
	r, st, root, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	longPrefix := strings.Repeat("普通背景行\n", 120)
	sourcePath := filepath.Join(root, "generated-apps", "demo", "docs", "overview.md")
	source := longPrefix + "必须删除的高风险限制：不再支持旧阈值\n保留内容\n"
	if err := os.WriteFile(sourcePath, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	preview := getMarkdownPreview(t, r, "dlg_1")
	draft := longPrefix + "保留内容\n"
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": draft})
	if rec.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status=%d body=%s", rec.Code, rec.Body.String())
	}
	turn, err := st.GetLatestCompletedDialogueTurnByIntent(context.Background(), "dlg_1", model.TurnIntentApplicationModification)
	if err != nil || turn == nil {
		t.Fatalf("latest turn: %#v %v", turn, err)
	}
	if !strings.Contains(turn.SummaryJSON, "必须删除的高风险限制") {
		t.Fatalf("summary lost deleted content: %s", turn.SummaryJSON)
	}
}

func TestApplicationProjectDraftApplySummaryIncludesDraftRef(t *testing.T) {
	r, st, _, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	preview := getMarkdownPreview(t, r, "dlg_1")
	draftContent := "# Overview\n\n将告警阈值改为 150 海里\n新增舰队筛选条件"
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": preview.Checksum, "content": draftContent})
	if rec.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md"})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status=%d body=%s", rec.Code, rec.Body.String())
	}
	turn, err := st.GetLatestCompletedDialogueTurnByIntent(context.Background(), "dlg_1", model.TurnIntentApplicationModification)
	if err != nil || turn == nil {
		t.Fatalf("latest turn: %#v %v", turn, err)
	}

	// Check that the summary contains the draft ref fields
	var summary map[string]any
	if err := json.Unmarshal([]byte(turn.SummaryJSON), &summary); err != nil {
		t.Fatalf("unmarshal summary: %v", err)
	}

	draftChange, ok := summary["documentDraftChange"].(map[string]any)
	if !ok {
		t.Fatalf("summary missing documentDraftChange: %s", turn.SummaryJSON)
	}

	if draftChange["draftId"] == "" {
		t.Fatalf("draftId missing: %#v", draftChange)
	}
	if draftChange["applicationId"] != "app_demo" {
		t.Fatalf("applicationId mismatch: got %q want app_demo", draftChange["applicationId"])
	}
	if draftChange["dialogueId"] != "dlg_1" {
		t.Fatalf("dialogueId mismatch: got %q want dlg_1", draftChange["dialogueId"])
	}
	if draftChange["path"] != "docs/overview.md" {
		t.Fatalf("path mismatch: got %q want docs/overview.md", draftChange["path"])
	}
	if draftChange["sourceChecksum"] == "" {
		t.Fatalf("sourceChecksum missing: %#v", draftChange)
	}

	// Also verify the change description is still there
	if !strings.Contains(turn.SummaryJSON, "150 海里") {
		t.Fatalf("summary lost change description: %s", turn.SummaryJSON)
	}
}

func TestApplicationProjectDraftRejectsStaleChecksum(t *testing.T) {
	r, st, _, _ := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", "app_demo")
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{"dialogueId": "dlg_1", "path": "docs/overview.md", "sourceChecksum": "sha256:stale", "content": "# Edited"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d want 409 body=%s", rec.Code, rec.Body.String())
	}
}

func TestApplicationProjectRejectsPresetAndMissingApps(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	for _, target := range []struct {
		path string
		code int
	}{{"/api/apps/app_preset/project-tree", http.StatusForbidden}, {"/api/apps/missing/project-tree", http.StatusNotFound}} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target.path, nil))
		if rec.Code != target.code {
			t.Fatalf("%s status=%d want %d", target.path, rec.Code, target.code)
		}
	}
}

func getMarkdownPreview(t *testing.T, r *Router, dialogueID string) appProjectFileResponse {
	t.Helper()
	url := "/api/apps/app_demo/project-file?path=docs/overview.md"
	if dialogueID != "" {
		url += "&dialogueId=" + dialogueID
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", rec.Code, rec.Body.String())
	}
	var preview appProjectFileResponse
	if err := json.NewDecoder(rec.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	return preview
}

func seedProjectDialogue(t *testing.T, st *store.Store, dialogueID, appID string) {
	t.Helper()
	now := time.Now()
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{ID: dialogueID, InitialPrompt: "p", Status: model.DialogueStatusResolved, Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true, ResolvedApplicationID: appID, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("seed dialogue: %v", err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	mustWriteBytes(t, path, []byte(content))
}

func mustWriteBytes(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func jsonContains(body, s string) bool { return strings.Contains(body, s) }

func TestApplicationProjectDraftUsesConverter(t *testing.T) {
	r, st, root, app := newProjectTestServer(t)

	// Seed dialogue
	seedProjectDialogue(t, st, "dlg_1", app.ID)

	// Override with fake converter that returns custom output
	expectedOutput := &dialogue.DocumentDraftConverterOutput{
		UserFacingText:    "Custom user facing text",
		ChangeDescription: "Custom change description",
	}
	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
	srv.documentDraftConverter = dialogue.NewFakeDocumentDraftConverter(expectedOutput, nil)
	srv.documentDraftConverterName = "llm"
	r = srv.routes()

	// Create preview and draft
	preview := getMarkdownPreview(t, r, "dlg_1")
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{
		"dialogueId":     "dlg_1",
		"path":           "docs/overview.md",
		"sourceChecksum": preview.Checksum,
		"content":        "# Edited",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("save draft: status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Apply
	rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{
		"dialogueId":     "dlg_1",
		"path":           "docs/overview.md",
		"sourceChecksum": preview.Checksum,
		"content":        "# Edited",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply draft: status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Verify
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	summary := resp["summary"].(map[string]any)
	if summary["userFacingText"] != expectedOutput.UserFacingText {
		t.Errorf("userFacingText=%q want=%q", summary["userFacingText"], expectedOutput.UserFacingText)
	}
	if summary["changeDescription"] != expectedOutput.ChangeDescription {
		t.Errorf("changeDescription=%q want=%q", summary["changeDescription"], expectedOutput.ChangeDescription)
	}
	if summary["documentDraftChange"] == nil {
		t.Error("documentDraftChange is nil, should be preserved")
	}
	if summary["converter"] != "llm" {
		t.Errorf("converter=%q want=llm", summary["converter"])
	}
}

func TestApplicationProjectDraftDefaultConverterIsMarkedDeterministic(t *testing.T) {
	r, st, _, app := newProjectTestServer(t)
	seedProjectDialogue(t, st, "dlg_1", app.ID)

	preview := getMarkdownPreview(t, r, "dlg_1")
	rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{
		"dialogueId":     "dlg_1",
		"path":           "docs/overview.md",
		"sourceChecksum": preview.Checksum,
		"content":        "# Edited",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("save draft: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{
		"dialogueId": "dlg_1",
		"path":       "docs/overview.md",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply draft: status=%d body=%s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	summary := resp["summary"].(map[string]any)
	if summary["converter"] != "deterministic" {
		t.Fatalf("converter=%q want deterministic", summary["converter"])
	}
}

// Test-only converter that returns nil, nil
type nilOutputConverter struct{}

func (c *nilOutputConverter) ConvertDraft(ctx context.Context, input dialogue.DocumentDraftConverterInput) (*dialogue.DocumentDraftConverterOutput, error) {
	return nil, nil
}

func TestApplicationProjectDraftFallsBackToDeterministic(t *testing.T) {
	tests := []struct {
		name      string
		converter dialogue.DocumentDraftConverter
	}{
		{
			name:      "converter returns error",
			converter: dialogue.NewFakeDocumentDraftConverter(nil, fmt.Errorf("converter failed")),
		},
		{
			name:      "converter returns nil output",
			converter: &nilOutputConverter{},
		},
		{
			name:      "converter returns empty userFacingText",
			converter: dialogue.NewFakeDocumentDraftConverter(&dialogue.DocumentDraftConverterOutput{ChangeDescription: "desc"}, nil),
		},
		{
			name:      "converter returns empty changeDescription",
			converter: dialogue.NewFakeDocumentDraftConverter(&dialogue.DocumentDraftConverterOutput{UserFacingText: "text"}, nil),
		},
		{
			name:      "converter is nil",
			converter: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create server first so we can override the converter immediately
			root := t.TempDir()
			st, err := store.Open(":memory:")
			if err != nil {
				t.Fatalf("open store: %v", err)
			}
			t.Cleanup(func() { _ = st.Close() })

			// Set up app
			app := model.Application{
				ID:           "app_demo",
				Slug:         "demo",
				Name:         "Demo",
				Source:       model.AppSourceGenerated,
				Path:         "generated-apps/demo",
				ManifestPath: "generated-apps/demo/.factory/app.json",
				Status:       model.AppStatusStopped,
			}
			if err := st.UpsertApplication(context.Background(), app); err != nil {
				t.Fatalf("upsert app: %v", err)
			}

			// Create server with our converter override
			srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
			srv.documentDraftConverter = tt.converter
			r := srv.routes()

			// Set up test files
			appDir := filepath.Join(root, app.Path, "docs")
			if err := os.MkdirAll(appDir, 0o755); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			testPath := filepath.Join(appDir, "overview.md")
			origContent := "# Overview\nHello"
			draftContent := "# Overview\nModified content\nline 2\nnew line 3\n"
			if err := os.WriteFile(testPath, []byte(origContent), 0o644); err != nil {
				t.Fatalf("write file: %v", err)
			}

			// Seed dialogue
			now := time.Now()
			if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
				ID:                    "dlg_1",
				Status:                model.DialogueStatusResolved,
				Intent:                model.DialogueIntentApplicationGeneration,
				ResolvedApplicationID: app.ID,
				InitialPrompt:         "p",
				CreatedAt:             now,
				UpdatedAt:             now,
			}); err != nil {
				t.Fatalf("seed dialogue: %v", err)
			}

			// Get preview and create draft
			preview := getMarkdownPreview(t, r, "dlg_1")
			rec := doJSON(t, r, http.MethodPut, "/api/apps/app_demo/project-drafts", map[string]any{
				"dialogueId":     "dlg_1",
				"path":           "docs/overview.md",
				"sourceChecksum": preview.Checksum,
				"content":        draftContent,
			})
			if rec.Code != http.StatusOK {
				t.Fatalf("save draft: status=%d body=%s", rec.Code, rec.Body.String())
			}

			// Apply
			rec = doJSON(t, r, http.MethodPost, "/api/apps/app_demo/project-drafts/apply", map[string]any{
				"dialogueId":     "dlg_1",
				"path":           "docs/overview.md",
				"sourceChecksum": preview.Checksum,
				"content":        draftContent,
			})
			if rec.Code != http.StatusOK {
				t.Fatalf("apply draft: status=%d body=%s", rec.Code, rec.Body.String())
			}

			// Verify
			var resp map[string]any
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			summary := resp["summary"].(map[string]any)
			if summary["userFacingText"] != "已根据文档草稿生成变更建议，请确认后应用。" {
				t.Errorf("userFacingText=%q want deterministic fallback", summary["userFacingText"])
			}
			if !strings.Contains(summary["changeDescription"].(string), "docs/overview.md") {
				t.Errorf("changeDescription=%q should contain path", summary["changeDescription"])
			}
			if summary["documentDraftChange"] == nil {
				t.Error("documentDraftChange is nil, should be preserved")
			}
			if summary["converter"] != "deterministic" {
				t.Errorf("converter=%q want=deterministic", summary["converter"])
			}
			if tt.name == "converter returns error" {
				if summary["conversionError"] == "" {
					t.Error("conversionError should be set when converter returns an error")
				}
			} else {
				if summary["conversionError"] != nil && summary["conversionError"] != "" {
					t.Errorf("conversionError=%q want empty", summary["conversionError"])
				}
			}
		})
	}
}
