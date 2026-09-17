package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// Agent Square（智能体广场）运行时注册。部署成功后把生成应用 POST 到广场的
// /api/apps（本地 vite middleware 或生产 njs 均实现该接口），让新生成/重新部署
// 的智能体自动出现在广场里。注册地址由 FACTORY_APP_SQUARE_URL 配置（如
// http://127.0.0.1:5173）；留空则完全关闭该行为，保持历史部署语义不变。注册
// 失败只记日志——广场是目录展示面，不应该反过来让部署步骤失败。
//
// 字段来源：卡片描述用 Application.Description（server 已按需求摘要落库），
// 长描述/特征取自 job.ConfirmedRequirementJSON（confirmedRequirement.description
// 与 mainEntities）——job 为 nil 时（理论上仅异常路径）降级为基础字段。

const appSquareRegisterTimeout = 5 * time.Second

// squareRequirement is the slice of confirmedRequirement the store card uses.
// Kept local (json.RawMessage style) to avoid coupling executor to the
// clarification package's full contract.
type squareRequirement struct {
	AppName         string   `json:"appName"`
	AppType         string   `json:"appType"`
	Description     string   `json:"description"`
	AcceptanceFocus []string `json:"acceptanceFocus"`
	MainEntities    []string `json:"mainEntities"`
}

// squareFeatures turns requirement entities/acceptance notes into short store
// feature tags: mainEntities first (they are noun phrases), acceptanceFocus as
// fallback (full sentences, truncated). Max 5 tags, each capped for card layout.
func squareFeatures(req *squareRequirement) []string {
	src := req.MainEntities
	if len(src) == 0 {
		src = req.AcceptanceFocus
	}
	out := make([]string, 0, 5)
	for _, raw := range src {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		// Feature tags render as chips in the detail panel; cap the length so a
		// long acceptance sentence cannot blow up the layout.
		if len([]rune(tag)) > 24 {
			tag = string([]rune(tag)[:24]) + "…"
		}
		out = append(out, tag)
		if len(out) == 5 {
			break
		}
	}
	return out
}

// RegisterAppWithSquare posts the deployed app to the Agent Square runtime
// registry. Best-effort: errors are logged, never returned. job may be nil —
// the store card then degrades to the application's own name/description.
func RegisterAppWithSquare(ctx context.Context, app model.Application, url string, job *model.Job) {
	base := os.Getenv("FACTORY_APP_SQUARE_URL")
	if base == "" {
		return
	}
	var req squareRequirement
	if job != nil && strings.TrimSpace(job.ConfirmedRequirementJSON) != "" {
		if err := json.Unmarshal([]byte(job.ConfirmedRequirementJSON), &req); err != nil {
			log.Printf("app-square register: parse requirement %s: %v", app.Slug, err)
		}
	}

	description := strings.TrimSpace(app.Description)
	if description == "" {
		description = strings.TrimSpace(req.Description)
		if len([]rune(description)) > 120 {
			description = string([]rune(description)[:120]) + "…"
		}
	}
	payload := map[string]any{
		"id":              app.Slug,
		"name":            app.Name,
		"description":     description,
		"longDescription": strings.TrimSpace(req.Description),
		"link":            url,
		"vendor":          "电子云",
		// 广场筛选分类是研判域（状态/动向/意图/威胁/其他），生成应用没有
		// 可靠的自动归类依据，统一落「其他」；需要研判域分类的卡由运营改库。
		"category":    "其他",
		"version":     "v1.0.0",
		"publishDate": time.Now().Format("2006-01-02"),
	}
	if features := squareFeatures(&req); len(features) > 0 {
		payload["features"] = features
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("app-square register: marshal %s: %v", app.Slug, err)
		return
	}
	reqCtx, cancel := context.WithTimeout(ctx, appSquareRegisterTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base+"/api/apps", bytes.NewReader(body))
	if err != nil {
		log.Printf("app-square register: build request %s: %v", app.Slug, err)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		log.Printf("app-square register: post %s: %v", app.Slug, err)
		return
	}
	defer res.Body.Close()
	// 201 = 新注册；200 = 广场实现的其他成功形态（幂等 upsert 也走 200/201）。
	// 4xx/5xx 记录状态码即可诊断。
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		log.Printf("app-square register: post %s: unexpected status %d", app.Slug, res.StatusCode)
		return
	}
	log.Printf("app-square register: %s -> %s registered (%d)", app.Slug, url, res.StatusCode)
}
