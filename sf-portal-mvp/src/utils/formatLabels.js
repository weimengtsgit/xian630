// Shared display-label formatters for requirement summary fields.
// Imported by ConversationWorkbench and ClarificationPanel so the Chinese
// labels stay in lockstep across both surfaces.

// REQUIREMENT_TERM_MAP is the single source of truth for translating the
// internal English keys that leak into the 分析过程 / requirement summary into
// Chinese display labels. Three families live here:
//   - statuses (ready_to_confirm, confirmed, …) — kept in lockstep with the
//     statusText maps in hooks/clarificationLogic.js and dialogueTimeline.js.
//   - fields (openHighImpact, generationProfile, blueprintRefs, …) — the
//     Requirement / RoundOutput JSON tag names a reader sees in raw output.
//   - skill / generation-profile + scene-blueprint slugs (software-factory-app,
//     defense-operations-ui, …) — kebab-case catalog keys. Extensible: add new
//     slugs here as the catalog grows so they never render raw to the user.
// Format whole tokens only (see translateAnalysisText); never partial-match.
export const REQUIREMENT_TERM_MAP = {
  // statuses
  ready_to_confirm: '待确认',
  confirmed: '已确认',
  analyzing: '分析中',
  drafting_application: '需求澄清中',
  // fields
  openHighImpact: '待确认的高影响决策',
  generationProfile: '生成画像',
  blueprintRefs: '蓝本引用',
  dataPolicy: '数据策略',
  acceptanceFocus: '验收重点',
  mainEntities: '主要对象',
  coreScenario: '核心场景',
  primaryView: '主视图',
  judgementBoundary: '研判边界',
  // generation-profile + skill / scene-blueprint slugs (kebab-case keys)
  'software-factory-app': '软件工厂应用',
  'defense-operations-ui': '防务运营界面',
  'operations-management-console': '运维管理控制台',
  'map-timeline-replay': '地图时间轴复盘',
  'command-dashboard': '指挥看板',
  'maritime-alert-dashboard': '海事告警看板',
  'affiliation-inference-dashboard': '归属研判看板',
}

// formatRequirementTerm maps ONE internal English key (a status, field, or slug
// from REQUIREMENT_TERM_MAP) to its Chinese display label. Returns the input
// unchanged when no mapping exists, so unknown keys render verbatim rather than
// being blanked. Use this for STRUCTURED displays (chips, requirement rows).
export function formatRequirementTerm(term) {
  if (term == null || term === '') return term
  const key = String(term)
  return REQUIREMENT_TERM_MAP[key] || key
}

// translateAnalysisText substitutes the KNOWN internal English tokens inside a
// free-text work-log / analysis blob with their Chinese labels, so the agent's
// prose does not leak raw keys (e.g. "generationProfile.data", "blueprintRefs",
// "software-factory-app"). CONSERVATIVE: it only replaces EXACT known tokens
// using word/scope boundaries so it never mangles a partial match (e.g. it will
// NOT touch "generationProfileData" or "software-factory-app-v2"). Unknown text
// passes through unchanged.
//
// Tokens are matched as whole words; `.` and `/` count as boundaries so the
// field name in a dotted path (e.g. generationProfile.data) is replaced while
// the trailing `.data` is preserved. A token that already contains its Chinese
// label is a no-op.
export function translateAnalysisText(text) {
  if (!text) return text
  const input = String(text)
  if (!/[A-Za-z_-]/.test(input)) return input
  // Build one alternation of the literal keys, longest first so e.g.
  // "operations-management-console" wins over a shorter prefix match. The
  // boundary pattern allows preceding/following `.` `/` `:` `,` whitespace or
  // string edges but NOT alphanumerics/underscores/hyphens (so we never split a
  // larger identifier).
  const keys = Object.keys(REQUIREMENT_TERM_MAP).sort((a, b) => b.length - a.length)
  const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(^|[^\\w-])(${escaped.join('|')})($|[^\\w-])`, 'g')
  return input.replace(re, (_m, pre, token, post) => `${pre}${REQUIREMENT_TERM_MAP[token]}${post}`)
}

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
