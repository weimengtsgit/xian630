# 智能应用商店接口文档

## 1. 接口概览

接口由 Nginx njs 脚本 `ops-store-api.js` 提供，用于管理运行时追加的应用数据。

基础地址：

```text
http://服务器IP:端口
```

数据存储文件：

```text
/usr/share/nginx/html/assets/runtime-apps.json
```

注意：普通静态服务器启动时不包含以下接口；需要使用 Nginx + njs 模式。

## 2. 通用说明

响应格式：

```json
{
  "字段": "值"
}
```

跨域：

接口支持 `Access-Control-Allow-Origin: *`。

支持方法：

```text
GET, POST, DELETE, OPTIONS
```

## 3. 查询应用列表

### 请求

```http
GET /api/apps
```

### 响应示例

```json
[
  {
    "id": "incoming-001",
    "name": "示例智能体",
    "description": "示例应用描述",
    "longDescription": "示例应用详细描述",
    "icon": "示",
    "category": "情报分析",
    "status": "新品",
    "version": "v1.0.0",
    "vendor": "电子云",
    "publishDate": "2026-06-28",
    "link": "http://127.0.0.1:18000/",
    "favorited": false,
    "features": ["外部接口注册", "新品自动推荐"]
  }
]
```

### 状态码

```text
200 查询成功
```

## 4. 注册或更新应用

### 请求

```http
POST /api/apps
Content-Type: application/json
```

### 请求体字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 | 应用唯一标识，不传则自动生成 |
| name | string | 是 | 应用名称 |
| description | string | 否 | 应用简介 |
| longDescription | string | 否 | 应用详情描述，不传则使用 description |
| category | string | 否 | 应用分类，默认“情报分析” |
| version | string | 否 | 版本号，默认“v1.0.0” |
| vendor | string | 否 | 厂商，默认“电子云” |
| publishDate | string | 否 | 发布日期，默认当天，格式 YYYY-MM-DD |
| link | string | 否 | 应用访问地址 |
| url | string | 否 | link 的兼容字段 |
| features | array | 否 | 功能特性列表 |

兼容中文字段：

```text
名字、描述、类别、版本、厂商
```

### 请求示例

```bash
curl -X POST "http://服务器IP:端口/api/apps" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "demo-app-001",
    "name": "示例智能体",
    "description": "示例应用描述",
    "category": "情报分析",
    "version": "v1.0.0",
    "vendor": "电子云",
    "link": "http://127.0.0.1:18000/",
    "features": ["能力一", "能力二"]
  }'
```

### 响应示例

```json
{
  "id": "demo-app-001",
  "name": "示例智能体",
  "description": "示例应用描述",
  "longDescription": "示例应用描述",
  "icon": "示",
  "category": "情报分析",
  "status": "新品",
  "version": "v1.0.0",
  "vendor": "电子云",
  "publishDate": "2026-06-28",
  "link": "http://127.0.0.1:18000/",
  "favorited": false,
  "features": ["能力一", "能力二"]
}
```

### 状态码

```text
201 注册成功
400 请求体不是合法 JSON
405 请求方法不支持
```

说明：当新应用的 `id` 或 `name` 与已有运行时应用重复时，会先删除旧记录，再将新记录插入到列表最前面。

## 5. 删除应用

### 请求

```http
DELETE /api/apps/{id或应用名称}
```

### 请求示例

```bash
curl -X DELETE "http://服务器IP:端口/api/apps/demo-app-001"
```

按名称删除时，名称需要 URL 编码：

```bash
curl -X DELETE "http://服务器IP:端口/api/apps/%E7%A4%BA%E4%BE%8B%E6%99%BA%E8%83%BD%E4%BD%93"
```

### 响应示例

```json
{
  "deleted": 1
}
```

### 状态码

```text
200 删除请求处理完成
400 缺少 id 或应用名称
405 请求方法不支持
```

## 6. 预检请求

### 请求

```http
OPTIONS /api/apps
```

### 响应

```text
204 No Content
```

## 7. 前端读取逻辑

页面加载时会同步请求：

```text
GET /api/apps
```

如果接口不可用或请求失败，页面会使用内置应用列表继续展示，不影响基础页面访问。

