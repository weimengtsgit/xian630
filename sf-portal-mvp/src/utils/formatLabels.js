// Shared display-label formatters for requirement summary fields.
// Imported by ConversationWorkbench and ClarificationPanel so the Chinese
// labels stay in lockstep across both surfaces.

export function formatDataPolicy(policy) {
  const map = {
    live_api: '真实接口',
    mock_data: '演示数据',
    mock_then_api: '演示数据优先',
    local: '本地数据',
  }
  return map[policy] || policy || '-'
}

// The SINGLE source of truth for app-type → Chinese display labels. Canonical
// names follow CONTEXT.md (指挥看板类 / 业务管理类 / 归属研判类 / 态势复盘类应用).
// Every surface (requirement summary, applications panel, store page) MUST go
// through this — never hardcode a duplicate map or show the raw English type.
// Internal English type values remain as backend keys (generation-profile etc.);
// only DISPLAY is translated here.
export function formatAppType(type) {
  const map = {
    command_dashboard: '指挥看板',
    operations_management: '业务管理',
    situation_replay: '态势复盘',
    affiliation_inference_dashboard: '归属研判',
    managed_agent: '纳管智能体',
    // kebab-case variants (legacy/preset slugs)
    'command-dashboard': '指挥看板',
    'timeline-replay': '态势复盘',
    'map-dashboard': '地图态势',
    'affiliation-inference-dashboard': '归属研判',
  }
  return map[type] || type || '-'
}
