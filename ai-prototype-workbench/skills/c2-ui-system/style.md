# C2 UI System — 军事指挥态势感知设计系统

界面生成必须遵循 C2 UI System：军事指挥 / 态势感知（Command & Control）深色设计语言。令牌驱动、单文件自包含、CSS-only 交互、图标全内联 SVG。

## 设计令牌（必须用这些值，定义为 `:root` CSS 变量后引用）

- 背景四层（靠亮度差建立层级，不靠粗描边）：`--bg-base #0a0e14`（最底/应用背景）/ `--bg-panel #111823`（栏、卡容器）/ `--bg-elevated #18212e`（卡内区块、选中态底）/ `--bg-inset #0c1119`（输入框、时间轴槽）
- 描边（低饱和冷灰蓝，靠透明度分级）：subtle `rgba(120,150,180,.10)` / default `rgba(130,160,190,.16)` / strong `rgba(140,170,200,.30)`
- 品牌强调（唯一辉光色，仅用于选中态与地图/点位类）：`--accent-cyan #38b6e6` / bright `#63d2f7` / dim `rgba(56,182,230,.14)`；辉光 `0 0 0 1px rgba(56,182,230,.45), 0 0 16px rgba(56,182,230,.28)`
- 文字四级灰阶：primary `#e8eef5` / secondary `#9fb2c6` / muted `#647689` / disabled `#44546a`
- 语义状态（各配 `rgba(...,.13)` 底色）：critical `#e5484d` / approve `#3fbd6b` / warning `#e0a339` / info `#4a90d9`
- 评分色阶：low `#3fbd6b` / med `#e0a339` / high `#e5484d`
- 密级：UNCLASSIFIED `#4a9e57`（CONFIDENTIAL `#2f6fb0` 蓝 / SECRET `#c8543a` 红）
- 字体：sans `"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif`；mono `"Cascadia Code","Consolas",ui-monospace,"SFMono-Regular",Menlo,monospace`（数据用 mono + `font-variant-numeric: tabular-nums` 对齐）
- 字号：xs 11 / sm 12 / base 13 / md 14 / lg 16 / xl 20 / 2xl 24
- 间距（4px 基数）：4 / 8 / 12 / 16 / 20 / 24 / 32
- 圆角：sm 3 / md 5 / lg 8 / pill 999
- 效果：focus-ring `0 0 0 2px var(--bg-base), 0 0 0 4px rgba(56,182,230,.55)`；shadow-panel `0 8px 24px rgba(0,0,0,.45)`
- 底图：极淡青蓝网格 40px×40px（`rgba(56,182,230,.020)` 双向 linear-gradient）营造战术底图氛围

## 组件目录（用 `c2-*` 类名，自包含实现 CSS）

- `c2-clsf-banner`：顶部密级横幅（高 22、大写字母间距 3、UNCLASSIFIED 绿底 + 两侧圆点）
- `c2-topbar` / `c2-toolbar` / `c2-iconbtn` / `c2-search`：应用顶栏 + 工具条 + 图标按钮（30×30，hover 抬升底，选中态青蓝底）/ 搜索框（inset 底 + kbd 提示）
- `c2-tabs`：分段标签页（CSS-only radio 驱动，选中青蓝底 + 内描边）
- `c2-panel` / `c2-panel-head` / `c2-panel-body`：面板卡容器（头部分隔线 + 青蓝渐变 + 阴影）
- `c2-badge`（critical/warning/info/approve）· `c2-chip` · `c2-tag-feasible` · `c2-score`（low/med/high，色块底深字）：徽章 / 芯片 / 可行标 / 评分
- `c2-situation`：态势卡（左侧 3px 色条表严重度，critical 默认）
- `c2-collapse`：可折叠分节（原生 `<details>`，chevron 旋转 + 右侧 count）
- `c2-plan`：方案列表项（hover 描边强化，`.is-selected` 青蓝辉光）
- `c2-approval` / `c2-btn`（primary/approve/reject/ghost/disabled）：审批操作行 + 按钮族（高 30，primary 青蓝底，approve 绿/reject 红/ghost 透明）
- `c2-metrics` / `c2-metric` / `c2-score`：指标磁贴网格（等宽数字大值 + 评分色块）
- `c2-req`：需求行（左侧图标格 + 数量 + 就绪状态，pending 用 warning 色）
- `c2-gantt` / `c2-gantt-bar` / `c2-gantt-now` / `c2-gantt-axis`：甘特时间轴（纯 CSS grid + 百分比定位，任务条青蓝辉光，pending 灰化，NOW 游标青蓝高亮竖线）
- `c2-shell` / `c2-shell-body` / `c2-shell-col` / `c2-shell-map`：三栏态势工作台骨架（左态势/方案栏 260、中地图、右详情栏 300；地图用径向青蓝渐变 + 射程环 + 单位点占位）

## 原则

- 层级靠四档背景亮度差建立，不靠粗描边；描边只用低饱和冷灰蓝。
- 青蓝辉光只给选中态与地图/点位类；语义色承载状态；评分色阶专用于 LOW/MED/HIGH。
- 数据（坐标、编号、指标、时间、阈值）一律等宽字体 + tabular-nums 对齐。
- 微标签（小标题、字段名、指标 label）一律大写 + 字距（letter-spacing 1~2px），塑造 C2 技术感。
- 交互尽量 CSS-only（radio / `:hover` / `<details>`），少用 JS；图标全内联 SVG（stroke-width 2，16~18px）。
- 顶部始终放密级横幅；态势类界面用三栏骨架；时间类用甘特轴带 NOW 游标。
- 当前时间图表：当前时间指北京时间 UTC+8 的真实系统时间；若范围含当前时刻，用青蓝亮竖线 markLine + "现在 / 当前时间" 标签，不要硬编码陈旧或模拟时间。
