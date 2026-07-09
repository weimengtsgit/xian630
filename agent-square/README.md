# 智能体广场 (Agent Square)

作战管理中心的智能软件目录，对应线上服务：

```text
http://220.154.5.91:18016/
```

## 当前源码状态

本地源码已按线上 18016 运行结果整理恢复，并将当前工程名统一为 `agent-square`：

- 内置 10 个智能体/应用入口。
- 支持从 `/api/apps` 合并运行时智能体。
- 支持 `window.__STORE_APPS__` 首屏注入。
- 支持 `window.registerStoreApp(app)` 和 `window.deleteStoreApp(idOrName)`。
- 新品推荐会优先展示运行时新增的 `“光鱼”无人艇跟监告警智能体`。

本地保留的线上运行时数据和 Nginx 代理快照保存在：

```text
runtime-data/api-apps.json
docs/online-18016/
```

更完整的恢复说明见：

```text
RESTORE_NOTES.md
```

## 开发

```bash
npm install
npm run dev
```

`npm run dev` 只启动 Vite 前端开发服务，不会自动提供 `/api/apps`。

## 从源码还原线上页面

```bash
npm install
npm run build
npm run preview:local
```

然后访问：

```text
http://127.0.0.1:18016/
```

`preview:local` 会使用构建后的 `dist`，并读取已捕获的线上运行时数据：

```text
runtime-data/api-apps.json
```

如需指定端口或数据文件：

```bash
PORT=18018 npm run preview:local
API_APPS_FILE=/path/to/api-apps.json npm run preview:local
```

## 构建

```bash
npm run build
```

## Docker 部署

```bash
docker build -t agent-square .
docker run -p 18016:80 agent-square
```

注意：线上 18016 使用 Nginx njs 提供 `/api/apps`。如果直接使用当前 Dockerfile 部署静态容器，需要在部署层继续提供同等的 `/api/apps` 能力，否则运行时新增应用不会出现。
