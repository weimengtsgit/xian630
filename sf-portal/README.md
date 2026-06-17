# SF Portal

Intelligent Software Factory Portal - 智能软件工厂门户系统

## 技术栈

- React 18
- Vite 6
- Lucide React Icons

## 功能特性

- 🎨 参考 situation-prototype 的整体布局风格
- 📍 顶部菜单栏（主菜单、标题、状态信息）
- 🔧 左侧工具栏（功能菜单）
- 🌌 深色科幻主题

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build
```

## 项目结构

```
sf-portal/
├── index.html
├── package.json
├── vite.config.js
├── README.md
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── App.css
    ├── index.css
    └── components/
        ├── TopBar.jsx
        └── LeftToolbar.jsx
```

## 布局说明

- **TopBar**: 顶部状态栏，包含主菜单、系统标题、状态信息
- **LeftToolbar**: 左侧功能菜单，提供快捷导航
- **PortalContent**: 主内容区域，可扩展具体业务组件
