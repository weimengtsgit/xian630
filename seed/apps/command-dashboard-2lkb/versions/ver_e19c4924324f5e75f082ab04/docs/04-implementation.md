# 实现文档

## 来源

| 字段 | 值 |
|---|---|
| Job | `job_fbb24f666d6abd0d669bf9a2` |
| Step | `step_b5c93d04ef7f0f6569a66c82` |
| Attempt | 1 |
| Agent | `code-generator` |
| Artifact | `art_6bc63cefc0643c3b401f39a4` |
| Checksum | `sha256:bcf6e12958441434e9ffcc40ac7b9d2883cf20b4d457839780a2832dd7df090d` |

## 内容

### acknowledgedConstraints

- 1. 代码生成必须保留首页『顶部状态栏→告警条→指标总览→海域分组网格矩阵→下钻详情→状态反馈』主结构，不得改为营销式落地页
- 2. 告警阈值集中为常量 RATIO_YELLOW_THRESHOLD=0.70、RATIO_RED_THRESHOLD=0.50，判定顺序先红后黄，规则不得散落多处
- 3. 刷新周期固定 180 秒，顶栏常显倒计时，支持立即刷新与暂停自动刷新
- 4. 演示数据契约需预生成 ≥30 天历史序列支撑 30 天滑动平均基线，并包含数量锐减场景以保证黄/红状态可被验收演示触发
- 5. 演示口径标注全局可见（顶栏徽标+页脚声明），任何文案不得表述为真实 AIS 数据
- 6. 每个方格必须同时具备曲线+基线虚线+比率+图标与中文状态标签
- 7. 下钻详情为必选组件（至少一个选中项的详情展开），含 30 天走势、阈值标尺与状态时间线
- 8. 响应式断点按 responsiveRules 执行
- 9. ≥1440px 桌面：网格矩阵主区 + 右侧下钻详情栏（约 340px）双栏，矩阵 4 列
- 10. 1024–1439px：双栏保留，下钻栏收窄，矩阵 3 列
- 11. 768–1023px 平板：单栏，矩阵 2 列，下钻详情在选中格下方展开，sparkline 保留
- 12. <768px 手机：单列堆叠，方格改紧凑行卡（编号+数量+比率+状态徽标+可展开曲线），顶部状态栏精简两行
- 13. sparkline 最小高度 40px；状态区分带图标与中文标签，不以颜色为唯一通道；数字列用等宽数字对齐

### createdFiles

- generated-apps/command-dashboard-2lkb/.factory/app.json
- generated-apps/command-dashboard-2lkb/package.json
- generated-apps/command-dashboard-2lkb/vite.config.js
- generated-apps/command-dashboard-2lkb/index.html
- generated-apps/command-dashboard-2lkb/Dockerfile
- generated-apps/command-dashboard-2lkb/.dockerignore
- generated-apps/command-dashboard-2lkb/nginx.conf
- generated-apps/command-dashboard-2lkb/README.md
- generated-apps/command-dashboard-2lkb/src/main.jsx
- generated-apps/command-dashboard-2lkb/src/App.jsx
- generated-apps/command-dashboard-2lkb/src/styles.css
- generated-apps/command-dashboard-2lkb/src/constants.js
- generated-apps/command-dashboard-2lkb/src/utils/prng.js
- generated-apps/command-dashboard-2lkb/src/utils/alertRule.js
- generated-apps/command-dashboard-2lkb/src/utils/seriesGen.js
- generated-apps/command-dashboard-2lkb/src/utils/snapshot.js
- generated-apps/command-dashboard-2lkb/src/utils/format.js
- generated-apps/command-dashboard-2lkb/src/data/gridConfig.js
- generated-apps/command-dashboard-2lkb/src/hooks/useDemoFeed.js
- generated-apps/command-dashboard-2lkb/src/hooks/useMediaQuery.js
- generated-apps/command-dashboard-2lkb/src/hooks/useElementWidth.js
- generated-apps/command-dashboard-2lkb/src/components/TopStatusBar.jsx
- generated-apps/command-dashboard-2lkb/src/components/AlertStrip.jsx
- generated-apps/command-dashboard-2lkb/src/components/MetricsOverview.jsx
- generated-apps/command-dashboard-2lkb/src/components/SeaAreaTabs.jsx
- generated-apps/command-dashboard-2lkb/src/components/GridMatrix.jsx
- generated-apps/command-dashboard-2lkb/src/components/GridCell.jsx
- generated-apps/command-dashboard-2lkb/src/components/Sparkline.jsx
- generated-apps/command-dashboard-2lkb/src/components/TrendChart.jsx
- generated-apps/command-dashboard-2lkb/src/components/ThresholdRuler.jsx
- generated-apps/command-dashboard-2lkb/src/components/DrillDown.jsx
- generated-apps/command-dashboard-2lkb/src/components/StateFeedbackBar.jsx
- generated-apps/command-dashboard-2lkb/src/components/StatusBadge.jsx

### needsUserInput

```json
false
```

### projectDir

generated-apps/command-dashboard-2lkb

### questions


### usedSkills

- /Users/ohrvo/idea/xian630/.claude/skills/software-factory-app/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/defense-operations-ui/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/command-dashboard/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/maritime-alert-dashboard/SKILL.md

### warnings

- 原型契约文件 prototype-contract.json 内部标记为 prototypeStatus=unconfirmed_reference / downstreamConstraintLevel=reference，与任务指令声明的 prototypeStatus=confirmed / downstreamConstraintLevel=hard_constraint 不一致；本阶段按任务指令的 13 条硬约束逐条执行（未降低任何约束）。
- 演示序列未落盘为静态 JSON 文件，采用数据接入契约明确允许的替代方式：种子化确定性 PRNG（mulberry32）+ 生成器置于 src/utils/seriesGen.js，运行时确定性求值；等效满足『预生成 ≥30 天历史（720 小时点/格）+ 近 24h 480 点 + 预置锐减场景』要求，且任意时刻取值全网可复现。src/data/ 仅含静态网格配置，无 Math.sin/Math.cos/Math.random（已 grep 验证）。
- 图表调色板与图表规范直接采用已确认原型契约 chartSpec 固定值（深色表面 #0d0d0d、系列线 #3987e5、基线 #898781 虚线、状态三色均配 ●/▲/■ 图标与中文标签，契约已声明对比度 ≥3:1）；生成环境无 node 运行时，未重新运行 dataviz 调色板校验脚本。
- 真实 AIS 商船位置数据流接入不在本期范围（用户在需求确认阶段明确选择 dataPolicy=mock_data；数据接入探测结论：目标四海域无免费真实源覆盖，实时 AIS 均为付费密钥源）。应用不发起任何外部网络请求（已 grep 验证无 fetch/外部 URL）。

