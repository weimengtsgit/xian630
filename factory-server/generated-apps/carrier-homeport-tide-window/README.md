# 航母母港潮汐窗口计算器

四大航母母港潮汐窗口状态看板 — 2×2 港口卡片，实时展示诺福克、圣迭戈、布雷默顿、横须贺各港口当前潮高、可出港窗口状态、下一个窗口起止时间、倒计时和未来 72 小时潮汐曲线。

## 功能特性

- 🌊 **实时潮汐监控**：四大航母母港未来 72 小时潮汐数据
- 🚢 **智能窗口计算**：基于 12.8 米吃水阈值自动计算可出港时间窗
- ⏱️ **实时倒计时**：显示距离下一个窗口的剩余时间
- 📊 **可视化曲线**：每个港口的 72 小时潮汐趋势曲线
- 🔄 **自动刷新**：每 10 分钟自动更新数据

## 数据说明

本应用使用 **mock / 演示数据**，不调用真实潮汐 API。所有潮汐数据由 `src/data/mock.js` 生成，便于演示和测试。

为便于演示窗口开闭与倒计时变化，应用内置本地 demo tick：每 6 秒推进 20 分钟的潮汐时间，使当前潮高、可出港窗口、倒计时可见地变化。

## 快速启动

### 本地开发

```bash
npm install
npm run dev
```

访问 http://127.0.0.1:5173

### 生产构建

```bash
npm run build
npm run preview
```

### Docker 部署

```bash
docker build -t carrier-homeport-tide-window .
docker run -p 8080:80 carrier-homeport-tide-window
```

访问 http://localhost:8080

## 技术栈

- **前端框架**：React 18
- **构建工具**：Vite 6
- **图标库**：lucide-react
- **样式**：CSS Modules
- **容器化**：Dockerfile + nginx

## 港口信息

| 港口 | 位置 | 时区 |
|------|------|------|
| 诺福克 (Norfolk) | 美国弗吉尼亚州 | UTC-5 |
| 圣迭戈 (San Diego) | 美国加利福尼亚州 | UTC-8 |
| 布雷默顿 (Bremerton) | 美国华盛顿州 | UTC-8 |
| 横须贺 (Yokosuka) | 日本神奈川县 | UTC+9 |

## 阈值配置

- **航母吃水阈值**：12.8 米
- **窗口判定**：潮高 ≥ 12.8 米为可出港窗口
- **刷新频率**：每 10 分钟

## 项目结构

```
carrier-homeport-tide-window/
├── .factory/
│   └── app.json           # 应用元数据
├── src/
│   ├── main.jsx           # 应用入口
│   ├── App.jsx            # 主组件
│   ├── App.css            # 全局样式
│   ├── components/
│   │   ├── PortCard.jsx   # 港口卡片组件
│   │   └── TideCurve.jsx  # 潮汐曲线组件
│   └── data/
│       └── mock.js        # Mock 潮汐数据生成器
├── index.html
├── package.json
├── vite.config.js
├── Dockerfile
├── nginx.conf
└── README.md
```

## 生成信息

- **生成时间**：2026-06-20
- **作业 ID**：job_8b316e1e93fe8d3f506425b1
- **应用类型**：command_dashboard
- **数据策略**：mock_data
