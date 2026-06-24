import { useMemo, useState } from 'react'
import { Bot, Plus, X } from 'lucide-react'
import './AgentsPanel.css'

const emptyForm = {
  key: '',
  name: '',
  role: '',
  description: '',
  claude_agent_name: '',
  skills_json: '[]',
  enabled: true,
}

export function AgentsPanel({ agents, loading, error, onCreateAgent }) {
  const list = Array.isArray(agents) ? agents : []
  const [selectedId, setSelectedId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const selectedAgent = useMemo(
    () => list.find(agent => (agent.id || agent.key || agent.agent_key) === selectedId),
    [list, selectedId]
  )

  const updateForm = (field, value) => {
    setForm(current => ({ ...current, [field]: value }))
  }

  const openCreateDialog = () => {
    setForm(emptyForm)
    setFormError('')
    setDialogOpen(true)
  }

  const openAgentDetail = agent => {
    const key = agent.key || agent.agent_key || agent.id
    setSelectedId(agent.id || key)
    setDetailOpen(true)
  }

  const closeAgentDetail = () => {
    setDetailOpen(false)
  }

  const closeCreateDialog = () => {
    if (saving) return
    setDialogOpen(false)
    setFormError('')
  }

  const submitAgent = async event => {
    event.preventDefault()
    setFormError('')
    if (!onCreateAgent) {
      setFormError('当前服务不支持新增智能体')
      return
    }

    const payload = {
      key: form.key.trim(),
      name: form.name.trim(),
      role: form.role.trim(),
      description: form.description.trim(),
      claude_agent_name: form.claude_agent_name.trim(),
      skills_json: form.skills_json.trim() || '[]',
      enabled: form.enabled,
    }
    if (!payload.key || !payload.name || !payload.role) {
      setFormError('请填写名称、Key 和角色')
      return
    }
    try {
      JSON.parse(payload.skills_json)
    } catch {
      setFormError('Skills JSON 格式不正确')
      return
    }

    setSaving(true)
    try {
      const created = await onCreateAgent(payload)
      setSelectedId(created.id || created.key)
      setDialogOpen(false)
      setDetailOpen(true)
      setForm(emptyForm)
    } catch (err) {
      setFormError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2>软件开发</h2>
        <div className="agents-header-actions">
          <span className="panel-count">{list.length} 个</span>
          <button
            type="button"
            className="agent-icon-button"
            onClick={openCreateDialog}
            title="新增智能体"
            aria-label="新增智能体"
          >
            <Plus size={16} />
          </button>
        </div>
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
                <button
                  key={agent.id || key}
                  type="button"
                  className={`agent-card ${enabled ? 'is-enabled' : 'is-disabled'} ${
                    selectedAgent === agent ? 'is-selected' : ''
                  }`}
                  onClick={() => openAgentDetail(agent)}
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
                </button>
              )
            })}
          </div>
        )}
      </div>

      {detailOpen && selectedAgent && (
        <div className="agent-dialog-backdrop" role="presentation">
          <section className="agent-dialog agent-detail-dialog" role="dialog" aria-modal="true">
            <div className="agent-dialog-header">
              <h3>{selectedAgent.name || selectedAgent.key}</h3>
              <button
                type="button"
                className="agent-icon-button"
                onClick={closeAgentDetail}
                title="关闭"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="agent-detail-title">
              <span className="agent-detail-subtitle">智能体详情</span>
              <span
                className={`agent-enabled-badge ${
                  selectedAgent.enabled === false ? 'off' : 'on'
                }`}
              >
                {selectedAgent.enabled === false ? '停用' : '启用'}
              </span>
            </div>
            <dl className="agent-detail-grid">
              <div>
                <dt>Key</dt>
                <dd>{selectedAgent.key || selectedAgent.agent_key || '-'}</dd>
              </div>
              <div>
                <dt>角色</dt>
                <dd>{selectedAgent.role || '-'}</dd>
              </div>
              <div>
                <dt>Claude Agent</dt>
                <dd>{selectedAgent.claude_agent_name || '-'}</dd>
              </div>
              <div>
                <dt>排序</dt>
                <dd>{selectedAgent.sort_order ?? '-'}</dd>
              </div>
            </dl>
            {selectedAgent.description && (
              <p className="agent-detail-desc">{selectedAgent.description}</p>
            )}
            {selectedAgent.skills_json && (
              <pre className="agent-skills">{selectedAgent.skills_json}</pre>
            )}
          </section>
        </div>
      )}

      {dialogOpen && (
        <div className="agent-dialog-backdrop" role="presentation">
          <form className="agent-dialog" onSubmit={submitAgent} role="dialog" aria-modal="true">
            <div className="agent-dialog-header">
              <h3>新增智能体</h3>
              <button
                type="button"
                className="agent-icon-button"
                onClick={closeCreateDialog}
                title="关闭"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <label className="agent-field">
              <span>名称</span>
              <input
                value={form.name}
                onChange={event => updateForm('name', event.target.value)}
                placeholder="例如：评审智能体"
                disabled={saving}
              />
            </label>
            <label className="agent-field">
              <span>Key</span>
              <input
                value={form.key}
                onChange={event => updateForm('key', event.target.value)}
                placeholder="review-agent"
                disabled={saving}
              />
            </label>
            <label className="agent-field">
              <span>角色</span>
              <input
                value={form.role}
                onChange={event => updateForm('role', event.target.value)}
                placeholder="reviewer"
                disabled={saving}
              />
            </label>
            <label className="agent-field">
              <span>Claude Agent</span>
              <input
                value={form.claude_agent_name}
                onChange={event => updateForm('claude_agent_name', event.target.value)}
                placeholder="默认使用 Key"
                disabled={saving}
              />
            </label>
            <label className="agent-field">
              <span>描述</span>
              <textarea
                value={form.description}
                onChange={event => updateForm('description', event.target.value)}
                rows={3}
                disabled={saving}
              />
            </label>
            <label className="agent-field">
              <span>Skills JSON</span>
              <textarea
                value={form.skills_json}
                onChange={event => updateForm('skills_json', event.target.value)}
                rows={3}
                disabled={saving}
              />
            </label>
            <label className="agent-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={event => updateForm('enabled', event.target.checked)}
                disabled={saving}
              />
              <span>启用</span>
            </label>

            {formError && <div className="agent-form-error">{formError}</div>}

            <div className="agent-dialog-actions">
              <button
                type="button"
                className="agent-secondary-button"
                onClick={closeCreateDialog}
                disabled={saving}
              >
                取消
              </button>
              <button type="submit" className="agent-primary-button" disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
