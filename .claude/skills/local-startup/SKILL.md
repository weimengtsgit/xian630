---
name: local-startup
description: Use when 需要在本地（尤其全新环境）启动智能软件工厂演示环境、恢复 4 个固定会话与智能体研判广场、重启本地服务、重置回初始 4 会话状态、或启动前选择代码生成智能体的模型网关时。触发词：本地启动、全新环境拉起、恢复会话、启动广场、重置演示环境。
---

# 本地启动（固定 4 会话 + 智能体研判广场）

## 概览

目标终态：门户恰好 **4 个客户场景会话**、广场 **4 张运行时卡片**、4 个应用容器跑在
**18000-18003**、factory-server :8787 / 广场 :5173 / 门户 :3001。整个流程**幂等**，
重复执行不破坏已有状态。权威细节（端口映射表、边界、原理）见
[docs/local-deployment-startup.md](../../../docs/local-deployment-startup.md)——执行本
skill 前先读它。

## 启动流程

### 1. 前置检查

- 工作目录必须是仓库根（`seed/`、`factory-server/` 所在目录）。
- `podman machine inspect --format '{{.State}}'`，非 `running` 则先 `podman machine start`
  并等就绪——否则后续 image_build/deployment 必失败。

### 2. 提问用户：代码生成智能体用什么模型（必须问，不可跳过）

用 AskUserQuestion 给出三个选项：

- **A. 真实模型网关**：向用户要 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_MODEL` 三件套。若用户同意落盘，写到
  `deploy/gateways/local-<名字>.env`（**必须带 `local-` 前缀**——已被 .gitignore
  排除，key 不会进仓库；不要用其他名字，现有 4 个 profile 是提交进 git 的，key 已失效）。
- **B. 确定性假执行**：`FACTORY_FAKE_CLAUDE=1`，无需任何 key，六步流水线可跑通。
- **C. claude CLI 默认**：什么都不设，本机 CLI 已官方登录时可用。

告知边界：fake 只影响流水线三步（需求分析/方案设计/代码生成）；**对话路由、需求澄清
永远走真实 claude CLI**——浏览 4 个种子会话不需要模型，但「新增会话/生成新应用」
必须有可用网关或已登录 CLI。

### 3. 种子恢复（幂等，直接执行不要问）

```bash
[ -f ~/.software-factory/state.db ] || mkdir -p ~/.software-factory && cp seed/state.db ~/.software-factory/state.db
for s in 2lkb bv5p if2l z1ht; do
  [ -d "generated-apps/command-dashboard-$s" ] || cp -R "seed/apps/command-dashboard-$s" generated-apps/
done
```

### 4. 起服务（幂等：先探测端口，已监听则跳过该服务并向用户报告「已在运行」）

**factory-server 已在运行时的模型选项冲突**：网关变量在进程启动时注入，事后改环境
无效。若用户本次选了 A（新网关）或 B（fake）而 :8787 已被占用，**必须告知用户
「所选模型需重启 factory-server 才生效」并询问是否重启**；确认后
`lsof -ti :8787 | xargs kill`，等端口释放再按所选 env 重新拉起。选 C 且已在运行则
无需处理。

```bash
# factory-server :8787（网关 env 按第 2 步选择注入进程环境）
cd factory-server && make build          # bin/factory-server 已存在可跳过；源码有新提交时应重新构建
set -a; source ../deploy/gateways/local-<名字>.env; set +a   # 选项 A；选项 B 改为 export FACTORY_FAKE_CLAUDE=1
FACTORY_WORKSPACE_ROOT=.. FACTORY_APP_SQUARE_URL=http://127.0.0.1:5173 ./bin/factory-server &

# 广场 :5173
cd agent-square && npm install && npm run dev &

# 门户 :3001
cd sf-portal-mvp && npm install && npm run dev &
```

`FACTORY_WORKSPACE_ROOT`（仓库根）与 `FACTORY_APP_SQUARE_URL` 两个变量缺一不可：
前者决定 `generated-apps/` 与 `scene/` 解析，后者决定部署后自动刷新广场卡。

### 5. 恢复 4 个应用容器（顺序即端口映射，不可乱序）

```bash
for id in 2lkb z1ht if2l bv5p; do
  curl -s -X POST "http://127.0.0.1:8787/api/apps/app-command-dashboard-$id/start" && echo
done
```

首次 start 每个应用要 npm install + vite 构建 + podman build，**分钟级**，逐个等
返回再继续（for 循环天然串行）；再次启动秒级（探活快速路径）。每次成功重建都会
自动把该应用的卡写进广场（本地文件，按 id 幂等 upsert）——全新环境下广场的
4 张卡就是这一步生成的。

### 6. 验收并汇报

```bash
curl -s http://127.0.0.1:8787/healthz                                  # {"ok":true}
curl -s http://127.0.0.1:8787/api/dialogues                            # 恰 4 个
curl -s http://127.0.0.1:8787/api/apps                                 # 9 个（5 预置 + 4 生成）
curl -s http://127.0.0.1:5173/api/apps                                 # 4 张运行时卡
for p in 18000 18001 18002 18003; do curl -s -o /dev/null -w "$p:%{http_code}\n" http://127.0.0.1:$p/; done
```

向用户汇报：入口 `http://localhost:3001`、各端口状态、所选模型选项。

### 7. 收尾提醒（必须告知用户）

本环境新增的会话/智能体/应用/广场卡**都不会进 git**：DB 在家目录，
`generated-apps/` 与 `agent-square/runtime-data/api-apps.json` 均被 ignore
（广场卡是本地运行时文件，由部署注册链路重建，不入库）。唯一要注意：新网关
profile 必须用 `local-` 前缀（已 ignore）；否则 key 会被 `git add -A` 带走。

## 重置子流程（用户说「重置 / 回到初始 4 会话」时）

```bash
rm -f ~/.software-factory/state.db ~/.software-factory/state.db-wal ~/.software-factory/state.db-shm
rm -f agent-square/runtime-data/api-apps.json             # 广场卡在第 5 步恢复容器时自动重建为 4 张
podman rm -f $(podman ps -aq --filter name=sf-command-dashboard) 2>/dev/null   # 否则旧容器占着 18000-18003
lsof -ti :8787 | xargs kill                                # 重启 factory-server 使新种子生效
# 等端口释放后重跑第 3、4、5 步（从第 4 步起重新起服务）
```

## Common Mistakes

| 错误 | 后果 |
|---|---|
| 容器恢复乱序 | 端口映射与文档表格不一致（功能仍可用，卡片自动对齐，但汇报时端口对不上） |
| 漏 `FACTORY_WORKSPACE_ROOT` | 应用路径解析失败，start 报 not found / 构建失败 |
| 漏 `FACTORY_APP_SQUARE_URL` | 部署成功但广场卡不刷新 |
| 选了 fake 就以为新会话也能用 | 对话路由永远真实 CLI，新会话会失败——应告知用户选 A/C |
| 重置后不删旧容器 | 旧容器占着 18000-18003，新 start 被迫换端口 |
| 全新环境不起容器就开广场 | 运行时卡为空属预期——4 张卡由第 5 步恢复容器时自动注册生成 |
