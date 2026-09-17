---
name: deploy-112
description: Use when publishing the current xian630 revision to 10.253.28.112, upgrading its factory-server, sf-portal-mvp, and agent-square containers, or verifying/rolling back that deployment. Do not use for local startup or unrelated bootstrap/Kubernetes services.
---

# 发布到 112（factory-server + 门户 + 智能体广场）

目标：将当前**已提交**的 xian630 版本安全发布到 `root@10.253.28.112:22` 的既有三项服务：

- `factory-server`：仅容器网络内 `8787`；
- `sf-portal-mvp`：宿主机 `18083`；
- `agent-square`：宿主机 `18016`。

该主机是集群 bootstrap 节点。只处理上述 xian630 容器与 `/opt/xian630`，不得更新、重启或清理
`bootkube`、`release-image`、CRI-O、OpenHands、CDP MCP 等无关系统/容器。

## 前置边界

- 发布是外部写操作：仅在用户明确要求部署/更新 112 后执行；只要求盘点或诊断时不得切换容器。
- 不将本地的 `deploy/gateways/local-*.env`、API Key、Claude 配置或其他密钥复制到远端。若用户明确要求修改远端模型网关，单独确认目标模型和凭据持久化位置。
- 发布版本必须来自当前 Git HEAD。先检查 `git status --short`；存在无关改动时保留它们，使用 `git archive HEAD` 传输已提交内容。
- 远端 GitHub 可能无法连通，不能假定可 `git pull`。需要先做 `git ls-remote`；失败时从本地经 SSH 传输 archive 到新的 `/opt/xian630/releases/<VERSION>/source/`。
- 远端可能输出 CNI 配置警告；只要容器实际启动且 HTTP 验收通过，单独记录即可，不能据此清理网络配置。

## 1. 只读盘点

登录后先确认以下事实，再决定准确命令：

```bash
podman ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
podman inspect <当前-factory> <当前-portal> <当前-agent-square>
curl -fsS http://127.0.0.1:18083/healthz
curl -fsS http://127.0.0.1:18016/health
df -h /var/lib/containers
```

识别当前三项正式容器、镜像、端口、网络、数据卷、非敏感环境变量和代理关系。不得把 inspect 的完整环境变量或备份内容输出到会话，因为可能含密钥或代理凭据。

现网已验证的重要事实（每次仍须复核）：

- factory 挂载 `sf-new-data:/data`、`sf-new-apps:/workspace/generated-apps`、`sf-new-claude:/root/.claude` 与 `/run/podman/podman.sock:/var/run/runtime.sock`；这些卷必须原样保留。
- agent-square 挂载 `/opt/xian630/apps/agent-square/data:/var/cache/nginx/appstore:Z`；该目录保存运行时卡片，不能覆盖或清空。
- 默认 `podman` 网络不保证容器 DNS 可用。门户需在启动时设置 `FACTORY_UPSTREAM=<新 factory IP>:8787`，不能沿用旧 factory 的 IP，也不能直接假设 `factory` 名称可解析。
- `cc-status` 在该主机未必部署；只更新实际存在的 xian630 服务，未经用户要求不得新增它。

## 2. 构建新版本，不中断线上

版本建议为 `$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)`，在远端创建独立的
`/opt/xian630/releases/<VERSION>/`。先构建和临时验证，禁止先停旧容器。

优先在远端以版本化 tag 正常构建 factory、portal、agent-square 镜像。若基础镜像仓库不可达：

1. 在本机对 portal 与 agent-square 执行构建，对 factory-server 执行 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build`；
2. 将二进制、两个 `dist/` 和当前源码传到该 release 目录；
3. 以当前运行的对应版本镜像为 `FROM` 创建派生镜像，仅替换后端二进制、静态资源与 nginx/njs 配置；
4. 记录此离线构建方式，保留版本化 tag；不得用 `latest` 作为回滚锚点。

临时端口验证新 factory、portal 和 agent-square：

- factory 的 `/healthz` 返回 `{"ok":true}`；
- portal 的 `/` 和 `/healthz` 正常；可在验证容器中将 `FACTORY_UPSTREAM` 指向仍在运行的旧 factory IP；
- agent-square 的 `/health` 返回 200，`/api/apps` 可读；
- 验证容器不得写入正式 factory 数据卷。

## 3. 切换（最小停机）

先备份旧容器 inspect 和镜像/版本信息到 `/opt/xian630/backups/<VERSION>-predeploy/`，权限设为仅 root 可读。旧容器只停止、不删除。

严格使用现场盘点得出的卷、端口和安全环境变量；把需要复用的 factory 环境写到仅 root 可读的 release runtime 文件，避免在终端打印值。切换顺序：

1. 停旧 agent-square，启动新 agent-square（仍使用原 runtime-data 挂载），取得其新容器 IP；
2. 在 factory 的运行环境中设置 `FACTORY_APP_SQUARE_URL=http://<新 agent IP>`；
3. 停旧 factory-server，启动新 factory-server（复用全部数据卷与运行时 socket），取得新 IP；
4. 停旧门户，以 `FACTORY_UPSTREAM=<新 factory IP>:8787` 启动新门户到 `18083:80`；
5. 在 `/opt/xian630/active/VERSION` 写入新版本。

若启动参数与主机 Podman 能力冲突（例如 `host-gateway` 映射不支持），不得反复猜测。先对照旧容器 inspect，去除旧容器也不存在的参数，然后立即恢复后端与门户链路。

## 4. 验收、回滚与汇报

至少验证：

```bash
curl -fsS http://127.0.0.1:18083/healthz
curl -fsS http://127.0.0.1:18083/api/dialogues
curl -fsS http://127.0.0.1:18083/api/apps
curl -fsS http://127.0.0.1:18016/health
curl -fsS http://127.0.0.1:18016/api/apps
```

并从部署端确认 `http://10.253.28.112:18083/` 返回 200，检查三个新容器均为 running，查看最新日志是否有 fatal/panic/nginx emerg。

验收失败时，停止新容器并启动备份的旧 factory、portal、agent-square；恢复后再报告原因。不得删除旧容器、数据卷或 release 目录。

最终报告版本、三个容器/端口、关键验收结果、保留的回滚容器和任何未处理限制。当前会话数、应用数和广场卡数是运行时数据，报告实测值而不是假定固定值。
