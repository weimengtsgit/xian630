package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// Agent Square（智能体广场）运行时注册。部署成功后把生成应用 POST 到广场的
// /api/apps（njs 开放注册接口），让新生成/重新部署的智能体自动出现在广场里。
// 注册地址由 FACTORY_APP_SQUARE_URL 配置（如 http://agent-square:80）；留空则
// 完全关闭该行为，保持历史部署语义不变。注册失败只记日志——广场是目录展示面，
// 不应该反过来让部署步骤失败。

const appSquareRegisterTimeout = 5 * time.Second

// registerAppWithSquare posts the deployed app to the Agent Square runtime
// registry. Best-effort: errors are logged, never returned.
func RegisterAppWithSquare(ctx context.Context, app model.Application, url string) {
	base := os.Getenv("FACTORY_APP_SQUARE_URL")
	if base == "" {
		return
	}
	payload := map[string]any{
		"id":          app.Slug,
		"name":        app.Name,
		"description": app.Description,
		"link":        url,
		"vendor":      "软件工厂",
		"category":    "生成应用",
		"version":     "v1.0.0",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("app-square register: marshal %s: %v", app.Slug, err)
		return
	}
	reqCtx, cancel := context.WithTimeout(ctx, appSquareRegisterTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base+"/api/apps", bytes.NewReader(body))
	if err != nil {
		log.Printf("app-square register: build request %s: %v", app.Slug, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("app-square register: post %s: %v", app.Slug, err)
		return
	}
	defer res.Body.Close()
	// 201 = 新注册；200 = 广容实现的其他成功形态。4xx/5xx 记录状态码即可诊断。
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		log.Printf("app-square register: post %s: unexpected status %d", app.Slug, res.StatusCode)
		return
	}
	log.Printf("app-square register: %s -> %s registered (%d)", app.Slug, url, res.StatusCode)
}
