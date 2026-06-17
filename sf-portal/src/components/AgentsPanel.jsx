import { useAgents } from '../hooks/useAgents'
import { Play, StopCircle, CheckCircle, Clock, Bot, Pause } from 'lucide-react'
import './AgentsPanel.css'

function getStatusInfo(status) {
  switch (status) {
    case 'working':
      return { color: '#68ddff', icon: Clock, text: '工作中', bgColor: 'rgba(104, 221, 255, 0.12)' }
    case 'completed':
      return { color: '#7feb9b', icon: CheckCircle, text: '已完成', bgColor: 'rgba(127, 235, 155, 0.12)' }
    case 'idle':
      return { color: '#8fb0bf', icon: StopCircle, text: '空闲', bgColor: 'rgba(143, 176, 191, 0.12)' }
    case 'error':
      return { color: '#ff665e', icon: null, text: '异常', bgColor: 'rgba(255, 102, 94, 0.12)' }
    default:
      return { color: '#a5bdca', icon: null, text: '未知', bgColor: 'rgba(165, 189, 202, 0.12)' }
  }
}

function formatTime(date) {
  const now = new Date()
  const diff = now - new Date(date)
  const minutes = Math.floor(diff / 60000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

export function AgentsPanel() {
  const { agents, loading, assignTask, stopAgent } = useAgents()

  if (loading) {
    return (
      <div className="agents-panel">
        <div className="panel-header">
          <h2>智能体协同</h2>
        </div>
        <div className="panel-loading">加载中...</div>
      </div>
    )
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2>智能体协同</h2>
        <span className="panel-count">{agents.length} 个智能体</span>
      </div>
      <div className="panel-content">
        <div className="agents-grid">
          {agents.map(agent => {
            const statusInfo = getStatusInfo(agent.status)
            const StatusIcon = statusInfo.icon

            return (
              <div key={agent.id} className="agent-card" data-status={agent.status}>
                <div className="agent-card-left">
                  <div className="agent-avatar-wrapper">
                    <div className="agent-avatar" style={{ background: statusInfo.bgColor }}>
                      <Bot size={28} style={{ color: statusInfo.color }} />
                    </div>
                    {agent.status === 'working' && (
                      <div className="working-indicator">
                        <span className="pulse-dot"></span>
                      </div>
                    )}
                  </div>
                  <div className="agent-info">
                    <h3 className="agent-name">{agent.name}</h3>
                    <div className="agent-type-badge">{agent.type}</div>
                  </div>
                </div>

                <div className="agent-card-center">
                  <div className="agent-status-row">
                    {StatusIcon && <StatusIcon size={16} style={{ color: statusInfo.color }} />}
                    <span className="agent-status-text" style={{ color: statusInfo.color }}>
                      {statusInfo.text}
                    </span>
                  </div>

                  {agent.status === 'working' && agent.currentTask && (
                    <div className="agent-task-info">
                      <div className="task-label">当前任务</div>
                      <div className="task-name">{agent.currentTask}</div>
                      <div className="task-progress-wrapper">
                        <div className="progress-track">
                          <div
                            className="progress-fill"
                            style={{ width: `${agent.progress}%` }}
                          />
                        </div>
                        <span className="progress-percent">{agent.progress}%</span>
                      </div>
                    </div>
                  )}

                  {agent.status === 'completed' && (
                    <div className="agent-completed-info">
                      ✓ 任务已完成
                    </div>
                  )}

                  {agent.status === 'idle' && (
                    <div className="agent-idle-info">
                      等待任务分配...
                    </div>
                  )}
                </div>

                <div className="agent-card-right">
                  <div className="agent-last-activity">
                    <span className="activity-label">最后活动</span>
                    <span className="activity-time">{formatTime(agent.lastActivity)}</span>
                  </div>

                  {agent.status === 'idle' && (
                    <button
                      className="agent-action-btn assign-btn"
                      onClick={() => assignTask(agent.id, '新任务')}
                    >
                      <Play size={14} />
                      分配任务
                    </button>
                  )}

                  {agent.status === 'working' && (
                    <button
                      className="agent-action-btn pause-btn"
                      onClick={() => stopAgent(agent.id)}
                    >
                      <Pause size={14} />
                      暂停
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
