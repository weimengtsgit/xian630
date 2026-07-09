# Interface Agent - 界面解析智能体

智能体流水线中的**界面解析智能体**，负责接收上游（业务逻辑智能体）传入的需求，通过 DeepSeek 大模型生成符合 C2 军事指挥设计系统的前端原型界面，用户可多轮调整后确认输出。

## 在流水线中的位置

```
用户输入 → 业务逻辑智能体 → 【界面解析智能体】 → 数据抓取智能体 → 生产交付智能体
                                  ↑ 本项目
```

- **上游**：业务逻辑智能体确认需求后，将需求写入共享文件（Blade OS），界面解析智能体轮询读取
- **下游**：用户确认原型后，界面解析智能体将 HTML 写入共享文件 + 回写流水线完成状态，供生产交付智能体使用

## 核心功能

| 功能 | 说明 |
|---|---|
| **AI 原型生成** | 调用 DeepSeek API，根据用户需求描述生成完整 HTML 原型（单文件自包含） |
| **C2 军事指挥设计系统** | 所有生成界面自动套用 C2 深色战术风格（深蓝底色 #0a0e14、科技青蓝强调 #38b6e6、密级横幅、态势卡等），由 `skills/c2-ui-system/style.md` 定义 |
| **多轮调整** | 用户可以在生成结果基础上继续提修改意见（如"改成浅色风""增加统计卡片"），模型基于当前 HTML 增量调整 |
| **文件服务集成** | 通过 Blade OS 文件服务读取上游待定需求、写入确认后的原型 HTML |
| **流水线状态回写** | 用户确认原型后，POST 回写流水线的界面解析阶段完成状态 |
| **预览分享** | 生成的原型可保存为预览链接，供团队查看 |

## 项目结构

```
interface-agent/
├── src/                        # 后端源码（Node.js + Express）
│   ├── server.js               # 入口：加载配置 + 启动服务
│   ├── app.js                  # Express 应用（路由 + 中间件 + 预览管理 + 流水线回写）
│   ├── config.js               # 配置加载（环境变量 + DeepSeek/BladeOS/流水线参数）
│   └── lib/
│       ├── deepseek.js         # DeepSeek 客户端（C2 样式 prompt 构造 + HTML 生成）
│       ├── bladeFiles.js       # Blade OS 文件服务客户端（读写共享文件）
│       ├── validation.js       # 请求校验（消息/历史/当前HTML）
│       ├── rateLimit.js        # 限流（滑动窗口）
│       └── html.js            # HTML 工具（提取/清洗）
├── public/                     # 前端源码（原型工作台 UI）
│   ├── index.html             # 页面结构（C2 密级横幅 + 预览区 + 会话区）
│   ├── app.js                 # 工作台逻辑（轮询待定输入 + 生成/调整 + 确认 + 分享）
│   └── styles.css             # C2 风格样式
├── skills/
│   └── c2-ui-system/          # C2 UI System 设计系统 skill
│       ├── SKILL.md           # skill 说明
│       ├── style.md           # 注入 DeepSeek prompt 的样式规范（设计令牌 + 组件目录 + 原则）
│       └── c2-ui-system.html  # 完整设计系统参考（740 行，活的组件展示墙）
├── test/                       # 测试
│   ├── app.test.js            # 基础路由测试
│   ├── public-ui.test.js      # C2 样式 UI 测试
│   ├── backend-extended.test.js  # 后端扩展测试（374 行）
│   └── frontend-extended.test.js # 前端扩展测试（130 行）
├── .env.example                # 环境变量模板
└── package.json
```

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/pending-input` | 轮询读取上游写入的待定需求文件 |
| `POST` | `/api/generate` | 调用 DeepSeek 生成/调整 HTML 原型 |
| `POST` | `/api/previews` | 保存预览 + 写入确认文件 + 回写流水线完成状态 |
| `GET` | `/preview/:id` | 查看已保存的预览 |

## 技术栈

- **后端**：Node.js + Express + Helmet（安全头）+ node-fetch
- **前端**：原生 JS + CSS（无框架），sandbox iframe 渲染原型
- **AI**：DeepSeek API（通过 Anthropic 兼容接口调用）
- **文件服务**：Blade OS（读写共享文件，与上游/下游通信）
- **样式**：C2 UI System（军事指挥态势感知深色设计系统，令牌驱动）

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY（必填）
npm start
```

访问 `http://localhost:3000`。

开发模式（文件变更自动重启）：
```bash
npm run dev
```

## 部署

```bash
npm install --omit=dev
cp .env.example .env
# 编辑 .env
npm start
```

使用 pm2 守护：
```bash
pm2 start src/server.js --name interface-agent
pm2 save
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DEEPSEEK_API_KEY` | 空 | **必填**，DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名称 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | `20` | 单 IP 每窗口最大请求数 |
| `BLADE_OS_BASE_URL` | 空 | Blade OS 文件服务地址 |
| `BLADE_OS_PAT` | 空 | Blade OS Bearer PAT |
| `PENDING_INPUT_PATH` | 空 | 上游待定需求文件路径（如 `共享/pending.md`） |
| `CONFIRMED_OUTPUT_PATH` | 空 | 确认后写入的 HTML 文件路径（如 `共享/prototype.html`） |
| `PIPELINE_STAGE_COMPLETE_URL` | 空 | 确认原型后回写流水线完成状态的 URL |
| `PUBLIC_BASE_URL` | 空 | 预览分享链接的外部访问地址 |

## 安全

- DeepSeek API Key 和 Blade OS PAT 只在服务端环境变量 / `.env` 中，不暴露给浏览器
- 生成内容在 sandbox iframe 中运行
- Helmet 安全头保护

## 测试

```bash
npm test
```
