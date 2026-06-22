# 航母母港潮汐窗口计算器

航母出港时机决策支持系统：实时监控四大母港潮汐条件，自动计算满足12.8米吃水阈值的可出港时间窗。

## 功能特性

- **四港监控**：诺福克、圣迭戈、布雷默顿、横须贺四大航母母港
- **72小时预测**：展示未来72小时潮汐曲线
- **窗口计算**：自动计算满足12.8米吃水阈值的可出港时间窗
- **状态可视化**：绿色开放/红色关闭状态，实时倒计时
- **决策辅助**：下一窗口起止时间，剩余时间倒计时

## 技术栈

- React 18 + Vite 6
- lucide-react (图标库)
- 纯前端静态应用，使用 mock 数据

## 开发

```bash
npm install
npm run dev       # 本地开发 (127.0.0.1:5173)
npm run build     # 生产构建，输出到 dist/
npm run preview   # 预览构建产物
```

## Docker 部署

```bash
docker build -t carrier-homeport-tide-calculator .
docker run -p 8080:80 carrier-homeport-tide-calculator
```

## 数据说明

本应用使用 mock 数据进行演示，不连接真实潮汐预测 API。数据结构按未来 API 适配器设计，替换数据源无需改动 UI。

为便于演示窗口开闭与倒计时变化，应用内置演示加速器：每 6 秒推进 20 分钟潮汐时间。
