import { useAgents } from '../hooks/useAgents'
import { Play, StopCircle, CheckCircle, Clock, Bot, Pause, Plus, X } from 'lucide-react'
import { useState } from 'react'
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

// 创建智能体弹窗组件
function CreateAgentModal({ isOpen, onClose, onSubmit }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    model: '',
    instruction: '',
    skills: ''
  })

  if (!isOpen) return null

  const handleSubmit = (e) => {
    e.preventDefault()
    if (formData.name && formData.model && formData.instruction) {
      onSubmit(formData)
      setFormData({
        name: '',
        description: '',
        model: '',
        instruction: '',
        skills: ''
      })
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-left">
            <h3>创建智能体</h3>
            <p className="modal-description">在工作区创建一个新的 AI 智能体。</p>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form className="modal-body" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>名称 <span className="required">*</span></label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="例如：深度研究智能体"
              required
            />
          </div>

          <div className="form-group">
            <label>描述</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="这个智能体做什么？"
              rows={3}
            />
          </div>

          <div className="form-group">
            <label>模型 <span className="required">*</span></label>
            <select
              value={formData.model}
              onChange={(e) => setFormData({ ...formData, model: e.target.value })}
              required
            >
              <option value="">请选择模型</option>
              <option value="claude-3-opus">Claude 3 Opus</option>
              <option value="claude-3-sonnet">Claude 3 Sonnet</option>
              <option value="gpt-4">GPT-4</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            </select>
          </div>

          <div className="form-group">
            <label>指令 <span className="required">*</span></label>
            <textarea
              value={formData.instruction}
              onChange={(e) => setFormData({ ...formData, instruction: e.target.value })}
              placeholder="描述这个智能体应该如何工作..."
              rows={5}
              required
            />
          </div>

          <div className="form-group">
            <label>SKILLS</label>
            <div className="select-with-icon">
              <select
                value={formData.skills}
                onChange={(e) => setFormData({ ...formData, skills: e.target.value })}
              >
                <option value="">从工作区添加 skill</option>
                <option value="web-search">Web Search</option>
                <option value="code-executor">Code Executor</option>
                <option value="file-browser">File Browser</option>
              </select>
              <Plus size={14} />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="modal-btn cancel-btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="modal-btn submit-btn">
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function AgentsPanel() {
  const { agents, loading, assignTask, stopAgent, createAgent } = useAgents()
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)

  const handleCreateAgent = (data) => {
    createAgent(data.name, data.type || '开发助手')
    setIsCreateModalOpen(false)
  }

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
        <div className="panel-header-actions">
          <span className="panel-count">{agents.length} 个智能体</span>
          <button className="create-agent-btn" onClick={() => setIsCreateModalOpen(true)}>
            <Plus size={16} />
            创建
          </button>
        </div>
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

      <CreateAgentModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateAgent}
      />
    </div>
  )
}
