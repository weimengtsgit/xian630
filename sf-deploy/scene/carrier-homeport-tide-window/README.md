# 航母母港潮汐窗口计算器 (carrier-homeport-tide-window)

四大航母母港潮汐窗口状态看板 — 2×2 港口卡片，每张卡展示当前潮高、12.8 m 吃水阈值、
可出港窗口状态、下一个窗口起止时间、倒计时和未来 72 小时潮汐曲线。

## 客户口径（已落入 UI 与逻辑）

- 抓取 **诺福克、圣迭戈、布雷默顿、横须贺** 四大航母母港未来 **72 小时**潮汐数据。
- 航母吃水阈值设为 **12.8 米**（在每张卡、KPI、研判面板中显式展示）。
- 自动标出各港口满足条件的 **"可出港时间窗"**（潮高 ≥ 12.8 m 的连续时段）。
- 倒计时显示距离下一个窗口还有多久；窗口开放时显示绿色，关闭时显示红色倒计时。
- **每 10 分钟刷新一次**（顶部verbatim 展示该客户口径字符串）。

## 数据来源说明（重要）

本应用的潮汐数据为 **mock / 演示数据**。`src/data/mock.js` 中的 `buildSeries`/
`computeWindows` 生成确定性的 72 小时潮汐序列与已计算的可出港窗口，其输出结构
（`{ port, series: [{t, height}], threshold, windows }`）按未来公开潮汐预测 API 适配，
真实适配器替换该 provider 即可，无需改动 UI。

- 不调用任何真实 API，不包含密钥，不依赖后端 / 云服务。
- 顶部"演示潮汐序列 / mock"徽标明确标注数据边界。

## 本地演示 tick

客户配置的刷新频率为 **每 10 分钟刷新一次**，UI 顶部始终展示该字符串。为便于演示
窗口开闭与倒计时的变化，应用内置一个本地 demo tick：每 6 秒推进 20 分钟的潮汐时间，
使当前潮高、可出港窗口、倒计时与最近刷新时间可见地变化。该 tick 仅为演示加速器，
不改变客户口径展示。

## 开发 / 构建 / 运行

```bash
npm install
npm run dev       # 本地开发 (127.0.0.1:5173)
npm run build     # 生产构建，输出到 dist/
npm run preview   # 预览构建产物
```

Docker：

```bash
docker build -t carrier-homeport-tide-window .
docker run -p 8080:80 carrier-homeport-tide-window
```

## 技术栈

React 18 + Vite 6 + lucide-react，纯 JavaScript (.jsx)，潮汐曲线为内联 SVG，
完全自包含、可离线构建。
