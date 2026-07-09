# Interface Agent 部署文档

## 部署方式

**Podman 镜像 + 容器部署**（蓝绿模式），与 cc-status、factory-server、sf-portal-mvp 一致。

## 镜像信息

| 项 | 值 |
|---|---|
| 镜像名 | `localhost/interface-agent:<version>` |
| 基础镜像 | `node:20-alpine` |
| 容器端口 | 18020（由 `.env` 中 `PORT=18020` 决定） |
| 宿主机端口 | 18020 |
| 重启策略 | `unless-stopped` |
| env-file | `/opt/ai-prototype-workbench/.env` |

## 当前部署

| 项 | 值 |
|---|---|
| 版本 | `20260709-131328-f86a6197` |
| 容器名 | `interface-agent-20260709-131328-f86a6197` |
| 线上地址 | http://220.154.5.91:18020/ |
| 备份 | `/opt/xian630/backups/<timestamp>-interface-agent-pm2-to-container/` |

## 部署步骤

```bash
# 1. 设置版本号
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

# 2. 上传源码到线上临时目录
rsync -avz \
  --exclude node_modules --exclude dist --exclude .env --exclude '*.bak*' \
  --exclude test --exclude tests --exclude .git \
  -e "ssh" \
  ./interface-agent/ root@220.154.5.91:/tmp/ia-build-$VERSION/

# 3. 在线上构建镜像
ssh root@220.154.5.91 \
  "podman build -t localhost/interface-agent:$VERSION /tmp/ia-build-$VERSION/"

# 4. 备份当前部署（容器 stop 前先存）
ssh root@220.154.5.91 << 'EOF'
BACKUP_DIR="/opt/xian630/backups/$(date +%Y%m%d-%H%M%S)-interface-agent"
mkdir -p "$BACKUP_DIR"
# 备份当前容器信息
podman inspect $(podman ps --format '{{.Names}}' | grep interface-agent) > "$BACKUP_DIR/container-inspect.json" 2>/dev/null || true
EOF

# 5. 停止旧容器
ssh root@220.154.5.91 "podman stop interface-agent-<old-version> && podman rm interface-agent-<old-version>"

# 6. 启动新容器
ssh root@220.154.5.91 << EOF
podman run -d \
  --name "interface-agent-$VERSION" \
  --restart unless-stopped \
  -p 18020:18020 \
  --env-file /opt/ai-prototype-workbench/.env \
  "localhost/interface-agent:$VERSION"
EOF

# 7. 验证
curl -s http://220.154.5.91:18020/health

# 8. 清理
ssh root@220.154.5.91 "rm -rf /tmp/ia-build-$VERSION"
```

## 回滚

```bash
# 停当前容器
podman stop interface-agent-<current-version>
podman rm interface-agent-<current-version>

# 启动旧版镜像（如果还在）
podman run -d \
  --name "interface-agent-<old-version>" \
  --restart unless-stopped \
  -p 18020:18020 \
  --env-file /opt/ai-prototype-workbench/.env \
  "localhost/interface-agent:<old-version>"
```

## 从 pm2 迁移（已完成）

interface-agent 原来通过 pm2 直接运行 `node src/server.js`。2026-07-09 迁移为容器部署：
- pm2 配置已备份到 `/opt/xian630/backups/20260709-131459-interface-agent-pm2-to-container/`
- `.env` 文件保留在 `/opt/ai-prototype-workbench/.env`（通过 `--env-file` 挂载到容器）
- 源码保留在 `/opt/ai-prototype-workbench/`（旧位置，不再直接运行）

## 所有 xian630 服务部署架构

| 服务 | 镜像 | 端口 | 容器 |
|---|---|---|---|
| sf-portal-mvp | `localhost/sf-portal-mvp:<ver>` | 8000→80 | `sf-portal-mvp-<ver>` |
| factory-server | `localhost/factory-server:<ver>` | 8787 | `factory-server-<ver>` |
| cc-status | `localhost/cc-status:<ver>` | 8765 | `cc-status-<ver>` |
| **interface-agent** | `localhost/interface-agent:<ver>` | **18020→18020** | **`interface-agent-<ver>`** |
