# 本地部署启动文档（固定 4 会话 + 智能体研判广场）

面向**全新本地环境**的一键拉起手册。核心承诺：任何一台新机器按本文档启动后，
门户固定出现 **4 个客户场景会话**，智能体研判广场固定可见 **4 个客户场景应用**
（容器真实运行在 18000-18003）；用户在本环境内新增的会话、创建的智能体**只在
本地数据库里存活**——换一台全新环境重新启动，永远回到这 4 个会话的初始状态。

深入细节（架构图、SSE 事件、环境变量总表、观测端点）见
[software-factory-local-runbook.md](software-factory-local-runbook.md)。

## 0. 终态定义

启动完成后的固定状态：

| 内容 | 数量 | 来源 |
|---|---|---|
| 会话（dialogue sessions） | 4 | `seed/state.db` 种子快照 |
| 门户应用列表 | 5 预置 + 4 生成 | `scene/` 目录扫描 + 种子 |
| 智能体研判广场卡片 | 4 运行时卡 | 恢复容器时由部署注册链路自动生成（`api-apps.json` 为本地文件，不入库） |
| 运行中应用容器 | 4（18000-18003） | `seed/apps/` 源码重建 |
| 流水线智能体（agents 表） | 6 | factory-server 启动时自动 upsert |

4 个会话 ↔ 4 个应用 ↔ 端口的固定映射（按此顺序恢复即得此端口）：

| 会话（客户场景） | 应用 | 容器端口 |
|---|---|---|
| 航母母港潮汐出港窗口 | `command-dashboard-bv5p` | 18003 |
| 航母甲板风起降条件 | `command-dashboard-z1ht` | 18001 |
| 海域商船密度网格告警 | `command-dashboard-2lkb` | 18000 |
| 社媒舰船目击监测 | `command-dashboard-if2l` | 18002 |

## 1. 前置依赖

- Go 1.26+、Node 20+ 与 npm
- **podman**（rootless machine 已启动：`podman machine start`）——应用容器构建/运行必需
- **claude CLI** 已安装且可认证——浏览 4 个种子会话**不需要**它；但「新增会话 /
  需求澄清 / 生成新应用」的路由与澄清链路**永远走真实 claude CLI**（与 fake 模式无关）
- 约 2.2 MB 种子数据库 + 4 个应用源码已随仓库携带（`seed/`）

## 2. 启动前必须回答：代码生成智能体用什么模型？

> 这是启动流程的固定决策点（写启动 skill 时在此提问用户）。在启动
> factory-server **之前**确定，因为模型网关变量由 factory-server 进程环境
> 继承给 claude 子进程，进程起完后改环境变量无效。

代码生成智能体实际是 factory-server 拉起的 `claude --print … --model <模型>`
子进程（工具白名单 Read/Grep/Glob/Edit/Write，禁 Bash）。三个选项：

| 选项 | 做法 | 适用 |
|---|---|---|
| A. 真实模型网关 | `export ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… ANTHROPIC_MODEL=…` | 真生成新应用（推荐演示用） |
| B. 确定性假执行 | `export FACTORY_FAKE_CLAUDE=1` | 无任何 key 也能跑通六步流水线 |
| C. 本机 claude CLI 默认 | 什么都不设 | CLI 已官方登录时 |

要点：

- 模型名优先级：`CLAUDE_CODE_MODEL` > `ANTHROPIC_MODEL`（claude.go:109）。
- `FACTORY_FAKE_CLAUDE=1` **只**替换流水线三步（需求分析/方案设计/代码生成）
  为确定性假执行；对话路由、需求澄清、业务智能体起草**不受它影响，永远真实**。
  所以即使选 B，新会话仍需可用的 claude CLI/网关。
- 网关 profile 落盘为 `deploy/gateways/local-<名字>.env`（三行 export 即可），
  启动前 `set -a; source deploy/gateways/local-<名字>.env; set +a`。
  **文件名必须带 `local-` 前缀**——只有该前缀被 .gitignore 排除，其他名字的
  `.env` 会被 `git add -A` 把真实 key 提交进仓库。
  仓库现存的 `anthropic.env / cc580.env / volc-ark.env` 的 key 均已失效，仅作
  格式参考；`fake.env` 等价于选项 B，仍然可用。

profile 模板：

