const APP_TYPE_LABELS = {
  operations_management: '业务管理类智能体',
  command_dashboard: '指挥看板类智能体',
  situation_replay: '态势复盘类智能体',
  timeline_replay: '态势复盘类智能体',
  'timeline-replay': '态势复盘类智能体',
  affiliation_assessment: '归属研判类智能体',
  assistant: '助手智能体',
}

const DATA_POLICY_LABELS = {
  live_api: '真实接口优先',
  mock_data: '演示 / Mock 数据',
  mock_then_api: '真实接口优先（失败时明确提示，不回退 Mock）',
}

const FIELD_LABEL_MAPS = {
  appType: APP_TYPE_LABELS,
  dataPolicy: DATA_POLICY_LABELS,
}

export function displayRequirementValue(field, value) {
  if (Array.isArray(value)) {
    return value.map(item => displayRequirementValue(field, item)).join('、')
  }
  if (value == null || value === '') return ''
  const raw = String(value)
  const map = FIELD_LABEL_MAPS[field]
  if (map && map[raw]) return map[raw]
  if (map) return `未识别值：${raw}`
  return raw
}
