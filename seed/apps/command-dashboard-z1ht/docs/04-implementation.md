# 实现文档

## 来源

| 字段 | 值 |
|---|---|
| Job | `job_e13161dc03bbd38803beb41d` |
| Step | `step_24e405a995585ef31f778ed2` |
| Attempt | 1 |
| Agent | `code-generator` |
| Artifact | `art_91b6c4c97e96d15f0429656c` |
| Checksum | `sha256:c6588f39b0fc4f4720708476f6aef6270501035dd59210626c5adce2e1fc2896` |

## 内容

### createdFiles

- generated-apps/command-dashboard-z1ht/.factory/app.json
- generated-apps/command-dashboard-z1ht/package.json
- generated-apps/command-dashboard-z1ht/vite.config.js
- generated-apps/command-dashboard-z1ht/index.html
- generated-apps/command-dashboard-z1ht/Dockerfile
- generated-apps/command-dashboard-z1ht/nginx.conf
- generated-apps/command-dashboard-z1ht/README.md
- generated-apps/command-dashboard-z1ht/src/main.jsx
- generated-apps/command-dashboard-z1ht/src/App.jsx
- generated-apps/command-dashboard-z1ht/src/styles.css
- generated-apps/command-dashboard-z1ht/src/constants.js
- generated-apps/command-dashboard-z1ht/src/utils/deckWind.js
- generated-apps/command-dashboard-z1ht/src/utils/timeFormat.js
- generated-apps/command-dashboard-z1ht/src/utils/seaArea.js
- generated-apps/command-dashboard-z1ht/src/data/ontologyClient.js
- generated-apps/command-dashboard-z1ht/src/data/windProvider.js
- generated-apps/command-dashboard-z1ht/src/data/carrierPositionProvider.js
- generated-apps/command-dashboard-z1ht/src/data/aisProvider.js
- generated-apps/command-dashboard-z1ht/src/data/assessmentProvider.js
- generated-apps/command-dashboard-z1ht/src/components/TopStatusBar.jsx
- generated-apps/command-dashboard-z1ht/src/components/AlertStrip.jsx
- generated-apps/command-dashboard-z1ht/src/components/MetricsRow.jsx
- generated-apps/command-dashboard-z1ht/src/components/CarrierMatrix.jsx
- generated-apps/command-dashboard-z1ht/src/components/RangeBar.jsx
- generated-apps/command-dashboard-z1ht/src/components/DataUnavailable.jsx
- generated-apps/command-dashboard-z1ht/src/components/DetailPanel.jsx

### needsUserInput

```json
false
```

### projectDir

generated-apps/command-dashboard-z1ht

### questions


### usedSkills

- /Users/ohrvo/idea/xian630/.claude/skills/software-factory-app/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/deck-wind-data-skill/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/carrier-affiliation-data-skill/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/defense-operations-ui/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/command-dashboard/SKILL.md
- /Users/ohrvo/idea/xian630/.claude/skills/maritime-alert-dashboard/SKILL.md

### warnings

- 本体 DaaS 凭证有效性未知（JWT exp 已过但此前实测曾成功）：应用运行时首取即校验，401/失败按用户确认的降级口径处理——内置公开常识默认活动区域代表点评估并显著标注「非当前位置」，位置时效列显示不可用，判定 dataQuality=stale，绝不伪造位置。凭证仅在部署侧 nginx.conf 注入，不进入前端源码/静态产物/README/日志。
- 本阶段无 shell/npm 工具，未在本地实际执行 npm install 与 vite build；已按工厂契约规避已知构建失败项：build 脚本纯 "vite build"（无 tsc）、Dockerfile 仅 COPY package.json + npm install（不引用 package-lock.json）、纯 JavaScript+JSX 无 tsconfig 类型门。
- 风场与本体请求均经 nginx 同源反代（/api/wind/ → api.open-meteo.com，/api/ontology/ → 本体 DaaS），proxy_pass 全部变量化 + resolver，容器 DNS 不可达时 nginx 可启动、请求失败呈现显式降级态；无外网部署环境将显示降级态而非伪造数据。
- Open-Meteo 计费口径：11 艘批量 1 次/周期 × 288 周期/天，远低于免费额度 10000 次/天；批量响应部分缺失时对缺失点逐点补齐（最坏 2+11 次请求/周期）。
- GFS 网格约 0.11°（约 11 km），航母尺度为区域近似评估，界面在详情面板标注格点坐标与「区域近似评估」；公开情报位置存在时效滞后，判定为当前位置时刻的近似评估（需求风险已确认接受）。
- 本体时间字段时区未声明：位置时效按部署环境本地时区解析（72h/7d 分级阈值为小时级粒度，可容忍时区偏差）；风场 validTime 请求固定 timezone=UTC 并严格按 UTC 解析展示。
- AIS 佐证（RawAISData 按 mmsi 小样本）为本体历史存档、观测时最新点滞后约十余天，仅在详情面板作时效佐证展示、不作位置真值、不参与判定；失败静默标注「未启用」。静态降级舰（无 mmsi）自动不启用 AIS 佐证。
- 静态在册清单（11 艘 CVN 的舰名/舷号/舰级/母港/默认活动区域代表点，公开常识）仅作为位置库不可用时的降级兜底配置，界面显著标注「默认区域·非当前位置」；本体可用时一律以本体真实返回为准。
- maritime-alert-dashboard skill 的 mock/演示数据条款与本次 dataPolicy=live_api 冲突，按诚实数据契约以真实取数优先执行；该 skill 的阈值可见、绿黄红+文本双信号、选中项计算解释、刷新倒计时等 UI 条款已遵循。
- 判定模型数学性质如实说明：W≥0 时 W+30≥30>20，「不满足」分级在物理上不可达，但四级分级口径按需求固定实现并展示；「满足（全向）/条件满足」取决于 |W−30| 与 20 的比较。