```bash
# deploy/gateways/local-my-gateway.env
export ANTHROPIC_BASE_URL="https://<网关地址>"
export ANTHROPIC_AUTH_TOKEN="<新 key>"
export ANTHROPIC_MODEL="<模型名>"
```

## 3. 种子恢复（仅全新环境或显式重置时执行）

种子资产已提交在仓库 `seed/` 下：`seed/state.db`（4 会话/8 消息/4 任务/
666 条工作轨迹/9 应用/4 部署记录/6 智能体，0 凭证残留，路径全部是相对路径，
跨机器可移植）与 `seed/apps/`（4 个应用完整源码）。

在仓库根执行（两条命令都是**幂等**的：目标已存在则跳过，绝不覆盖本地数据）：

```bash
# 3.1 本地数据库：不存在才拷种子
[ -f ~/.software-factory/state.db ] || mkdir -p ~/.software-factory && cp seed/state.db ~/.software-factory/state.db

# 3.2 应用源码：generated-apps/ 不入库，从种子补齐缺失目录
for s in 2lkb bv5p if2l z1ht; do
  [ -d "generated-apps/command-dashboard-$s" ] || cp -R "seed/apps/command-dashboard-$s" generated-apps/
done
```

**显式重置**（丢弃本环境所有新增会话/智能体，回到 4 会话初始态）：

```bash
rm -f ~/.software-factory/state.db ~/.software-factory/state.db-wal ~/.software-factory/state.db-shm
rm -f agent-square/runtime-data/api-apps.json             # 广场卡由 4.4 恢复容器时自动重建为 4 张
podman rm -f $(podman ps -aq --filter name=sf-command-dashboard) 2>/dev/null   # 旧容器占着 18000-18003
lsof -ti :8787 | xargs kill                                # factory-server 需重启使新种子生效
# 等端口释放后重跑 3.1 / 3.2，再按第 4 节顺序重新起服务与容器
```

## 4. 启动顺序

以下命令均假设仓库根为当前目录。五个组件按序启动：

### 4.1 factory-server（编排核心，:8787）——必须第一个起

```bash
cd factory-server && make build

# 先确定第 2 节的模型选择，例如：
set -a; source ../deploy/gateways/<profile>.env; set +a    # 或 export FACTORY_FAKE_CLAUDE=1

FACTORY_WORKSPACE_ROOT=.. \
FACTORY_APP_SQUARE_URL=http://127.0.0.1:5173 \
./bin/factory-server
```

- `FACTORY_WORKSPACE_ROOT=..`（仓库根）必需——应用路径 `generated-apps/<slug>`
  以它解析；`scene/` 预置应用扫描也依赖它。
- `FACTORY_APP_SQUARE_URL` 指向广场 dev 端口，部署成功后自动把卡片 upsert 进
  广场；留空则关闭自动上架。
- 数据库默认 `~/.software-factory/state.db`（第 3 节已就位）。

### 4.2 agent-square（智能体研判广场，:5173）

```bash
cd agent-square && npm install && npm run dev
```

广场的运行时卡片来自本地 `/api/apps`（vite middleware 读写
`runtime-data/api-apps.json`）。该文件**不入库**（已 ignore）：全新环境克隆后
它不存在、广场运行时卡为空，属预期——4 张卡由 4.4 节恢复容器时的部署注册
链路自动重建。

### 4.3 sf-portal-mvp（门户，:3001）

```bash
cd sf-portal-mvp && npm install && npm run dev
```

打开 `http://localhost:3001`，左侧「智能体广场」入口指向 :5173。

### 4.4 恢复 4 个应用容器（18000-18003）

factory-server 与广场都在跑之后，**严格按此顺序**逐个 start（顺序即端口映射，
见第 0 节表；顺序错了端口会换，广场卡片链接仍会自动对齐实际端口）：

```bash
for id in 2lkb z1ht if2l bv5p; do
  curl -s -X POST "http://127.0.0.1:8787/api/apps/app-command-dashboard-$id/start" && echo
done
```

每个应用的首次 start 会执行 `npm install` + vite 构建 + `podman build`，分钟级，
属正常；之后重启是秒级（部署记录探活命中即直接返回）。

### 4.5 可选组件

