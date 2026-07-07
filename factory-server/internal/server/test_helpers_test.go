package server

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

func newTestServerWithStore(t *testing.T) (*Server, *Router, string) {
	t.Helper()
	root := t.TempDir()
	writeServerCatalog(t, root, `{"version":1,"scenes":{"east-sea-situation":{"surface":"application","order":1}}}`)
	writeServerSceneManifest(t, root, "east-sea-situation")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	cfg := config.Config{
		WorkspaceRoot: root,
		ArtifactRoot:  filepath.Join(root, ".factory", "artifacts"),
	}
	srv := New(cfg, st, scanner.Scanner{})
	return srv, srv.routes(), root
}

func testCtx() context.Context {
	return context.Background()
}

func testNow() time.Time {
	return time.UnixMilli(1700000000000)
}
