# Agent Pipeline 部署文档

## 部署方式

**Podman 镜像 + 容器部署**（蓝绿模式），与 cc-status、factory-server、sf-portal-mvp、interface-agent 一致。

## 镜像信息

| 项 | 值 |
|---|---|
| 镜像名 | `localhost/agent-pipeline:<version>` |
| 基础镜像 | `node:20-alpine`（多阶段构建：build 阶段含 devDeps 做 vite build；runtime 阶段只含生产依赖） |
| 容器端口 | 3000（Dockerfile 设 `PORT=3000`） |
| 宿主机端口 | 18002 |
| 重启策略 | `unless-stopped` |

## 当前部署

| 项 | 值 |
|---|---|
| 版本 | `20260709-134226-f86a6197` |
| 容器名 | `agent-pipeline-20260709-134226-f86a6197` |
| 线上地址 | http://220.154.5.91:18002/ |
| 备份 | `/opt/xian630/backups/20260709-134449-agent-pipeline-replace-sf-portal-pipeline/` |

## 部署步骤

```bash
# 1. 设置版本号
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

# 2. 上传源码到线上临时目录
rsync -avz \
  --exclude node_modules --exclude dist --exclude .env --exclude '*.bak*' \
  --exclude .git --exclude coverage \
  -e "ssh" \
  ./agent-pipeline/ root@220.154.5.91:/tmp/ap-build-$VERSION/

# 3. 在线上构建镜像（多阶段：先 build 前端，再打 runtime）
ssh root@220.154.5.91 \
  "podman build -t localhost/agent-pipeline:$VERSION /tmp/ap-build-$VERSION/"

# 4. 备份当前容器
ssh root@220.154.5.91 << 'EOF'
BACKUP_DIR="/opt/xian630/backups/$(date +%Y%m%d-%H%M%S)-agent-pipeline"
mkdir -p "$BACKUP_DIR"
podman inspect $(podman ps --format '{{.Names}}' | grep agent-pipeline) > "$BACKUP_DIR/container-inspect.json" 2>/dev/null || true
EOF

# 5. 停止旧容器
ssh root@220.154.5.91 "podman stop agent-pipeline-<old-version> && podman rm agent-pipeline-<old-version>"

# 6. 启动新容器
ssh root@220.154.5.91 << EOF
podman run -d \
  --name "agent-pipeline-$VERSION" \
  --restart unless-stopped \
  -p 18002:3000 \
  "localhost/agent-pipeline:$VERSION"
EOF

# 7. 验证
curl -s http://220.154.5.91:18002/api/stages
curl -s http://220.154.5.91:18002/api/projects
curl -s http://220.154.5.91:18002/

# 8. 清理
ssh root@220.154.5.91 "rm -rf /tmp/ap-build-$VERSION"
```

## 回滚

```bash
podman stop agent-pipeline-<current-version>
podman rm agent-pipeline-<current-version>
podman run -d \
  --name "agent-pipeline-<old-version>" \
  --restart unless-stopped \
  -p 18002:3000 \
  "localhost/agent-pipeline:<old-version>"
```

## 从 sf-portal-pipeline 迁移（已完成）

18002 原来运行 `sf-portal-pipeline` 容器（node:20-alpine + bind-mount `/root/sf-portal-node`）。2026-07-09 迁移为镜像蓝绿部署：
- 旧容器配置已备份到 `/opt/xian630/backups/20260709-134449-agent-pipeline-replace-sf-portal-pipeline/`
- 源码保留在 `/root/sf-portal-node/`（旧位置，不再直接运行）
- 新容器通过镜像内置前端 dist/ + 后端 server/，不再需要 bind-mount

## 所有 xian630 服务部署架构

| 服务 | 镜像 | 端口 | 容器 |
|---|---|---|---|
| sf-portal-mvp | `localhost/sf-portal-mvp:<ver>` | 8000→80 | `sf-portal-mvp-<ver>` |
| factory-server | `localhost/factory-server:<ver>` | 8787 | `factory-server-<ver>` |
| cc-status | `localhost/cc-status:<ver>` | 8765 | `cc-status-<ver>` |
| interface-agent | `localhost/interface-agent:<ver>` | 18020→18020 | `interface-agent-<ver>` |
| **agent-pipeline** | `localhost/agent-pipeline:<ver>` | **18002→3000** | **`agent-pipeline-<ver>`** |
