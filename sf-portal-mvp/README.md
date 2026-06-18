# SF Portal

Intelligent Software Factory Portal - 智能软件工厂门户系统

## 技术栈

- React 18
- Vite 6
- Lucide React Icons

## 功能特性

- 🎨 参考 situation-prototype 的整体布局风格
- 📍 顶部菜单栏（主菜单、标题、状态信息）
- 🔧 左侧工具栏（功能菜单）
- 🌌 深色科幻主题

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

## 项目结构

```
sf-portal/
├── index.html
├── package.json
├── vite.config.js
├── README.md
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── App.css
    ├── index.css
    └── components/
        ├── TopBar.jsx
        └── LeftToolbar.jsx
```

## 布局说明

- **TopBar**: 顶部状态栏，包含主菜单、系统标题、状态信息
- **LeftToolbar**: 左侧功能菜单，提供快捷导航
- **PortalContent**: 主内容区域，可扩展具体业务组件

## 后端 API 对接

门户前端现在对接 `factory-server`（智能软件工厂后端服务），数据均来自真实接口而非 Mock 数据。

- 默认 API 地址：`http://127.0.0.1:8787`
- 可通过环境变量覆盖：`VITE_FACTORY_API_BASE_URL`（例如 `.env.local` 中设置 `VITE_FACTORY_API_BASE_URL=http://localhost:8787`）
- 涉及的接口：`/api/apps`、`/api/agents`、`/api/jobs`、`/api/jobs/:id/steps` 等；实时事件通过 SSE `GET /api/events` 推送（`app.updated`、`job.created/updated`、`step.updated`、`artifact.created`、`deployment.updated`）。

`factory-server` 已启用 CORS（`Access-Control-Allow-Origin: *`），因此门户（Vite 开发服务器 `http://localhost:3001`）可直接跨域调用 `http://127.0.0.1:8787`，无需代理。开发服务器端口为 `3001`（见 `vite.config.js`）。

相关代码：
- `src/api/client.js` — REST 客户端（`factoryApi`）
- `src/api/events.js` — SSE 订阅（`subscribeFactoryEvents`）
- `src/hooks/useApplications.js` / `useAgents.js` / `useJobs.js` — 数据 Hooks
