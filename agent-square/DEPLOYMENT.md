# Agent Square 部署文档（一等公民服务 · 镜像蓝绿）

线上：http://220.154.5.91:18016/ （智能体广场）

本服务已从"工厂生成应用"提升为一等公民服务，与 cc-status / factory-server / sf-portal-mvp 同模式：版本化镜像 + `sf_default` 网络 + 统一 `/opt/xian630/` 目录 + 蓝绿部署。区别在于 **agent-square 是独立版本服务**（不与核心三服务共用 `active/VERSION`），按自身节奏单独构建发布。统一部署规范与 `/opt/xian630/` 全局结构见 [`../deploy/ctyun/README.md`](../deploy/ctyun/README.md)（含 Agent Square 独立服务章节）。

## 镜像与端口

| 项 | 值 |
|---|---|
| 镜像 | `localhost/agent-square:<version>` |
| 容器 | `agent-square-<version>` |
| 网络 | `sf_default`（别名 `agent-square`） |
| 端口 | `18016:80` |
| 运行时数据 | bind-mount `/opt/xian630/apps/agent-square/data` → `/var/cache/nginx/appstore`（持久化 `runtime-apps.json`） |
| 重启策略 | `unless-stopped` |

## njs 基镜像（关键）

`/api/apps` 由 nginx njs 提供，需要 `ngx_http_js_module.so`。本机标准 `nginx:alpine` 不带 njs，`apk add nginx-module-njs` 也无法联网安装。**runtime 基镜像 `localhost/nginx-njs:1.31` 由工厂 nginx/1.31.2 镜像 retag 而来**（本机唯一现成 njs 来源），Dockerfile 以它为 runtime 基础。

首次部署或基镜像丢失时，重新生成：

```bash
podman tag \
  localhost/software-factory/operations-management-c4fn:ver_d846cbf9e332cd851e523736 \
  localhost/nginx-njs:1.31
```

## 部署步骤（在 CTYun 主机执行）

```bash
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

# 1. 确保 njs 基镜像
podman tag localhost/software-factory/operations-management-c4fn:ver_d846cbf9e332cd851e523736 localhost/nginx-njs:1.31

# 2. 上传源码到线上临时目录
rsync -az \
  --exclude node_modules --exclude dist --exclude dist.bak* --exclude .env \
  --exclude .git --exclude docs --exclude versions \
  -e "ssh" \
  ./agent-square/ root@220.154.5.91:/tmp/as-build-$VERSION/

# 3. 构建镜像
ssh root@220.154.5.91 "cd /tmp/as-build-$VERSION && podman build -t localhost/agent-square:$VERSION ."

# 4. 准备持久化数据目录（首次）
ssh root@220.154.5.91 "mkdir -p /opt/xian630/apps/agent-square/data /opt/xian630/backups"

# 5. 迁移运行时应用数据（从旧工厂容器，首次）
ssh root@220.154.5.91 \
  "podman cp sf-operations-management-c4fn-18016:/var/cache/nginx/appstore/runtime-apps.json \
     /opt/xian630/apps/agent-square/data/runtime-apps.json"

# 6. 备份旧容器
ssh root@220.154.5.91 "podman inspect sf-operations-management-c4fn-18016 > /opt/xian630/backups/${VERSION}-agent-square-predeploy/container.json 2>/dev/null || true"

# 7. 临时端口验证（18017）
ssh root@220.154.5.91 "podman run -d --name agent-square-$VERSION-verify \
  --network sf_default --network-alias agent-square \
  -p 18017:80 \
  -v /opt/xian630/apps/agent-square/data:/var/cache/nginx/appstore:Z \
  localhost/agent-square:$VERSION"
# 验证：
curl -fsS http://220.154.5.91:18017/health
curl -fsS http://220.154.5.91:18017/api/apps   # 应含光鱼
ssh root@220.154.5.91 "podman stop agent-square-$VERSION-verify && podman rm agent-square-$VERSION-verify"

# 8. 蓝绿切换 18016
ssh root@220.154.5.91 "podman stop sf-operations-management-c4fn-18016"   # 停旧工厂容器
ssh root@220.154.5.91 "podman run -d --name agent-square-$VERSION \
  --network sf_default --network-alias agent-square \
  --restart unless-stopped \
  -p 18016:80 \
  -v /opt/xian630/apps/agent-square/data:/var/cache/nginx/appstore:Z \
  localhost/agent-square:$VERSION"

# 9. 验证 + 清理
curl -fsS http://220.154.5.91:18016/health
curl -fsS http://220.154.5.91:18016/api/apps
ssh root@220.154.5.91 "rm -rf /tmp/as-build-$VERSION"
```

## 回滚

```bash
ssh root@220.154.5.91 \
  "podman stop agent-square-<version> && podman rm agent-square-<version> && \
   podman start sf-operations-management-c4fn-18016"
```

runtime-apps.json 已在 `/opt/xian630/apps/agent-square/data/` 持久化，回滚不影响数据（旧工厂容器内的那份是迁移前的快照）。

## 治理说明

agent-square 接管 18016 后，**不要再通过 factory-server 重新生成/部署 `operations-management-c4fn`**（含已生成的 `y5y3` 版本），否则会与 agent-square 抢占 18016 端口。若未来需用工厂再生成该应用，应换新端口或先停 agent-square。