```bash
# 智能体流水线页（agent-pipeline，Express 静态服务）。
# 注意用 18000-18999 之外的端口（应用端口池占用中），见第 7 节边界②：
cd agent-pipeline && npm install && npm run build && PORT=19002 npm start

# cc-status（claude 会话观测，:8765）——只影响观测数据，不影响主流程：
cd cc-status && make build && ./bin/cc-status serve
```

## 5. 验收清单

全部组件起来后逐项确认：

```bash
curl -s http://127.0.0.1:8787/healthz                        # {"ok":true}
curl -s http://127.0.0.1:8787/api/dialogues                  # 恰好 4 个会话
curl -s http://127.0.0.1:8787/api/apps                       # 5 预置 + 4 生成
curl -s http://127.0.0.1:5173/api/apps                       # 4 张运行时卡（link 已对齐实际端口）
for p in 18000 18001 18002 18003; do curl -s -o /dev/null -w "$p:%{http_code}\n" "http://127.0.0.1:$p/"; done   # 均 200
```

浏览器打开 `http://localhost:3001`：会话列表 4 条；「智能体广场」4 张客户场景
卡可点进对应应用。

## 6. 为什么「换全新环境永远只有 4 个会话」

不变量由三个约定共同保证：

1. **可变状态只有一个文件**：`~/.software-factory/state.db`（应用容器与
   `generated-apps/` 是可重建产物）。用户新增会话、创建智能体、生成的应用
   全部落在这个本地库里/本地目录下，**永不回写仓库**。
2. **仓库种子是只读快照**：`seed/state.db` 固定为 4 会话终态，恢复只在本地库
   不存在时拷贝一次（幂等跳过，见第 3 节）。
3. **全新环境 = 全新 `~/.software-factory`**：新机器上该文件不存在 → 拷种子 →
   回到 4 会话。同环境重启服务（不删库）则完整保留用户新增。

## 7. 已知边界与排查

1. **广场顶部另有 2 张内置演示卡**（航母态势指挥仪表盘、潮汐出港窗口计算器），
   链接指向 91 生产主机（构建期 `VITE_DEMO_APP_HOST` 默认值），本地打不开属
   预期；本地的 4 张运行时卡不受影响。
2. **门户「智能体流水线」入口链接写死 `http://127.0.0.1:18002/`**，而 18002 落在
   应用端口池 18000-18999 内——4 应用恢复后该端口被 `command-dashboard-if2l`
   容器占用，此入口会打开那个应用而不是流水线页。本地看流水线请用池外端口
   （如 19002）直开。
3. **首次恢复慢**：每个应用首次 start 要 npm install + podman build（分钟级）。
   确认 `podman machine start` 已执行，否则 image_build/deployment 必失败。
4. **端口漂移**：若本机 18000-18003 已被其他服务占用，start 会顺序后移取空闲
   端口，广场卡片链接自动对齐实际端口，门户内应用地址亦然——功能不受影响，
   但端口号与本文档表格不同。
5. **portal 中途刷新回空**：既有 MVP 限制，会话与轨迹都在服务端持久化，继续
   对话即可恢复上下文。
6. **新会话失败/无响应**：路由与澄清永远走真实 claude CLI——检查 `claude` 在
   PATH、网关变量已 export 给 factory-server 进程、key 有效。fake 模式救不了
   这条链路。
7. **Node HTTPS 全量报证书错误**（个别机器的 TLS 校验问题）：本地联调可临时
   `export NODE_TLS_REJECT_UNAUTHORIZED=0`，仅限本地开发。
8. **重置后容器仍在跑**：第 3 节重置只清数据库；旧容器用
   `podman ps` / `podman rm -f sf-command-dashboard-*` 清理后再重新 start。
9. **提交隔离**：新增会话/智能体/应用/广场卡**都不会进 git**——DB 在家目录、
   `generated-apps/` 与 `agent-square/runtime-data/api-apps.json`（广场运行时
   注册表，本地由部署注册链路重建）均被 ignore。唯一例外：新建模型网关 profile
   必须用 `local-` 前缀（`deploy/gateways/local-*.env` 已被 ignore），其他名字的
   `.env` 不受 ignore 保护，`git add -A` 会把真实 key 提交进仓库。
10. **广场卡的注册时机**：卡片只在应用**重建部署**成功时写入（探活快速路径不
   重复注册）。若容器都在跑而 `api-apps.json` 被手动删除，广场会暂时为空，重新
   start 任一应用（或等下次重建）即恢复。
