# Blade OS 文件操作 API（file-op）

blade-os「我的文件」文件操作 REST API 参考 + Python 客户端/示例。
鉴权统一用 **blade-oauth Bearer 令牌**（v3 PAT / JWT），无需 cookie / CSRF。

- 实现：`backend/app/api/v1/files.py`、`backend/app/services/file_service.py`
- 客户端/示例：本目录 `client.py`、`demo.py`

## 1. 概述

- 服务：blade-os 后端（生产监听 **80** 端口；下文 `{OS}` 代指 `http://<blade-os-host>`）。
- 路由前缀：`{OS}/api/v1/files`。
- 所有 `path` 为相对当前用户根目录的相对路径。
- 「共享」是「我的文件」下的全用户共享子目录（host bind mount），对调用方就是普通子目录，
  传 `path=共享/...` 即可操作共享盘；其它目录同理（`文档/...` 等）。

> 区分：智能助手（blade-agent，:8020）是另一套服务；本文档是 blade-os 文件 API。

## 2. 操作 API

基址：`{OS}/api/v1/files`

| 操作 | 方法 + 路径 | 入参 |
|---|---|---|
| 列目录 list | `GET /list` | query `path` |
| 详情 stat | `GET /stat` | query `path`（必填） |
| 读 / 下载 | `GET /download` | query `path` |
| 预览（文本 inline） | `GET /preview` | query `path` |
| 写 / 上传 | `POST /upload` | query `path`（目标目录）+ multipart `files` |
| 文件夹上传 | `POST /upload-folder` | multipart（保留 webkitRelativePath） |
| 建文件夹 mkdir | `POST /mkdir` | body `{"path":"文档/新文件夹"}` |
| 建文件 new-file | `POST /new-file` | body `{"path":"文档/新建.txt"}` |
| 重命名 | `POST /rename` | body `{"path","new_name"}` |
| 删除 | `POST /delete` | body `{"paths":[...]}` |
| 移动 | `POST /move` | body `{"src","dst"}` |
| 复制 | `POST /copy` | body `{"src","dst"}` |
| 搜索 | `GET /search` | query `keyword`,`path` |
| 搜索（流式 SSE） | `GET /search/stream` | 同上 |
| 打包下载 zip | `POST /download-zip` | body `{"paths":[...]}` |

说明：
- **没有独立「写文件内容」接口**：`new-file` 只建空文件；写/更新内容用 `upload`。
- 根级系统目录（默认文件夹、`共享`）本身禁改名/删除；其内部内容可正常增删改。

## 3. 鉴权：Bearer 令牌

所有接口统一：

```
Authorization: Bearer <blade-oauth v3 PAT 或 JWT>
```

- 读、写全部只需这一个头，**无需 cookie、无需 CSRF**。
- 令牌经 blade-oauth 中心化校验（v3 PAT introspect / JWT JWKS）解析用户身份；无效/失效 → 401。
- 全局 Bearer 支持自 PR #109 起（blade-os ≥ v0.2.41）。

## 4. 令牌（key）从哪里来？

blade-oauth（`{OAUTH}`，如 `http://<host>:19000`）：

- **每用户 v3 PAT（推荐，长期）**：`GET {OAUTH}/api/v1/pat/v3/default` 取明文（`sk-blade-v3-…`）。
- **登录 JWT（短期）**：`POST {OAUTH}/api/v1/auth/login` body `{"username","password"}` → `access_token`。

## 5. curl 示例

```bash
OS=http://115.190.152.1
PAT=sk-blade-v3-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
H="Authorization: Bearer $PAT"

curl -s -H "$H" "$OS/api/v1/files/list?path=共享"                       # 列目录
curl -s -H "$H" "$OS/api/v1/files/download?path=共享/a.txt" -o a.txt     # 下载
curl -s -H "$H" -H "Content-Type: application/json" \
  -X POST "$OS/api/v1/files/mkdir" -d '{"path":"共享/新文件夹"}'         # 建夹
curl -s -H "$H" -X POST "$OS/api/v1/files/upload?path=共享" -F "files=@./a.txt"  # 上传
```

## 6. Python 客户端 / 示例

```bash
pip install requests
python demo.py <base_url> <pat>
# 例：python demo.py http://115.190.152.1 sk-blade-v3-xxxxxxxx
```

- `client.py`：`BladeFileClient(base_url, token)`，方法覆盖 list / stat / download /
  read_text / search / mkdir / new_file / upload / upload_bytes / rename / delete /
  move / copy / download_zip。
- `demo.py`：列目录 → 建夹 → 上传(写内容) → 读回 → 建空文件 → 再列 → 清理。

最小用法：

```python
from client import BladeFileClient

c = BladeFileClient("http://115.190.152.1", "sk-blade-v3-xxxx")
print(c.list("共享"))                      # 读文件夹
c.mkdir("共享/报表")                        # 写文件夹
c.upload_bytes("共享/报表", "q1.txt", b"...")  # 写文件
print(c.read_text("共享/报表/q1.txt"))       # 读文件
```

## 7. 注意事项

- 共享盘是 rw 公共盘：删 `共享` 内文件对所有用户立即生效（无回收站）。
- 错误码：令牌缺失/无效 → 401；越权路径 → 403（`路径越权访问`）；文件不存在 → 404。
- 端口：文件 API 在 80；blade-oauth 在 19000（按部署）。
