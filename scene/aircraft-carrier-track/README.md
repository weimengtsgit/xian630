# 航母轨迹分析应用

基于高德地图的航母轨迹可视化分析系统。

## 功能特性

- 🗺️ 使用高德地图展示航母移动轨迹
- 📍 显示从大连港到台湾海峡的7天航行路线
- ⏰ 右侧时间轴组件，点击切换不同日期的航母位置
- 📋 点击航母图标显示详细事件卡片
- 🎨 深色科技感UI风格

## 技术栈

- React 18
- Vite 6
- 高德地图 JavaScript API 2.0

## 安装与运行

### 1. 安装依赖

```bash
npm install
```

### 2. 配置高德地图Key

在使用前，需要配置高德地图的API Key：

1. 前往 [高德开放平台](https://console.amap.com/) 注册并申请 Key 和安全密钥
2. 编辑以下文件替换占位符：

**`index.html`** - 安全密钥配置：
```html
<script type="text/javascript">
  window._AMapSecurityConfig = {
    securityJsCode: 'YOUR_SECURITY_JS_CODE', // 替换为你的安全密钥
  }
</script>
```

**`src/components/MapView.jsx`** - API Key配置：
```javascript
const AMap = await AMapLoader.load({
  key: 'YOUR_AMAP_KEY', // 替换为你的高德地图Key
  // ...
})
```

### 3. 启动开发服务器

```bash
npm run dev
```

应用将在 http://localhost:3000 启动。

### 4. 构建生产版本

```bash
npm run build
```

## 项目结构

```
app/aircraft-carrier-track/
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

### 更换地图样式

在 `MapView.jsx` 中修改 `mapStyle` 参数：

```javascript
mapStyle: 'amap://styles/darkblue', // 深蓝色
// 可选：'amap://styles/dark', 'amap://styles/light', 等
```
