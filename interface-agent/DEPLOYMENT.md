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

# 4. 备份当前部署（容器 stop 前先存）—— 必须包含 SQLite 热备（见下方「部署前备份」）
ssh root@220.154.5.91 << 'EOF'
BACKUP_DIR="/opt/xian630/backups/$(date +%Y%m%d-%H%M%S)-interface-agent"
mkdir -p "$BACKUP_DIR"
# 备份当前容器信息
podman inspect $(podman ps --format '{{.Names}}' | grep interface-agent) > "$BACKUP_DIR/container-inspect.json" 2>/dev/null || true
# 备份 SQLite（WAL 模式在线热备，一致快照）
podman exec $(podman ps --format '{{.Names}}' | grep interface-agent) \
  sqlite3 /var/lib/interface-agent/interface-agent.db ".backup '$BACKUP_DIR/interface-agent.db'" 2>/dev/null || true
EOF

# 5. 停止旧容器
ssh root@220.154.5.91 "podman stop interface-agent-<old-version> && podman rm interface-agent-<old-version>"

# 6. 启动新容器
ssh root@220.154.5.91 << EOF
podman run -d \
  --name "interface-agent-$VERSION" \
  --restart unless-stopped \
  -p 18020:18020 \
  -v /var/lib/interface-agent:/var/lib/interface-agent \
  --env-file /opt/ai-prototype-workbench/.env \
  "localhost/interface-agent:$VERSION"
EOF

# 7. 验证
curl -s http://220.154.5.91:18020/health

# 8. 清理
ssh root@220.154.5.91 "rm -rf /tmp/ia-build-$VERSION"
```

## 版本机制持久化与运维

界面稿版本数据（会话、版本树、生成请求、分享、交付）存储在 SQLite。容器内路径由
`INTERFACE_AGENT_DB_PATH` 决定（默认 `/var/lib/interface-agent/interface-agent.db`）。

### 必配环境变量

| 变量 | 必要性 | 说明 |
|---|---|---|
| `INTERFACE_AGENT_DB_PATH` | 推荐 | SQLite 路径；默认 `/var/lib/interface-agent/interface-agent.db`。 |
| `INTERFACE_AGENT_SESSION_SECRET` | **生产必配** | 会话 Cookie 的 HMAC-SHA256 签名密钥。**未配置时**启动会生成临时随机密钥并打印告警，**重启后所有会话 Cookie 失效**（用户需重新用启动码登录）。生产环境必须配置一个固定的强随机值（如 `openssl rand -base64 32`）。 |
| `INTERFACE_AGENT_COOKIE_SECURE=1` | 生产（TLS） | 仅在 HTTPS 下给 Cookie 打 Secure 标志。 |
| `INTERFACE_AGENT_INTERNAL_TOKEN` | **生产必配** | resolve CREATE 的服务间共享密钥（`X-Internal-Token`）。**必须与 agent-pipeline 配置相同的值**。**未配置时**启动打印告警并拒绝所有会话创建（fail-closed），agent-pipeline 无法打开新项目。例：`openssl rand -base64 32`。 |
| `ARTIFACT_CLEANUP_ENABLED` | 可选 | 孤立版本产物回收开关；默认 `1`（开启），设 `0` 关闭。 |
| `ARTIFACT_CLEANUP_INTERVAL_MS` | 可选 | 周期回收间隔，默认 6h；设 `0` 关闭周期回收（启动时的一次性回收仍执行）。 |
| `ARTIFACT_CLEANUP_MAX_AGE_MS` | 可选 | 回收的最小文件年龄，默认 1h（保护在途事务文件，**勿调小**）。 |

### SQLite 持久卷

必须为 `/var/lib/interface-agent` 挂载持久卷（见上方 `podman run` 的 `-v` 参数），否则
替换/重建容器会丢失版本历史。Dockerfile 已声明 `VOLUME ["/var/lib/interface-agent"]`
作为默认匿名卷，但生产部署应**显式绑定宿主机路径**（`-v /var/lib/interface-agent:/var/lib/interface-agent`）。
SQLite 启动时自动开启 WAL、外键和 busy timeout，并在容器关闭时 checkpoint。

### 部署前备份（必须）

每次部署、停旧容器**之前**备份 SQLite（WAL 模式下在线 `.backup` 是一致的）：

```bash
# 方式一：用 sqlite3 在线热备（推荐，容器不停）
TS=$(date +%Y%m%d-%H%M%S)
ssh root@220.154.5.91 \
  "podman exec interface-agent-<old-version> sqlite3 /var/lib/interface-agent/interface-agent.db '.backup /var/lib/interface-agent/backup-$TS.db'"
ssh root@220.154.5.91 \
  "podman cp interface-agent-<old-version>:/var/lib/interface-agent/backup-$TS.db /opt/xian630/backups/interface-agent-db-$TS.db"

