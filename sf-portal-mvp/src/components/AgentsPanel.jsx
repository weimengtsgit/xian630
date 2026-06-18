import { Bot } from 'lucide-react'
import './AgentsPanel.css'

export function AgentsPanel({ agents, loading, error }) {
  const list = Array.isArray(agents) ? agents : []

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2>智能体</h2>
        <span className="panel-count">{list.length} 个</span>
      </div>

      {error && <div className="panel-error">加载失败：{error}</div>}

      <div className="panel-content">
        {loading && list.length === 0 ? (
          <div className="panel-loading">加载中...</div>
        ) : list.length === 0 ? (
          <div className="panel-loading">{error ? '无法连接到工厂服务' : '暂无智能体'}</div>
        ) : (
          <div className="agents-list">
            {list.map(agent => {
              const key = agent.key || agent.agent_key || agent.id
              const enabled =
                agent.enabled === undefined ? true : Boolean(agent.enabled)
              return (
                <div
                  key={agent.id || key}
                  className={`agent-card ${enabled ? 'is-enabled' : 'is-disabled'}`}
                >
                  <div className="agent-avatar">
                    <Bot size={20} />
                  </div>
                  <div className="agent-info">
                    <div className="agent-name-row">
                      <h3 className="agent-name">{agent.name || key}</h3>
                      <span className={`agent-enabled-badge ${enabled ? 'on' : 'off'}`}>
                        {enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    <div className="agent-meta">
                      <span className="agent-key">{key}</span>
                      {agent.role && <span className="agent-role">{agent.role}</span>}
                    </div>
                    {agent.description && (
                      <p className="agent-desc">{agent.description}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
