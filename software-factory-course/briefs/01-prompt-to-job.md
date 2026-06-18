# Module 1: 从一句话到任务

### Teaching Arc
- **Metaphor:** 快递面单。用户写一句需求，门户把它贴成一张结构化“面单”，送到工厂 API。
- **Opening hook:** 你在底部对话框输入“做一个应用”并按回车，代码并不会立刻写页面，而是先创建一个 Job。
- **Key insight:** 前端负责把意图送出去，后端负责排队和持久化。
- **Why should I care?:** 以后让 AI 改“提交任务”问题时，要能区分是 UI 没发、API 没接、还是后端没排队。

### Code Snippets
File: sf-portal/src/api/client.js (lines 1-12)
```
const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${body}`)
  }
  return response.json()
}
```

### Interactive Elements
- **Code translation:** API request helper.
- **Quiz:** Debug where a prompt submission can fail.
- **Data flow animation:** User → ChatDialog → factoryApi → factory-server → SQLite.
- **Reference sections:** Code translations, quizzes, data flow, tooltips, callouts.

### Connections
- **Previous module:** None.
- **Next module:** Identifies the actors that receive and process the job.

