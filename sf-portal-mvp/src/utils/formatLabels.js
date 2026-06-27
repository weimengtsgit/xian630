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

export function formatAppType(type) {
  const map = {
    command_dashboard: '指挥仪表盘',
    situation_replay: '态势复盘',
    operations_management: '运营管理',
    managed_agent: '纳管智能体',
    'command-dashboard': '指挥仪表盘',
    'affiliation-inference-dashboard': '归属推断仪表盘',
    'timeline-replay': '态势复盘',
    'map-dashboard': '地图态势',
  }
  return map[type] || type || '-'
}
