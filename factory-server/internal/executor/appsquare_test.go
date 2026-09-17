package executor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TestRegisterAppWithSquareDisabled proves an unset FACTORY_APP_SQUARE_URL is a
// complete no-op (no HTTP attempted).
func TestRegisterAppWithSquareDisabled(t *testing.T) {
	t.Setenv("FACTORY_APP_SQUARE_URL", "")
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer srv.Close()
	RegisterAppWithSquare(context.Background(), model.Application{Slug: "x", Name: "X"}, "http://h:1", nil)
	if called {
		t.Fatal("expected no HTTP call when FACTORY_APP_SQUARE_URL is empty")
	}
}

// TestRegisterAppWithSquarePostsPayload proves the deployed URL, app fields, and
// the confirmed requirement's long description / feature tags are POSTed to
// /api/apps, and failures never bubble up.
func TestRegisterAppWithSquarePostsPayload(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	t.Setenv("FACTORY_APP_SQUARE_URL", srv.URL)

	RegisterAppWithSquare(context.Background(), model.Application{
		Slug: "command-dashboard-j98t", Name: "潮汐窗口", Description: "四大母港潮汐看板",
	}, "http://10.0.0.1:18001", &model.Job{
		ConfirmedRequirementJSON: `{"appName":"潮汐窗口","description":"接入公开潮汐预测API，抓取诺福克、圣迭戈等四大母港未来72小时潮汐序列。","mainEntities":["四大母港潮汐序列","出港时间窗","12.8米吃水阈值"]}`,
	})

	if gotPath != "/api/apps" {
		t.Fatalf("path = %s, want /api/apps", gotPath)
	}
	if gotBody["link"] != "http://10.0.0.1:18001" {
		t.Fatalf("link = %v, want the deployed URL", gotBody["link"])
	}
	if gotBody["name"] != "潮汐窗口" || gotBody["id"] != "command-dashboard-j98t" {
		t.Fatalf("unexpected payload: %v", gotBody)
	}
	if gotBody["description"] != "四大母港潮汐看板" {
		t.Fatalf("description = %v, want the application description", gotBody["description"])
	}
	if long, _ := gotBody["longDescription"].(string); long == "" {
		t.Fatalf("longDescription missing from payload: %v", gotBody)
	}
	features, _ := gotBody["features"].([]any)
	if len(features) != 3 {
		t.Fatalf("features = %v, want the 3 mainEntities tags", gotBody["features"])
	}
}

// TestRegisterAppWithSquareServerError proves an unreachable square never
// panics or blocks (best-effort contract).
func TestRegisterAppWithSquareServerError(t *testing.T) {
	t.Setenv("FACTORY_APP_SQUARE_URL", "http://127.0.0.1:1")
	RegisterAppWithSquare(context.Background(), model.Application{Slug: "x", Name: "X"}, "http://h:1", nil)
}

func TestMain(m *testing.M) { os.Exit(m.Run()) }
