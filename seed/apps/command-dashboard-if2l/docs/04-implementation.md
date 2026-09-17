# 实现文档

## 来源

| 字段 | 值 |
|---|---|
| Job | `job_9816164a145e8bba461b4693` |
| Step | `step_f9f62aa6817cc38faf766082` |
| Attempt | 1 |
| Agent | `code-generator` |
| Artifact | `art_267f1100bb9407f21840cca1` |
| Checksum | `sha256:f37ebf43622249233e209ecf283b4c7646e385f48be2ae4ec976ca7bab6f2d3d` |

## 内容

### createdFiles

- generated-apps/command-dashboard-if2l/.factory/app.json
- generated-apps/command-dashboard-if2l/.dockerignore
- generated-apps/command-dashboard-if2l/.gitignore
- generated-apps/command-dashboard-if2l/Dockerfile
- generated-apps/command-dashboard-if2l/README.md
- generated-apps/command-dashboard-if2l/index.html
- generated-apps/command-dashboard-if2l/nginx.conf
- generated-apps/command-dashboard-if2l/package.json
- generated-apps/command-dashboard-if2l/vite.config.js
- generated-apps/command-dashboard-if2l/src/App.jsx
- generated-apps/command-dashboard-if2l/src/main.jsx
- generated-apps/command-dashboard-if2l/src/styles.css
- generated-apps/command-dashboard-if2l/src/components/AlertStrip.jsx
- generated-apps/command-dashboard-if2l/src/components/ClusterList.jsx
- generated-apps/command-dashboard-if2l/src/components/DutySummary.jsx
- generated-apps/command-dashboard-if2l/src/components/FilterPanel.jsx
- generated-apps/command-dashboard-if2l/src/components/PollTimeline.jsx
- generated-apps/command-dashboard-if2l/src/components/ThresholdConfigModal.jsx
- generated-apps/command-dashboard-if2l/src/components/Toast.jsx
- generated-apps/command-dashboard-if2l/src/components/TopStatusBar.jsx
- generated-apps/command-dashboard-if2l/src/components/WorldMap.jsx
- generated-apps/command-dashboard-if2l/src/core/clusterEngine.js
- generated-apps/command-dashboard-if2l/src/core/dataSource.js
- generated-apps/command-dashboard-if2l/src/core/format.js
- generated-apps/command-dashboard-if2l/src/core/geo.js
- generated-apps/command-dashboard-if2l/src/core/random.js
- generated-apps/command-dashboard-if2l/src/core/similarity.js
- generated-apps/command-dashboard-if2l/src/data/demoDataset.js
- generated-apps/command-dashboard-if2l/src/data/keywords.js
- generated-apps/command-dashboard-if2l/src/data/seaAreas.js
- generated-apps/command-dashboard-if2l/src/data/worldOutline.js
- generated-apps/command-dashboard-if2l/src/hooks/useMonitor.js

### needsUserInput

```json
false
```

### projectDir

generated-apps/command-dashboard-if2l

### questions


### usedSkills

- /Users/ohrvo/idea/xian630/.claude/skills/software-factory-app/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/defense-operations-ui/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/command-dashboard/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/maritime-alert-dashboard/SKILL.md

### warnings

- 数据口径为用户确认的 mock_data：全链路使用本地确定性演示数据（种子 PRNG、可复现、零外网请求），顶栏徽标 / 地图水印 / 帖子卡片 / 统计面板均显著标注「演示数据」，未对 X（推特）/ Instagram 发起任何运行时请求。
- live 通道仅预留：数据接入阶段探测证实 X API v2 recent search（401，需付费层 Bearer Token）与 Instagram Graph API（OAuthException #200，需 Meta App + IG Business 鉴权）均无免鉴权公开通道；UI 顶栏 live 入口为禁用态，切换层以 DataSourceAdapter 抽象实现（XSearchAdapter / InstagramGraphAdapter 仅接口位，未配置凭证时诚实抛错，不回退演示数据、不伪装真实数据）。
- 地图底图为本地打包的简化示意世界轮廓（手工概化多边形 + 等距圆柱投影），界面已标注「示意底图 · 非真实地理渲染」；海区为 12 个内置主要海域格网，演示散点仅落于海域内；在线瓦片未使用，应用可完全离线运行。
- 15 分钟轮询由本地定时器驱动演示批次（初始 96 批次 / 近 24 小时剧本 + 运行期持续生成），并提供「演示加速 ×60」开关（15 分钟节奏以 15 秒真实间隔模拟）便于值守演示；不产生任何针对真实平台的自动化抓取流量。
- stale（数据过期）态为诚实触发（如会话挂起超过一个轮询周期），未做人工模拟；empty 态由筛选条件驱动、error 态由失败批次剧本驱动（Instagram 源超时，可重试恢复）。
- GPS 标签 / 图片 EXIF 双通道坐标为演示数据内置模拟提取结果，非真实 EXIF 解码；无坐标帖子保留在新帖流供人工研判，但不落点、不计入散点统计（避免散点造假）。
- 聚类严重度由账号数与相似度诚实推导（演示剧本事件 SC-B / SC-C 的复核状态为剧本预设：已确认 / 已排除），阈值（60min / 50km / ≥3 账号 / ≥0.6）界面可调并即时重算；南海同账号多发边界样本不满足账号阈值、不触发聚类。

