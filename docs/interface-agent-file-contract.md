# interface-agent 文件服务器对接契约

本文档面向 interface-agent 的上游需求生产方和下游代码生成服务。当前版本为单任务串行模式，上下游不调用 interface-agent 接口，只通过 Blade OS 文件服务器交换文件。

## 1. 测试环境

```text
Blade OS: http://115.190.152.1
鉴权: Authorization: Bearer <BLADE_OS_PAT>
```

PAT 由部署方通过服务端环境变量配置，不写入前端、代码仓库或本文档。

## 2. 核心约定

- 上游只负责写待定输入文件。
- interface-agent 只读取待定输入文件，不移动、不复制、不删除该文件。
- interface-agent 读取到待定输入后，将全文放入页面会话区和输入框，并停止轮询。
- 用户在页面中手动点击「生成 / 调整」生成原型。
- 用户确认原型后点击「确认并复制链接」，interface-agent 将最终 HTML 覆盖写入固定输出文件。
- 下游代码生成服务只监听固定输出文件，不调用 interface-agent。
- 当前没有 taskId、队列、manifest 或多任务并发语义。

## 3. interface-agent 部署配置

```env
BLADE_OS_BASE_URL=http://115.190.152.1
BLADE_OS_PAT=<由部署方填写>
PENDING_INPUT_PATH=共享/pending.md
CONFIRMED_OUTPUT_PATH=共享/prototype.html
PENDING_POLL_INTERVAL_MS=3000
```

路径可以按上线环境调整，但上下游和 interface-agent 必须使用同一组路径。

## 4. 上游写入契约

上游将待生成界面的需求内容写入：

```text
共享/pending.md
```

文件内容为纯文本或 Markdown，interface-agent 不解析格式、不读取结构化字段、不区分标题、正文或元数据。文件全文会作为用户需求进入会话。

示例：

```markdown
# 态势监控页面

请生成一个深色科技风的态势监控大屏，包含：
- 顶部 KPI
- 地图态势区
- 告警列表
- 趋势图
```

注意：

- 上游不要依赖 interface-agent 修改该文件。
- 如需更新需求，直接覆盖同一路径内容。
- 如果 interface-agent 页面已经加载过待定文件，它会停止轮询；用户点击「重置」后才会再次读取当前待定文件。

## 5. interface-agent 用户确认契约

用户操作顺序：

1. 打开 interface-agent 页面。
2. 页面轮询到 `PENDING_INPUT_PATH` 后，自动把内容放入会话区和输入框。
3. 用户可编辑输入框。
4. 用户点击「生成 / 调整」。
5. 用户确认页面没问题后，点击「确认并复制链接」。
6. interface-agent 覆盖写入：

```text
共享/prototype.html
```

写入失败时，页面不会提示确认成功，用户可以稍后重试。

## 6. 下游读取契约

下游代码生成服务监听：

```text
共享/prototype.html
```

推荐监听方式：

- 使用文件服务器 `stat` 或目录 `list` 观察输出文件的 `modified`/`size` 变化。
- 发现变化后做一次短暂 debounce，例如 1 到 3 秒，再下载文件。
- 下载后校验内容非空，并包含可渲染 HTML。
- 同一路径会被覆盖，所以下游应以文件最新内容为准。

当前没有完成信号文件；输出文件本身就是确认结果。后续如果升级多任务并发，再引入 taskId 目录和 manifest。

## 7. Blade OS 文件 API 示例

鉴权头：

```bash
OS=http://115.190.152.1
PAT=<BLADE_OS_PAT>
H="Authorization: Bearer $PAT"
```

上游上传待定文件：

```bash
curl -s -H "$H" -X POST "$OS/api/v1/files/upload?path=共享" \
  -F "files=@./pending.md;filename=pending.md"
```

下游读取输出文件：

```bash
curl -s -H "$H" \
  "$OS/api/v1/files/download?path=共享/prototype.html" \
  -o prototype.html
```

下游查看文件状态：

```bash
curl -s -H "$H" \
  "$OS/api/v1/files/stat?path=共享/prototype.html"
```

## 8. 异常语义

| 场景 | 行为 |
| --- | --- |
| 待定输入文件不存在 | interface-agent 继续轮询 |
| 待定输入文件为空 | interface-agent 不加载，继续等待 |
| 待定输入读取失败 | 页面显示读取失败，后续轮询仍可重试 |
| 用户未点击重置 | 已加载待定文件后不再轮询 |
| 输出文件写入失败 | 页面显示确认共享失败，不提示成功 |
| 输出文件已存在 | interface-agent 覆盖写入，以最后一次确认结果为准 |
| 下游重复读取 | 下游自行按 `modified`/内容哈希去重 |

## 9. 安全要求

- PAT 只能放在服务端环境变量或部署配置中。
- 前端页面不得暴露 PAT。
- 日志不得打印 PAT。
- 上下游只应操作约定路径，避免误删共享目录内其他文件。

## 10. 版本边界

当前版本不支持：

- 多任务并发；
- taskId；
- manifest 完成信号；
- 输入文件结构化字段；
- interface-agent 主动通知下游；
- 上下游调用 interface-agent 服务接口。

如需支持多任务，建议下一版改为：

```text
共享/tasks/<taskId>/pending.md
共享/tasks/<taskId>/prototype.html
共享/tasks/<taskId>/manifest.json
```
