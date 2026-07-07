# 智能应用商店交付说明

## 1. 项目说明

本项目是“作战管理中心 / 智能应用商店”的前端静态页面交付包，包含应用卡片展示、新品推荐、应用分类筛选、应用详情弹窗、生成/迭代时间展示和平均时间统计。

当前线上访问地址：

```text
http://220.154.5.91:18016/
```

## 2. 目录结构

```text
.
├── preview/                         # 可直接部署或本地启动的静态页面目录
│   ├── index.html
│   └── assets/
│       ├── index-DmVUBMo0.js
│       ├── index-B8ewh3t7.css
│       ├── app-store-overrides.css
│       └── app-store-time-metrics.js
├── ops-store-api.js                 # Nginx njs 接口脚本，用于动态注册/删除应用
├── ops-store-default.conf           # Nginx 示例配置
├── index.html                       # 根目录页面副本
├── index.js                         # 根目录 JS 副本
├── app-store-overrides.css          # 页面覆盖样式
├── app-store-time-metrics.js        # 应用生成/迭代时间脚本
├── API_DOCUMENTATION.md             # 接口文档
└── README.md                        # 本文件
```

## 3. 本地启动方式

### 方式一：仅预览页面

适用于只查看页面，不需要调用 `/api/apps` 动态接口的场景。

```bash
cd preview
python -m http.server 18016
```

浏览器访问：

```text
http://127.0.0.1:18016/
```

说明：普通静态服务器不提供 `/api/apps` 接口，页面会正常展示内置应用列表。

### 方式二：Nginx + njs 接口模式

适用于需要支持应用动态注册、查询、删除接口的场景。

1. 安装 Nginx，并启用 njs 模块。
2. 将 `preview/` 目录内容部署到：

```text
/usr/share/nginx/html/
```

3. 将接口脚本复制到：

```text
/etc/nginx/ops-store-api.js
```

4. 使用 `ops-store-default.conf` 作为站点配置。
5. 确保运行用户对以下文件有读写权限：

```text
/usr/share/nginx/html/assets/runtime-apps.json
```

如果文件不存在，可先创建空数组：

```bash
mkdir -p /usr/share/nginx/html/assets
echo "[]" > /usr/share/nginx/html/assets/runtime-apps.json
```

6. 启动或重载 Nginx：

```bash
nginx -t
nginx -s reload
```

浏览器访问：

```text
http://服务器IP:端口/
```

## 4. 页面配置说明

应用基础数据已打包在 `preview/assets/index-DmVUBMo0.js` 中。

生成时间、迭代时间和平均时间逻辑位于：

```text
preview/assets/app-store-time-metrics.js
```

页面覆盖样式位于：

```text
preview/assets/app-store-overrides.css
```

如需修改页面标题、应用名称、应用链接或展示数据，建议修改对应 JS/CSS 文件后重新部署 `preview/` 目录。

## 5. 当前主要功能

- 全部应用列表
- 新品推荐
- 分类筛选
- 应用详情弹窗
- 收藏状态切换
- 应用生成时间、迭代时间展示
- 生成平均时间、迭代平均时间、综合平均时间统计
- `/api/apps` 动态应用注册接口

