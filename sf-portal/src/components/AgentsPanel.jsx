import { useStages } from '../hooks/useStages'
import {
  CheckCircle,
  Clock,
  Bot,
  User,
  Briefcase,
  Figma,
  BarChart3,
  Code2
} from 'lucide-react'
import './AgentsPanel.css'

// 流水线节点元信息：图标 / 名称 / 类型 / 职责描述
const AGENT_META = {
  'agent-business': {
    icon: Briefcase,
    name: '业务逻辑智能体',
    type: '业务逻辑',
    desc: '业务流程建模 · 逻辑拆解',
    detail: '业务逻辑智能体重点是理解指挥员意图、分析业务逻辑，形成智能体生成方案。'
  },
  'agent-prototype': {
    icon: Figma,
    name: '界面解析智能体',
    type: '界面解析',
    desc: '界面结构 · 元素解析',
    detail: '界面解析智能体重点是回应指挥员关切，按要求调整配置界面。'
  },
  'agent-data': {
    icon: BarChart3,
    name: '数据抓取智能体',
    type: '数据抓取',
    desc: '数据采集 · 字段抽取',
    detail: '数据抓取智能体重点是深入动态数据对象进行数据抓取、接口对接，共同完成各类智能体的快速生成。'
  },
  'agent-production': {
    icon: Code2,
    name: '生产交付智能体',
    type: '生产交付',
    desc: '代码生成 · 工程交付'
  }
}

function AgentNode({ id, status, url }) {
  const meta = AGENT_META[id] || { icon: Bot, name: id, type: '', desc: '' }
  const Icon = meta.icon
  const completed = status === 'completed'
  const clickable = !!url
  const Tag = clickable ? 'a' : 'div'
  const tagProps = clickable ? { href: url, target: '_blank', rel: 'noopener' } : {}
  const accent = completed ? '#7feb9b' : '#68ddff'

  return (
    <Tag
      className={`agent-node${completed ? ' is-completed' : ''}${clickable ? ' is-clickable' : ' no-url'}`}
      data-agent-id={id}
      data-status={completed ? 'completed' : 'pending'}
      tabIndex={meta.detail ? 0 : undefined}
      {...tagProps}
    >
      {meta.detail && (
        <div className="agent-node-tooltip" role="tooltip">{meta.detail}</div>
      )}
      <div className="agent-node-head">
        <div className="agent-node-icon" style={{ borderColor: `${accent}55` }}>
          <Icon size={30} style={{ color: accent }} />
        </div>
        <div className="agent-node-titles">
          <div className="agent-node-name">{meta.name}</div>
          <div className="agent-node-type">{meta.type}</div>
        </div>
      </div>

      <div className="agent-node-desc">{meta.desc}</div>

      <div className="agent-node-status">
        {completed ? <CheckCircle size={17} color={accent} /> : <Clock size={17} color={accent} />}
        <span style={{ color: accent }}>{completed ? '已完成' : '待开始'}</span>
      </div>

      {completed
        ? <div className="agent-node-done">产出就绪 ✓</div>
        : (clickable ? null : <div className="agent-node-wait">未配置跳转</div>)}
    </Tag>
  )
}

// 用户输入卡片：展示从 AI 应用生成助手对话中提炼的关键字
function UserInputNode({ userInput }) {
  const hasInput = userInput.keywords.length > 0 || !!userInput.text
  return (
    <div className="agent-node user-input-node" data-empty={!hasInput}>
      <div className="agent-node-head">
        <div className="agent-node-icon user-input-icon">
          <User size={30} />
        </div>
        <div className="agent-node-titles">
          <div className="agent-node-name">用户输入</div>
          <div className="agent-node-type">需求描述</div>
        </div>
      </div>

      <div className="agent-node-desc">来自 AI 应用生成助手对话</div>

      {hasInput ? (
        <div className="keyword-chips">
          {userInput.keywords.length > 0 ? (
            userInput.keywords.map((k, i) => (
              <span key={i} className="keyword-chip">{k}</span>
            ))
          ) : (
            <span className="keyword-chip keyword-chip--text">
              {userInput.text.length > 16 ? `${userInput.text.slice(0, 16)}…` : userInput.text}
            </span>
          )}
        </div>
      ) : (
        <div className="agent-node-wait">等待在助手中输入需求…</div>
      )}
    </div>
  )
}

// 直连连接器：单节点 → 单节点（横向直线 + 箭头）
function LinearConnector() {
  return (
    <div className="flow-connector flow-connector--linear">
      <span className="seg seg-h-line" />
      <span className="arrow arrow-linear" />
    </div>
  )
}

// 横向分叉连接器：单节点 → 上下两个并行节点
function SplitConnector() {
  return (
    <div className="flow-connector flow-connector--split">
      <span className="seg seg-h-stub" />
      <span className="seg seg-v-bar" />
      <span className="seg seg-h-branch seg-top" />
      <span className="seg seg-h-branch seg-bottom" />
      <span className="arrow arrow-top" />
      <span className="arrow arrow-bottom" />
    </div>
  )
}

// 横向汇合连接器：上下两个并行节点 → 单节点
function MergeConnector() {
  return (
    <div className="flow-connector flow-connector--merge">
      <span className="seg seg-h-branch seg-top" />
      <span className="seg seg-h-branch seg-bottom" />
      <span className="seg seg-v-bar" />
      <span className="seg seg-h-stub" />
      <span className="arrow arrow-stub" />
    </div>
  )
}

export function AgentsPanel({ userInput }) {
  const { stages, loading } = useStages()
  const find = (key) => stages.find(s => s.key === key)

  if (loading) {
    return (
      <div className="agents-panel">
        <div className="panel-header"><h2>智能体流水线</h2></div>
        <div className="panel-loading">加载中...</div>
      </div>
    )
  }

  const node = (key) => {
    const s = find(key)
    return <AgentNode id={key} status={s?.status} url={s?.url} />
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>智能体流水线</h2>
          <span className="panel-subtitle">用户输入 → 业务逻辑 → 并行(界面解析 / 数据抓取) → 生产交付</span>
        </div>
        <span className="panel-count">{stages.length} 个智能体</span>
      </div>

      <div className="panel-content">
        <div className="flow-canvas">
          <div className="flow-stage flow-stage--single">
            <UserInputNode userInput={userInput} />
          </div>

          <LinearConnector />

          <div className="flow-stage flow-stage--single">{node('agent-business')}</div>

          <SplitConnector />

          <div className="flow-stage flow-stage--parallel">
            {node('agent-prototype')}
            {node('agent-data')}
          </div>

          <MergeConnector />

          <div className="flow-stage flow-stage--single">{node('agent-production')}</div>
        </div>
      </div>
    </div>
  )
}
