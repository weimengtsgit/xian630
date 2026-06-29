import { useAgents } from '../hooks/useAgents'
import {
  CheckCircle,
  Clock,
  StopCircle,
  Bot,
  User,
  Briefcase,
  Figma,
  BarChart3,
  Code2
} from 'lucide-react'
import './AgentsPanel.css'

// 流水线节点元信息：图标与职责描述
const AGENT_META = {
  'agent-business': { icon: Briefcase, desc: '业务流程建模 · 逻辑拆解' },
  'agent-prototype': { icon: Figma, desc: '界面结构 · 元素解析' },
  'agent-data': { icon: BarChart3, desc: '数据采集 · 字段抽取' },
  'agent-production': { icon: Code2, desc: '代码生成 · 工程交付' }
}

function getStatusInfo(status) {
  switch (status) {
    case 'working':
      return { color: '#68ddff', icon: Clock, text: '工作中', bgColor: 'rgba(104, 221, 255, 0.12)' }
    case 'completed':
      return { color: '#7feb9b', icon: CheckCircle, text: '已完成', bgColor: 'rgba(127, 235, 155, 0.12)' }
    case 'idle':
      return { color: '#8fb0bf', icon: StopCircle, text: '等待中', bgColor: 'rgba(143, 176, 191, 0.12)' }
    case 'error':
      return { color: '#ff665e', icon: null, text: '异常', bgColor: 'rgba(255, 102, 94, 0.12)' }
    default:
      return { color: '#a5bdca', icon: null, text: '未知', bgColor: 'rgba(165, 189, 202, 0.12)' }
  }
}

function AgentNode({ agent }) {
  const meta = AGENT_META[agent.id] || { icon: Bot, desc: '' }
  const Icon = meta.icon
  const statusInfo = getStatusInfo(agent.status)
  const StatusIcon = statusInfo.icon

  return (
    <div className="agent-node" data-agent-id={agent.id} data-status={agent.status}>
      <div className="agent-node-head">
        <div className="agent-node-icon" style={{ background: statusInfo.bgColor }}>
          <Icon size={30} style={{ color: statusInfo.color }} />
          {agent.status === 'working' && (
            <span className="agent-node-pulse" style={{ borderColor: statusInfo.color }} />
          )}
        </div>
        <div className="agent-node-titles">
          <div className="agent-node-name">{agent.name}</div>
          <div className="agent-node-type">{agent.type}</div>
        </div>
      </div>

      <div className="agent-node-desc">{meta.desc}</div>

      <div className="agent-node-status">
        {StatusIcon ? (
          <StatusIcon size={17} style={{ color: statusInfo.color }} />
        ) : (
          <span className="status-dot" style={{ background: statusInfo.color }} />
        )}
        <span style={{ color: statusInfo.color }}>{statusInfo.text}</span>
      </div>

      {agent.status === 'working' && (
        <div className="agent-node-task">
          <div className="agent-node-task-name">{agent.currentTask}</div>
          <div className="agent-node-progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${agent.progress}%` }} />
            </div>
            <span className="progress-percent">{agent.progress}%</span>
          </div>
        </div>
      )}

      {agent.status === 'idle' && (
        <div className="agent-node-wait">等待上游产出…</div>
      )}

      {agent.status === 'completed' && (
        <div className="agent-node-done">产出就绪 ✓</div>
      )}
    </div>
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
  const { agents, loading } = useAgents()
  const byId = (id) => agents.find((a) => a.id === id)

  if (loading) {
    return (
      <div className="agents-panel">
        <div className="panel-header">
          <h2>智能体流水线</h2>
        </div>
        <div className="panel-loading">加载中...</div>
      </div>
    )
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>智能体流水线</h2>
          <span className="panel-subtitle">用户输入 → 业务逻辑 → 并行(界面解析 / 数据抓取) → 生产交付</span>
        </div>
        <span className="panel-count">{agents.length} 个智能体</span>
      </div>

      <div className="panel-content">
        <div className="flow-canvas">
          <div className="flow-stage flow-stage--single">
            <UserInputNode userInput={userInput} />
          </div>

          <LinearConnector />

          <div className="flow-stage flow-stage--single">
            <AgentNode agent={byId('agent-business')} />
          </div>

          <SplitConnector />

          <div className="flow-stage flow-stage--parallel">
            <AgentNode agent={byId('agent-prototype')} />
            <AgentNode agent={byId('agent-data')} />
          </div>

          <MergeConnector />

          <div className="flow-stage flow-stage--single">
            <AgentNode agent={byId('agent-production')} />
          </div>
        </div>
      </div>
    </div>
  )
}
