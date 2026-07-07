# AI Prototype Workbench

一个用于多轮生成和调整前端原型样式的工作台。上方显示生成后的 HTML 原型，下方通过对话输入需求和修改意见。

## 安全边界

- DeepSeek API Key 只放在服务端环境变量或 `.env` 文件中。
- Blade OS PAT 只放在服务端环境变量或 `.env` 文件中。
- 不要把真实 Key 写进 `public/`、提交到 Git，或发给浏览器。
- 生成内容在 `sandbox iframe` 中运行。
- 第一版不接数据库，会话和当前 HTML 保存在浏览器 `localStorage`。

## 文件服务器串行模式

- 上游把待定需求写入 `PENDING_INPUT_PATH` 指定的共享文件，内容可以是纯 `.txt` 或 `.md` 文本。
- 页面轮询到该文件后，会把全文写入会话区并填入输入框，然后停止轮询；不会移动、复制或删除待定文件。
- 用户可以继续手动编辑输入框，点击「生成 / 调整」生成原型。
- 用户确认原型后点击「确认并复制链接」，服务端会把当前 HTML 覆盖写入 `CONFIRMED_OUTPUT_PATH`。
- 当前是单任务串行模式；只有用户点击「重置」后才恢复轮询待定输入文件。

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
| `BLADE_OS_BASE_URL` | 空 | Blade OS 文件服务地址，例如 `http://115.190.152.1` |
| `BLADE_OS_PAT` | 空 | Blade OS Bearer PAT，仅服务端使用 |
| `BLADE_OS_TIMEOUT_MS` | `30000` | 文件服务请求超时时间 |
| `PENDING_INPUT_PATH` | 空 | 待定输入共享文件路径，例如 `共享/pending.md` |
| `CONFIRMED_OUTPUT_PATH` | 空 | 用户确认后写入的 HTML 共享文件路径 |
| `PENDING_POLL_INTERVAL_MS` | `3000` | 前端轮询待定文件的间隔，单位毫秒 |

## 测试

```bash
npm test
```
