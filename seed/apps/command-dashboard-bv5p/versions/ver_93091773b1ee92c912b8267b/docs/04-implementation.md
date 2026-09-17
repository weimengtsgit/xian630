# 实现文档

## 来源

| 字段 | 值 |
|---|---|
| Job | `job_aeee5b4d641d1340a66fce21` |
| Step | `step_362d0e55dbb07aa6a049b2df` |
| Attempt | 1 |
| Agent | `code-generator` |
| Artifact | `art_1dc24f906fbca41d33e1f590` |
| Checksum | `sha256:6a29c5045a6efdc4baa7c9e300d7a259197426d8956e6bed957b6b5d1cf9562a` |

## 内容

### createdFiles

- generated-apps/command-dashboard-bv5p/.factory/app.json
- generated-apps/command-dashboard-bv5p/package.json
- generated-apps/command-dashboard-bv5p/vite.config.js
- generated-apps/command-dashboard-bv5p/index.html
- generated-apps/command-dashboard-bv5p/Dockerfile
- generated-apps/command-dashboard-bv5p/nginx.conf
- generated-apps/command-dashboard-bv5p/README.md
- generated-apps/command-dashboard-bv5p/src/main.jsx
- generated-apps/command-dashboard-bv5p/src/App.jsx
- generated-apps/command-dashboard-bv5p/src/styles.css
- generated-apps/command-dashboard-bv5p/src/config/ports.js
- generated-apps/command-dashboard-bv5p/src/data/tideProvider.js
- generated-apps/command-dashboard-bv5p/src/data/jcgParser.js
- generated-apps/command-dashboard-bv5p/src/utils/time.js
- generated-apps/command-dashboard-bv5p/src/utils/windowCalc.js
- generated-apps/command-dashboard-bv5p/src/components/TopBar.jsx
- generated-apps/command-dashboard-bv5p/src/components/AlertStrip.jsx
- generated-apps/command-dashboard-bv5p/src/components/PortGrid.jsx
- generated-apps/command-dashboard-bv5p/src/components/PortCard.jsx
- generated-apps/command-dashboard-bv5p/src/components/DrillDown.jsx
- generated-apps/command-dashboard-bv5p/src/components/TideChart.jsx
- generated-apps/command-dashboard-bv5p/src/components/StatusFooter.jsx
- generated-apps/command-dashboard-bv5p/src/components/DegradedState.jsx

### needsUserInput

```json
false
```

### projectDir

generated-apps/command-dashboard-bv5p

### questions


### usedSkills

- /Users/ohrvo/idea/xian630/.claude/skills/software-factory-app/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/tide-data-skill/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/carrier-affiliation-data-skill/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/defense-operations-ui/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/command-dashboard/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/maritime-alert-dashboard/SKILL.md

### warnings

- 运行环境网络受限（与数据接入阶段探测结论一致，生成时实测复核）：NOAA api.tidesandcurrents.noaa.gov 从本环境不可达（web reader 网关错误），JCG TidePredCgi.cgi?area=1407 返回『input error.』，JCG 根页面可达（确认潮汐推算入口存在）。适配器严格按 tide-data-skill 已验证契约实现（NOAA datagetter product=predictions&datum=MLLW&interval=h&time_zone=lst_ldt；JCG 毎時潮高表 cm/平均海面基准，双锚定解析），上线后需真机复核四港真实响应与 JCG 页面结构；任一港失败该格呈现显式错误态（错误码+失败时间+手动重试），不伪造数据。
- 外部取数路径与数据接入 runtimeArchitecture 的『浏览器直连 NOAA（CORS *）』建议不同：按 software-factory-app skill 硬约束（外部 API 必须经 nginx 同源反向代理）实现 /api/noaa/ 与 /api/jcg/ 反代（变量 proxy_pass + 请求期 DNS 解析 + 显式 $is_args$args，避免容器 DNS 不可达时 nginx 启动崩溃），该架构同时解决 JCG 无 CORS 头的问题；vite dev server 配置了同构本地代理，vite build 完全离线。
- 四港泊位基准水深为公开资料整理缺省值（诺福克 12.2 / 圣迭戈 12.0 / 布雷默顿 12.2 / 横须贺 11.9 m，用户已在数据接入阶段确认沿用）：潮高判定阈值 = 12.8 − 水深 → 0.60/0.80/0.60/0.90 m（MLLW×3 / 平均海面×1，与各港潮高同基准直接比较）。参数集中于 src/config/ports.js 单一配置对象，校准只需改该文件；UI 判定口径卡透明展示参数与公式。
- 横须贺 72h 序列由 JCG 当日起 4 个日页（保证 ≥72h 覆盖）+ 尽力而为的昨日页（当前时刻插值支点冗余）拼合，按时间戳去重排序；任一必需日页失败或解析失败 → 该格 JCG_FETCH_PARTIAL / JCG_PARSE_FAILED 错误态并保留失败明细，不虚构数值。解析器含 (cm) 标记锚定与整时表头锚定双策略，页面结构变化时报解析错误。
- 布雷默顿采用 NOAA 普吉特湾预测站 9447130（西雅图）作为邻近工作源（本站 9446486 不发布 MLLW 逐时预测），卡片与 README 均已标注该替代关系。
- maritime-alert-dashboard skill 中『显式 mock 数据提供层 / 本地演示 tick』条款与本次 dataPolicy=live_api 及诚实数据契约冲突，按 live_api 口径执行（真实取数 + 显式错误/降级态）；该 skill 的状态语义（绿/红+图标+文字三重信号）、阈值可见性、刷新口径展示、下钻详情等布局要求已全部遵循。原型契约（hard_constraint）五区结构与六态（default/loading/error/empty/stale + no_window 空态）逐项落地，响应式断点 1080/820 按契约实现。

