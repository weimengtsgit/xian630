# Software Factory — 容器化部署 (Docker / Podman 通用)

同一套 `compose.yaml` + 镜像可在 **Podman** 或 **Docker** 主机上部署。通过 `.env`
选择宿主运行时与挂载的 socket，factory 容器内置 `podman` 与 `docker` 两个 CLI，
由 `FACTORY_CONTAINER_RUNTIME` 决定调哪个。

## 架构

```
内网/公网 ──▶ portal (nginx :80)
              ├─ /            → sf-portal-mvp 静态文件 (同源)
              ├─ /api/        → factory:8787  (proxy_buffering off, 支持 SSE)
              └─ /healthz     → factory:8787
            factory-server (容器内, 不发布端口)
              ├─ claude CLI + npm + node20  (真实生成)
              ├─ podman / docker CLI → 经 socket 操作「宿主」运行时
              └─ 数据卷: /data(state.db+runs) /workspace/generated-apps /root/.claude
```

portal 与 factory 同源：portal 构建时 `VITE_FACTORY_API_BASE_URL=""`，前端请求
`/api/...` 由 portal 的 nginx 反代到 factory。嵌入方只需一个 URL `http://<host>/`，
新标签页打开即可，无需 iframe/X-Frame-Options。

## 前置 (宿主)

- 已装 Podman 或 Docker（本云主机为 CentOS 9，已装 `podman 5.8.2`）。
- 出网：`api.anthropic.com`(真实生成)、`registry.npmjs.org` 或 `npmmirror`(装 claude)、
  Docker Hub 经镜像 `docker.m.daocloud.io`（基础镜像）。本主机 Docker Hub 被墙，已用镜像。
- Podman 宿主启用 rootful socket：
  `systemctl enable --now podman.socket`（产生 `/run/podman/podman.sock`）。
- 让**生成的应用**的基础镜像也走镜像：配置 `/etc/containers/registries.conf`
  （见下方「宿主 registries 镜像」）。

## 部署

```bash
# 1) 拷贝并填写环境变量
cd deploy
cp .env.example .env
#   ANTHROPIC_API_KEY=sk-ant-...        # 真实生成；留空则需 FACTORY_FAKE_CLAUDE=1
#   FACTORY_CONTAINER_RUNTIME=podman     # 与宿主一致：podman | docker
#   CONTAINER_SOCK=/run/podman/podman.sock

# 2) 构建+启动（任一）
podman compose up -d --build
# docker compose up -d --build      # Docker 宿主

# 3) 验证
curl http://127.0.0.1/healthz          # {"ok":true}
```

嵌入链接：`http://<内网IP或公网IP>/`（端口为 `PORTAL_PORT`，默认 80）。

## 宿主 registries 镜像（让生成的应用拉基础镜像成功）

生成应用的 Dockerfile 里通常是 `FROM node:xx-alpine` 等公共镜像，由**宿主** podman
拉取。宿主 Docker Hub 被墙，需配置镜像：

```bash
cat >/etc/containers/registries.conf <<'EOF'
unqualified-search-registries = ["docker.io"]
[[registry]]
location = "docker.io"
[[registry.mirror]]
location = "docker.m.daocloud.io"
[[registry.mirror]]
location = "docker.1ms.run"
EOF
```

## 安全（重要）

- factory 的 `/api/jobs` 可触发 claude/npm/容器执行 + 消耗 ANTHROPIC_API_KEY。
- **本主机防火墙全开**（iptables ACCEPT，无 firewalld），所以访问控制只能在天翼云
  **安全组**层做：公网 :80 务必限定到嵌入方出口 IP，否则等于公开 RCE + 公开烧 token。
- 镜像源、API key、密码只在宿主本地 `.env`，已加入忽略，不进仓库。

## 运维

```bash
podman compose logs -f factory        # 实时日志
podman compose restart factory
podman compose down                   # 停止（数据卷保留）
podman volume ls | grep sf_           # sf-data / sf-apps / sf-claude
```

生成应用跑在宿主运行时上，端口由 factory 的 deployment 步骤分配（避开 80）。
