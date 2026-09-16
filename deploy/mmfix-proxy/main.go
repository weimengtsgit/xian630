// mmfix-proxy: Anthropic /v1/messages 请求修正代理。
//
// 背景：Claude Code CLI 会在 messages 数组里额外发送 role:"system" 的消息
// （顶层 system 之外），而部分 vLLM 网关的 /v1/messages 适配层只接受
// user/assistant 角色，直接转发会 400：
//   Input should be 'user' or 'assistant', input: 'system'
//
// 本代理把 messages 内的 system 消息内容合并进顶层 system（保留原有顺序，
// 追加在原 system 之后），其余字段原样透传；响应与 SSE 流不做任何改动。
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func main() {
	upstream := os.Getenv("UPSTREAM")
	if upstream == "" {
		log.Fatal("UPSTREAM env required (e.g. http://10.252.216.22:37755/minimax-m27)")
	}
	addr := os.Getenv("LISTEN")
	if addr == "" {
		addr = ":8080"
	}
	u, err := url.Parse(upstream)
	if err != nil {
		log.Fatalf("bad UPSTREAM: %v", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.ErrorLog = log.Default()
	// 直连上游：忽略 HTTP(S)_PROXY 环境变量，避免容器继承宿主代理配置
	// 导致直连可达的网关反而走代理被拒（proxyconnect connection refused）。
	proxy.Transport = &http.Transport{
		Proxy:             nil,
		ForceAttemptHTTP2: true,
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/messages") {
			body, err := io.ReadAll(r.Body)
			if err == nil {
				fixed := fixSystem(body)
				r.Body = io.NopCloser(bytes.NewReader(fixed))
				r.ContentLength = int64(len(fixed))
				r.Header.Set("Content-Length", strconv.Itoa(len(fixed)))
			} else {
				log.Printf("read body: %v", err)
			}
		}
		proxy.ServeHTTP(w, r)
	})
	log.Printf("mmfix-proxy listening on %s -> %s", addr, upstream)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// fixSystem merges role:"system" messages into the top-level system field.
// Returns the original body unchanged on any parse failure or when nothing
// needs fixing (fail-open: an unparseable body is forwarded as-is).
func fixSystem(body []byte) []byte {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return body
	}
	rawMsgs, ok := top["messages"]
	if !ok {
		return body
	}
	var msgs []json.RawMessage
	if err := json.Unmarshal(rawMsgs, &msgs); err != nil {
		return body
	}

	var sysTexts []string
	kept := make([]json.RawMessage, 0, len(msgs))
	for _, rm := range msgs {
		var m struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(rm, &m); err == nil && m.Role == "system" {
			if t := contentText(m.Content); t != "" {
				sysTexts = append(sysTexts, t)
			}
			continue
		}
		kept = append(kept, rm)
	}
	if len(sysTexts) == 0 {
		return body
	}

	// Existing top-level system may be absent, a plain string, or a block array.
	var blocks []json.RawMessage
	if raw, ok := top["system"]; ok && string(raw) != "null" {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			b, _ := json.Marshal(map[string]string{"type": "text", "text": s})
			blocks = append(blocks, b)
		} else if err := json.Unmarshal(raw, &blocks); err != nil {
			// Unexpected shape: keep as-is and just append after? Safer to bail.
			log.Printf("unparseable system field, leaving request untouched")
			return body
		}
	}
	for _, t := range sysTexts {
		b, _ := json.Marshal(map[string]string{"type": "text", "text": t})
		blocks = append(blocks, b)
	}

	// Rebuild the request, preserving all other fields untouched.
	out := make(map[string]json.RawMessage, len(top)+1)
	for k, v := range top {
		out[k] = v
	}
	if err := setRaw(out, "system", blocks); err != nil {
		return body
	}
	if err := setRaw(out, "messages", kept); err != nil {
		return body
	}
	fixed, err := json.Marshal(out)
	if err != nil {
		return body
	}
	return fixed
}

func setRaw(out map[string]json.RawMessage, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	out[key] = b
	return nil
}

// contentText extracts plain text from an Anthropic content field (string or
// block array). Non-text blocks are skipped.
func contentText(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n\n")
			}
			sb.WriteString(b.Text)
		}
	}
	return sb.String()
}
