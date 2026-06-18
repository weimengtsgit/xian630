# Module 4: 实时状态同步

### Teaching Arc
- **Metaphor:** 机场公告板。航班状态变了，候机厅每块屏幕都刷新。
- **Opening hook:** 不刷新页面也能看到 Job 变化，是因为浏览器开着一条 SSE 订阅。
- **Key insight:** REST 拉取当前状态，SSE 推送状态变化。
- **Why should I care?:** 调试“页面不更新”时，要分别检查事件是否发出、前端是否订阅、Hook 是否刷新。

### Code Snippets
File: sf-portal/src/api/events.js (lines 3-12)
```
export function subscribeFactoryEvents(onEvent) {
  const source = new EventSource(`${API_BASE_URL}/api/events`)
  const types = ['app.updated', 'job.created', 'job.updated', 'step.updated', 'artifact.created', 'deployment.updated']
  types.forEach(type => {
    source.addEventListener(type, event => {
      onEvent(type, JSON.parse(event.data))
    })
  })
  return () => source.close()
}
```

### Interactive Elements
- **Code translation:** EventSource subscription.
- **Quiz:** Debug stale UI.
- **Data flow animation:** Executor publishes event → Hub → EventSource → Hook refresh → panel.
- **Reference sections:** Code translations, quizzes, data flow, callouts.

### Connections
- **Previous module:** Step transitions.
- **Next module:** Apps and deployments that appear in the panels.