# 方式二：停容器后直接从持久卷复制（最稳，需要短暂停服）
ssh root@220.154.5.91 \
  "cp /var/lib/interface-agent/interface-agent.db /opt/xian630/backups/interface-agent-db-$TS.db"
```

### 迁移（自动、幂等、向前兼容）

服务启动时自动执行向前兼容迁移（`src/lib/db/migrations/`，记录于 `schema_migrations`
表）。**二次启动迁移为 no-op**（已验证）。新增迁移只需追加一个迁移文件并在
`migrations/index.js` 注册，**不要编辑或重排已应用的迁移**。

### 回滚演练

```bash
# 1. 停当前容器
podman stop interface-agent-<current-version>
podman rm interface-agent-<current-version>

# 2. （可选）若新版迁移修改了 schema，用部署前备份还原 SQLite 到卷：
cp /opt/xian630/backups/interface-agent-db-<TS>.db /var/lib/interface-agent/interface-agent.db

# 3. 启动旧版镜像
podman run -d \
  --name "interface-agent-<old-version>" \
  --restart unless-stopped \
  -p 18020:18020 \
  -v /var/lib/interface-agent:/var/lib/interface-agent \
  --env-file /opt/ai-prototype-workbench/.env \
  "localhost/interface-agent:<old-version>"
```

> **向前兼容迁移的回滚约束（重要）：** 迁移只向前、不回滚 schema。若新版镜像的迁移
> 已经把 SQLite schema 推进到新版，直接用旧镜像读这个新版 DB **通常兼容**（旧镜像只读
> 已有表/列、不依赖新列）。但如果新版迁移**删除或重命名**了旧镜像依赖的列/表，回滚到
> 旧镜像前**必须用部署前备份还原 SQLite**。因此每次部署前的备份不可省略。

### 监控要点

- 日志**不得**包含密钥：确认日志中没有 `BLADE_OS_PAT` 明文（`sk-blade-v3-…`）、编辑
  令牌明文、分享明文 token、完整生成指令。错误消息为按类别的固定脱敏字符串。
- `/health` 返回 `{ok:true}`；后台 worker（生成 / 交付 / 孤立产物回收）在启动日志中
  有 `[worker]` / `[delivery-worker]` / `[artifact-cleanup]` 标识，回收摘要形如
  `[artifact-cleanup] startup: scanned=N removed=N skipped=N errors=N`。

### 恰好一次投递（at-least-once + 需要外部协作才能真正恰好一次）

interface-agent 的"恰好一次"保证需要**外部协作**才能完全闭合。以下是诚实的现状：

| 环节 | interface-agent 的保证 | 仍需外部协作 |
|---|---|---|
| **M1 interface-launch 鉴权** | agent-pipeline 已移除宽松 CORS（同源默认）+ interface-launch 同源 Origin 校验（跨站 → 403） | agent-pipeline **无用户鉴权**（既有基线），**必须网络隔离**（仅可信内网可达）。用户鉴权层是路线图项。 |
| **M2 流水线通知持久性** | `interface_deliveries.notified_at`（迁移 005）：成功通知后立即设置（受守卫事务），崩溃重启后若 `notified_at` 已设则**不重发通知**，直接标记 delivered。interface-agent 保证**稳定幂等键** + **至少一次**。 | **下游流水线端点**（`PIPELINE_STAGE_COMPLETE_URL`）**必须按 `X-Idempotency-Key` 头做持久去重**，才能做到恰好一次。崩溃发生在 HTTP 本身期间 → 重发同一稳定键 → 下游去重。 |
| **M3 模型调用窗口** | `setStagedHtml` 是模型返回后的**第一条语句**（在验证/写入/提交之前），将崩溃重调窗口压到接近零。 | 模型返回与 staged_html 同步写之间的亚毫秒窗口崩溃**可能重调模型一次**（至少一次）。DeepSeek **无幂等键 / 可恢复流**，恰好一次需要模型侧幂等（路线图）。 |

### 部署后验证清单

部署完成后逐项验证：

1. **健康**：`curl -s http://220.154.5.91:18020/health` → `{ok:true}`。
2. **会话恢复**：打开同一 `projectname`，确认恢复到部署前的活跃会话与已确认版本
   （验证 SQLite 持久化生效）。
3. **版本预览**：在版本树里切换到任意历史版本，预览正常加载（验证 Blade OS 版本文件仍可读）。
4. **异步生成**：提交一次生成，返回 `202`；轮询 `GET .../generations/:id` 到 `succeeded`
   并自动选中新版本。
5. **交付重试**：确认一个版本 → 确认写入兼容路径 `共享/<projectname>/prototype.html` →
   流水线通知到达；若故意制造一次失败，"重新交付"能恢复到 `delivered`。
6. **分享撤销/过期**：创建分享 → 用链接预览正常 → 撤销后预览 404。

## 回滚（快速）

见上方「回滚演练」。要点：停当前容器 →（必要时）还原 SQLite 备份到卷 → 启动旧镜像 → 验证。

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
