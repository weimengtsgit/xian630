# SF Portal - 智能体流水线页面

智能软件工厂的智能体流水线展示页面。以可视化流水线形式呈现从用户需求到应用交付的完整链路，每个智能体阶段可点击跳转到对应的服务页面。

## 流水线阶段

流水线包含 5 个阶段，按顺序串联：

| 阶段 | 说明 | 跳转地址 |
|---|---|---|
| 用户输入卡片 | 用户在对话中输入应用需求，关键词提炼后流入流水线首端 | （本页内对话） |
| 业务逻辑智能体 | 需求分析与业务逻辑确认 | https://115.190.228.77:18701/ |
| 界面解析智能体 | 界面原型设计与原型契约生成 | http://220.154.5.91:18020/ |
| 数据抓取智能体 | 数据源接入与数据契约确认 | http://203.83.238.87:8099/ |
| 生产交付智能体 | 代码生成、构建、镜像化与部署 | http://115.190.152.1:8020/p/9/chat/2026-0611-1207-4k6u |

阶段配置存储在 `server/stages.json`，由后端 `/api/stages` 接口提供，前端读取后渲染为可点击的智能体卡片。

## 技术栈

- **前端**：React 18 + Vite 6 + Lucide React Icons，深色科幻主题
- **后端**：Node.js + Express，提供 `/api/stages` 接口（阶段配置 + 运行状态管理）
- **部署**：nginx 静态服务前端构建产物 + 反向代理 `/api/*` 到后端

## 项目结构

```
sf-portal/
├── src/                    # 前端源码（React/Vite）
│   ├── App.jsx             # 主应用（流水线布局 + 对话入口）
│   ├── components/         # UI 组件
│   │   ├── TopBar.jsx      # 顶部菜单栏
│   │   ├── LeftToolbar.jsx # 左侧功能菜单
│   │   ├── AgentsPanel.jsx # 智能体流水线面板
│   │   └── ChatDialog.jsx   # AI 对话输入框
│   ├── hooks/              # 数据钩子
│   └── utils/              # 工具函数
├── server/                 # 后端源码（Express）
│   ├── index.js            # 入口：createApp().listen(port)
│   ├── app.js              # Express 应用（同源策略 + /api/stages 路由 + 静态文件服务）
│   ├── stages.js           # 阶段配置读取 + 内存状态管理（pending/working/completed）
│   ├── stages.json         # 阶段静态配置（名称 + 跳转 URL）
│   └── *.test.js           # 测试
├── dist/                   # 前端构建产物（npm run build 生成）
├── package.json
└── vite.config.js
```

## 开发

```bash
# 安装依赖
npm install

# 启动前端开发服务器（Vite 热重载）
npm run dev

# 构建前端
npm run build

# 启动后端服务（Express，提供 /api/stages + 静态文件服务）
npm start
```

## 阶段状态

每个智能体阶段有三种运行状态：

- `pending` - 等待中（默认）
- `working` - 处理中
- `completed` - 已完成

状态存储在后端内存中（重启后回到全 pending），通过 `/api/stages` 接口读取。

## 安全与网络隔离

- **同源策略（不设置宽松 CORS）**：agent-pipeline SPA 与后端同源，fetch 调用默认同源。**不**设置全局 `Access-Control-Allow-Origin: *`，否则任意跨站页面可对 `POST /api/projects/:id/interface-launch` 发起表单/fetch 请求（该路由无用户鉴权）。
- **interface-launch 同源 Origin 校验（M1 缓解）**：`POST /api/projects/:id/interface-launch` 校验 `Origin` 头——若 Origin 存在且与 agent-pipeline 自身 origin 不同则返回 403，阻断跨站 startCode 铸造。无 Origin 头（非浏览器 / 直接调用）放行。
- **`INTERFACE_AGENT_INTERNAL_TOKEN`**：interface-launch 调用 interface-agent resolve 时携带此服务间共享密钥（`X-Internal-Token`），两端必须配置相同值。
- **无用户鉴权（既有基线）**：agent-pipeline 所有路由均无用户认证。这是一个**未认证的内部运维工具**，**必须在网络层面隔离**（仅可信内网可达，不暴露公网）。用户鉴权层是路线图项；版本机制功能通过新增 interface-launch 提高了风险等级，但未引入该开放服务基线——其本身需要网络隔离保护。
- `interfaceEditToken` 仅存于服务端（projects.json），**绝不**返回给浏览器；浏览器只拿到一次性 startCode。
