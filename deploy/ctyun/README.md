# CTYun Production Deployment Guide

This guide documents the production deployment pattern on China Telecom Cloud.

**统一发布的核心三服务**（共享一个 `VERSION`、`active/` 与 `releases/<version>/`，一起构建切换）：

- `cc-status`
- `factory-server`
- `sf-portal-mvp`

**独立发布的服务**（各自版本号、各自构建切换，互不影响）：

- `agent-square`（18016，智能体广场）— 见文末 [Agent Square（独立服务）](#agent-square独立服务) 章节
- `interface-agent`（18020）、`agent-pipeline`（18002）— 见各自目录下 `DEPLOYMENT.md`

The production host uses CentOS Stream 9 and rootful Podman. Images must be
versioned and named exactly after the service:

- `localhost/cc-status:<version>`
- `localhost/factory-server:<version>`
- `localhost/sf-portal-mvp:<version>`

## Directory Layout

Use one stable root for all deployment state:

```text
/opt/xian630/
  backups/
    <timestamp>-predeploy-<version>/
  releases/
    <version>/
      source/
      build/
      metadata/
  apps/
    cc-status/
      data/
      logs/
    factory-server/
      data/        # optional bind layout; current production reuses sf_sf-data
      runs/
    sf-portal-mvp/
  active/
    VERSION
```

Current production keeps the historical Software Factory Podman volumes:

- `sf_sf-data` mounted at `/data`
- `sf_sf-apps` mounted at `/workspace/generated-apps`
- `sf_sf-claude` mounted at `/root/.claude`

Keep these volumes during upgrades unless an explicit data migration is planned.

## Version Format

Use a timestamp plus the Git short SHA:

```bash
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
```

Example:

```text
20260709-101530-d4f3b30d
```

## Build Images

Build on the CTYun host so the images match the production architecture
(`x86_64`). The build context is the repository root for `factory-server` and
`sf-portal-mvp`, and `cc-status/` for `cc-status`.

```bash
podman build \
  -t localhost/cc-status:${VERSION} \
  -f deploy/Dockerfile.cc-status \
  --build-arg VERSION=${VERSION} \
  cc-status

podman build \
  -t localhost/factory-server:${VERSION} \
  -f deploy/Dockerfile.factory \
  .

podman build \
  -t localhost/sf-portal-mvp:${VERSION} \
  -f deploy/Dockerfile.portal \
  --build-arg VITE_FACTORY_API_BASE_URL="" \
  .
```

Do not rely on `latest` as the rollback anchor. `latest` can be added as a
convenience tag after the versioned images pass verification.

## Network

All three services should join the `sf_default` Podman network.

Expected service aliases:

- `cc-status` resolves to the `cc-status` container.
- `factory` resolves to the active `factory-server` container, because
  `sf-portal-mvp` Nginx proxies `/api/` to `factory:8787`.

Create the network if it does not exist:

```bash
podman network exists sf_default || podman network create sf_default
```

## Runtime Commands

`cc-status` runs internally on port `8765`:

```bash
podman run -d \
  --name cc-status-${VERSION} \
  --network sf_default \
  --network-alias cc-status \
  --restart unless-stopped \
  -v /opt/xian630/apps/cc-status/data:/data:Z \
  -v /opt/xian630/apps/cc-status/logs:/var/log/cc-status:Z \
  localhost/cc-status:${VERSION}
```

`factory-server` runs internally on port `8787` and talks to the host Podman
socket:

```bash
podman run -d \
  --name factory-server-${VERSION} \
  --network sf_default \
  --network-alias factory \
  --restart unless-stopped \
  --add-host host-gateway:host-gateway \
  -e FACTORY_ADDR=0.0.0.0:8787 \
  -e FACTORY_CC_STATUS_BASE_URL=http://cc-status:8765 \
  -e FACTORY_CONTAINER_RUNTIME=podman \
  -e FACTORY_HEALTH_HOST=host-gateway \
  -e FACTORY_APP_URL_HOST=<public-or-private-host> \
  -e DOCKER_HOST=unix:///var/run/runtime.sock \
  -e CONTAINER_HOST=unix:///var/run/runtime.sock \
  -v /run/podman/podman.sock:/var/run/runtime.sock \
  -v sf_sf-data:/data \
  -v sf_sf-apps:/workspace/generated-apps \
  -v sf_sf-claude:/root/.claude \
  --env-file /opt/xian630/runtime/factory.env \
  localhost/factory-server:${VERSION}
```

`sf-portal-mvp` publishes the external HTTP port. Current production uses
`8000:80`:

```bash
podman run -d \
  --name sf-portal-mvp-${VERSION} \
  --network sf_default \
  --restart unless-stopped \
  -p 8000:80 \
  localhost/sf-portal-mvp:${VERSION}
```

## Blue-Green Procedure

1. Back up current containers, image metadata, systemd units, and data volumes.
2. Build the three versioned images.
3. Start the new `cc-status` container.
4. Start the new `factory-server` container with the `factory` network alias.
5. Start the new `sf-portal-mvp` container on a temporary verification port.
6. Verify:

```bash
curl -fsS http://127.0.0.1:<temp-portal-port>/healthz
curl -fsS http://127.0.0.1:<temp-portal-port>/
podman logs --tail 100 cc-status-${VERSION}
podman logs --tail 100 factory-server-${VERSION}
podman logs --tail 100 sf-portal-mvp-${VERSION}
```

7. Switch the public port by stopping the old portal container and starting the
   verified new portal on `8000:80`.
8. Keep the old containers stopped, not removed, until the release is accepted.

## Rollback

Rollback is container-level. The old images and stopped containers are retained
by the predeploy backup.

```bash
podman stop sf-portal-mvp-${VERSION} factory-server-${VERSION} cc-status-${VERSION}
podman start <old-factory-container>
podman start <old-portal-container>
```

If a data rollback is required, restore from:

```text
/opt/xian630/backups/<timestamp>-predeploy-<version>/volumes/
```

Only restore data after stopping all containers that mount the affected volume.

## Agent Square（独立服务）

`agent-square`（智能体广场，18016）原为 factory-server 生成的应用，现提升为独立一等公民服务：版本化镜像 + `sf_default` 网络 + `/opt/xian630/` 目录 + 蓝绿部署。它与核心三服务**不共用版本号**，按自身节奏单独构建发布。

### 目录结构

```text
/opt/xian630/
  apps/agent-square/
    data/                   # bind-mount → /var/cache/nginx/appstore（持久化运行时应用）
      runtime-apps.json     # 含"光鱼"等动态注册智能体；属主 nginx(101:101) 以便 njs 写入
  backups/
    <version>-agent-square-predeploy/
```

注意：agent-square 不进 `active/` 与统一 `releases/<version>/`（那是核心三服务的统一发布位）。源码即真相，在仓库 `agent-square/` 下，回滚靠"停新容器 + 启旧容器"。

### njs 基镜像（关键）

`/api/apps` 由 nginx njs 提供，需 `ngx_http_js_module.so`。本机标准 `nginx:alpine` 不带 njs，`apk add nginx-module-njs` 也无法联网安装。runtime 基镜像 `localhost/nginx-njs:1.31` 由**工厂 nginx/1.31.2 镜像 retag 而来**（本机唯一现成 njs 来源）。基镜像丢失时重建：

```bash
podman tag \
  localhost/software-factory/operations-management-c4fn:ver_d846cbf9e332cd851e523736 \
  localhost/nginx-njs:1.31
```

### 构建镜像

构建上下文 = `agent-square/`（仓库根），在 CTYun 主机上构建以匹配 x86_64：

```bash
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
podman build -t localhost/agent-square:${VERSION} -f agent-square/Dockerfile agent-square/
```

### 运行时命令

```bash
podman run -d \
  --name agent-square-${VERSION} \
  --network sf_default \
  --network-alias agent-square \
  --restart unless-stopped \
  -p 18016:80 \
  -v /opt/xian630/apps/agent-square/data:/var/cache/nginx/appstore:Z \
  localhost/agent-square:${VERSION}
```

- `--network sf_default`：与核心服务同网，可互通。
- `-v .../data:/var/cache/nginx/appstore:Z`：持久化 `runtime-apps.json`，重启/重建不丢；目录属主须为 `101:101`（nginx），否则 njs 写入报 `Permission denied`。

### 运行时数据迁移（首次，从旧工厂容器）

```bash
mkdir -p /opt/xian630/apps/agent-square/data
podman cp sf-operations-management-c4fn-18016:/var/cache/nginx/appstore/runtime-apps.json \
  /opt/xian630/apps/agent-square/data/runtime-apps.json
chown -R 101:101 /opt/xian630/apps/agent-square/data
```

### 蓝绿切换

```bash
# 1. 临时端口验证（避开已占用的 18017 等生成应用端口）
podman run -d --name agent-square-${VERSION}-verify --network sf_default \
  -p 18098:80 -v /opt/xian630/apps/agent-square/data:/var/cache/nginx/appstore:Z \
  localhost/agent-square:${VERSION}
curl -fsS http://127.0.0.1:18098/health
curl -fsS http://127.0.0.1:18098/api/apps        # 应含"光鱼"
podman stop agent-square-${VERSION}-verify && podman rm agent-square-${VERSION}-verify

# 2. 切换 18016
podman stop sf-operations-management-c4fn-18016     # 停旧工厂容器（保留可回滚）
podman run -d --name agent-square-${VERSION} ...    # 见上方"运行时命令"
```

### 回滚

```bash
podman stop agent-square-${VERSION} && podman rm agent-square-${VERSION}
podman start sf-operations-management-c4fn-18016    # 恢复工厂 bind-mount 容器
```

`runtime-apps.json` 已在 `/opt/xian630/apps/agent-square/data/` 持久化，回滚不影响数据。

### 治理说明

agent-square 接管 18016 后，**不要再通过 factory-server 重新生成/部署 `operations-management-c4fn`**（含已生成的 `y5y3` 版本），否则会与 agent-square 抢占 18016 端口。若未来需用工厂再生成该应用，应换新端口或先停 agent-square。

详细步骤亦见 `agent-square/DEPLOYMENT.md`。

## Generated App Nginx Proxy

Generated applications that proxy ontology requests should use this standardized
shape:

```nginx
location /api/ontology/ {
    rewrite ^/api/ontology/(.*)$ /$1 break;
    proxy_pass http://ceshi.projects.bingosoft.net:8081;
    proxy_http_version 1.1;
    proxy_set_header Host ceshi.projects.bingosoft.net;
    proxy_set_header Authorization "<runtime-secret>";
    proxy_set_header Spaceid "<runtime-secret>";
    proxy_set_header scopeType "Space";
}
```

Avoid variable upstreams such as `proxy_pass http://$upstream:8081/` for this
external ontology proxy. The production migration backup for the current
standardization is stored under `/opt/xian630/backups/`.
