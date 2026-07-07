# AI Prototype Workbench

一个用于多轮生成和调整前端原型样式的工作台。上方显示生成后的 HTML 原型，下方通过对话输入需求和修改意见。

## 安全边界

- DeepSeek API Key 只放在服务端环境变量或 `.env` 文件中。
- 不要把真实 Key 写进 `public/`、提交到 Git，或发给浏览器。
- 生成内容在 `sandbox iframe` 中运行。
- 第一版不接数据库，会话和当前 HTML 保存在浏览器 `localStorage`。

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm start
```

访问 `http://localhost:3000`。

## Linux 部署

```bash
npm install --omit=dev
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm start
```

使用 pm2：

```bash
pm2 start src/server.js --name ai-prototype-workbench
pm2 save
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址；内网访问使用 `0.0.0.0` |
| `PUBLIC_BASE_URL` | 空 | 可选，生成预览分享链接时使用的外部访问地址，例如 `http://192.168.1.109:3100` |
| `DEEPSEEK_API_KEY` | 空 | 必填，DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名称 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口，单位毫秒 |
| `RATE_LIMIT_MAX` | `20` | 单 IP 每个窗口最大请求数 |

## 测试

```bash
npm test
```
