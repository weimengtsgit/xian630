---
name: c2-ui-system
description: C2 军事指挥态势感知深色设计系统 — interface-agent 生成界面时使用的样式规范
---

# C2 UI System

军事指挥 / 态势感知（Command & Control）深色设计系统。本 skill 是 **interface-agent 界面生成的唯一视觉风格来源**：`src/lib/deepseek.js` 在构造生成 prompt 时加载本目录的 `style.md`，作为 DeepSeek 生成 HTML 的样式规范注入系统提示。

## 何时使用

interface-agent 每次异步生成界面稿时（`POST /api/interface-sessions/:id/generations` 由后台 generations worker 调用 DeepSeek），自动套用本 skill 的 C2 设计语言（除非用户在请求里明确要求别的风格）。无需手动调用。

## 文件

- `style.md` — 注入到 DeepSeek system prompt 的精简样式规范（设计令牌 + 组件目录 + 原则）。`deepseek.js` 在模块加载时读取此文件。
- `c2-ui-system.html` — 完整的单文件设计系统参考（活的组件展示墙 + 令牌文档），740 行。改 `style.md` 前可对照此文件确认令牌 / 组件用法。

## 改样式

改 `style.md` 即可改变生成风格（`deepseek.js` 每次启动读取，改完重启服务生效）。若要换一套完全不同的设计系统：新建 `skills/<name>/style.md` 并改 `deepseek.js` 里的加载路径，或直接替换本 `style.md` 内容。
