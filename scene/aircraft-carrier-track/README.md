# 航母轨迹分析

Preset scene app，基于 MapLibre 的航母轨迹可视化分析系统。

## 功能特性

- 🗺️ 使用 MapLibre + 卫星瓦片展示航母移动轨迹
- 📍 显示从大连港到台湾海峡的7天航行路线
- ⏰ 右侧时间轴组件，点击切换不同日期的航母位置
- 📋 点击航母图标显示详细事件卡片
- 🎨 深色科技感UI风格

## 技术栈

- React 18
- Vite 6
- MapLibre GL

## 安装与运行

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
```

应用将在 http://localhost:3000 启动。

### 3. 构建生产版本

```bash
npm run build
```

## 容器构建

```bash
podman build -t software-factory/aircraft-carrier-track:latest .
podman run --rm -p 18082:80 software-factory/aircraft-carrier-track:latest
```

## 项目结构

```
scene/aircraft-carrier-track/
├── index.html              # HTML入口文件
├── package.json           # 项目依赖配置
├── vite.config.js        # Vite配置
├── src/
│   ├── main.jsx          # 应用入口
│   ├── App.jsx           # 主应用组件
│   ├── App.css           # 主应用样式
│   ├── index.css         # 全局样式
│   ├── components/
│   │   ├── MapView.jsx   # 地图组件
│   │   ├── MapView.css
│   │   ├── Timeline.jsx  # 时间轴组件
│   │   ├── Timeline.css
│   │   ├── EventCard.jsx # 事件卡片组件
│   │   └── EventCard.css
│   └── data/
│       └── trajectoryData.js  # 轨迹数据
```

## 数据说明

轨迹数据位于 `src/data/trajectoryData.js`，包含：

- 7天的航行数据
- 每天的位置坐标
- 事件名称和描述
- 完整的航线路径点

## 自定义开发

### 修改轨迹数据

编辑 `src/data/trajectoryData.js` 文件，修改 `trajectoryData` 数组中的坐标和事件信息。

### 调整UI样式

- **地图样式**：修改 `MapView.css`
- **时间轴样式**：修改 `Timeline.css`
- **卡片样式**：修改 `EventCard.css`

Factory manifest 位于 `.factory/app.json`。
