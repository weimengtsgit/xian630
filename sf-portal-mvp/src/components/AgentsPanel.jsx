import { useMemo, useState } from 'react'
import { Bot, Check, Pencil, Plus, Power, Save, Send, X } from 'lucide-react'
import { applySelectedBusinessAgents, splitAgentsByCategory } from '../hooks/agentList'
import './AgentsPanel.css'

const emptyEditForm = {
  name: '',
  description: '',
  prompt: '',
  enabled: true,
}

const emptyAuthoringState = {
  session: null,
  messages: [],
  input: '',
  error: '',
  saving: false,
}

function agentIdentity(agent) {
  return agent?.id || agent?.key || agent?.agent_key || ''
}

function agentKey(agent) {
  return agent?.key || agent?.agent_key || agent?.id || ''
}

function isEnabled(agent) {
  return agent?.enabled === undefined ? true : Boolean(agent.enabled)
}

function parseDraft(session) {
  if (!session?.draft_json) return null
  try {
    return JSON.parse(session.draft_json)
  } catch {
    return null
  }
}

function promptText(agent) {
  return agent?.prompt || agent?.final_prompt || '暂无提示词'
}

function tabLabel(tab) {
  return tab === 'software' ? '软件开发智能体' : '业务智能体'
}

export function AgentsPanel({
  agents,
  softwareAgents,
  businessAgents,
  loading,
  error,
  selectedBusinessAgentIds = [],
  onAddBusinessAgent,
  onRemoveBusinessAgent,
  onCreateAuthoringSession,
  onSendAuthoringMessage,
  onFinalizeAuthoring,
  onUpdateBusinessAgent,
  onSetBusinessAgentEnabled,
}) {
  const [activeTab, setActiveTab] = useState('software')
  const [selectedId, setSelectedId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState(emptyEditForm)
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [authoringOpen, setAuthoringOpen] = useState(false)
  const [authoring, setAuthoring] = useState(emptyAuthoringState)
  const [panelError, setPanelError] = useState('')

  const splitFallback = useMemo(() => splitAgentsByCategory(agents), [agents])
  const softwareList = useMemo(
    () => (Array.isArray(softwareAgents) ? softwareAgents : splitFallback.software),
    [softwareAgents, splitFallback.software],
  )
  const businessBaseList = useMemo(
    () => (Array.isArray(businessAgents) ? businessAgents : splitFallback.business),
    [businessAgents, splitFallback.business],
  )
  const businessList = useMemo(
    () => applySelectedBusinessAgents(businessBaseList, selectedBusinessAgentIds),
    [businessBaseList, selectedBusinessAgentIds],
  )
  const currentList = activeTab === 'software' ? softwareList : businessList

  const selectedAgent = useMemo(() => {
    const all = [...softwareList, ...businessList]
    return all.find(agent => agentIdentity(agent) === selectedId)
  }, [softwareList, businessList, selectedId])

  const selectedCount = selectedBusinessAgentIds.length
  const draft = parseDraft(authoring.session)
  const canFinalize = authoring.session?.status === 'ready_to_save' && draft?.prompt

  const openAgentDetail = agent => {
    setPanelError('')
    setEditError('')
    setEditing(false)
    setSelectedId(agentIdentity(agent))
    setDetailOpen(true)
  }

  const closeAgentDetail = () => {
    if (editSaving) return
    setDetailOpen(false)
    setEditing(false)
    setEditError('')
  }

  const startEditing = () => {
    if (!selectedAgent || selectedAgent.category === 'software' || selectedAgent.editable === false) return
    setEditForm({
      name: selectedAgent.name || '',
      description: selectedAgent.description || '',
      prompt: selectedAgent.prompt || '',
      enabled: isEnabled(selectedAgent),
    })
    setEditError('')
    setEditing(true)
  }

  const updateEditForm = (field, value) => {
    setEditForm(current => ({ ...current, [field]: value }))
  }

  const saveBusinessAgent = async event => {
    event.preventDefault()
    if (!selectedAgent || !onUpdateBusinessAgent) return
    const name = editForm.name.trim()
    const prompt = editForm.prompt.trim()
    if (!name || !prompt) {
      setEditError('请填写名称和最终提示词')
      return
    }
    setEditSaving(true)
    setEditError('')
    try {
      const updated = await onUpdateBusinessAgent(selectedAgent.id, {
        name,
        description: editForm.description.trim(),
        prompt,
        enabled: editForm.enabled,
      })
      setSelectedId(updated.id || selectedAgent.id)
      setEditing(false)
    } catch (err) {
      setEditError(err.message || String(err))
    } finally {
      setEditSaving(false)
    }
  }

  const toggleBusinessAgentEnabled = async agent => {
    if (!agent?.id || !onSetBusinessAgentEnabled) return
    setPanelError('')
    try {
      await onSetBusinessAgentEnabled(agent.id, !isEnabled(agent))
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const addBusinessAgent = async agent => {
    if (!agent?.id || !onAddBusinessAgent || !isEnabled(agent)) return
    setPanelError('')
    try {
      const next = await onAddBusinessAgent(agent)
      if (Array.isArray(next) && !next.some(item => item.id === agent.id)) {
        setPanelError('请先在会话工作台创建或选择一个会话，再加入业务智能体')
      }
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const removeBusinessAgent = async agent => {
    if (!agent?.id || !onRemoveBusinessAgent) return
    setPanelError('')
    try {
      await onRemoveBusinessAgent(agent.id)
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const openAuthoringDialog = async () => {
    setPanelError('')
    setAuthoring({ ...emptyAuthoringState, saving: true })
    setAuthoringOpen(true)
    try {
      const session = await onCreateAuthoringSession?.({ mode: 'create' })
      setAuthoring({ ...emptyAuthoringState, session })
    } catch (err) {
      setAuthoring({
        ...emptyAuthoringState,
        error: err.message || String(err),
      })
    }
  }

  const closeAuthoringDialog = () => {
    if (authoring.saving) return
    setAuthoringOpen(false)
    setAuthoring(emptyAuthoringState)
  }

  const submitAuthoringMessage = async event => {
    event.preventDefault()
    const content = authoring.input.trim()
    if (!content || !authoring.session?.id || !onSendAuthoringMessage) return
    const messages = [...authoring.messages, { role: 'user', content }]
    setAuthoring(current => ({ ...current, messages, input: '', saving: true, error: '' }))
    try {
      const session = await onSendAuthoringMessage(authoring.session.id, content)
      setAuthoring({
        ...emptyAuthoringState,
        session,
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: '已根据本轮信息更新业务智能体预览，可以继续补充约束或保存智能体。',
          },
        ],
      })
    } catch (err) {
      setAuthoring(current => ({
        ...current,
        saving: false,
        error: err.message || String(err),
      }))
    }
  }

  const finalizeAuthoring = async () => {
    if (!authoring.session?.id || !onFinalizeAuthoring) return
    setAuthoring(current => ({ ...current, saving: true, error: '' }))
    try {
      const created = await onFinalizeAuthoring(authoring.session.id)
      setSelectedId(created.id || created.key)
      setAuthoringOpen(false)
      setAuthoring(emptyAuthoringState)
      setActiveTab('business')
      setDetailOpen(true)
    } catch (err) {
      setAuthoring(current => ({
        ...current,
        saving: false,
        error: err.message || String(err),
      }))
    }
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2>智能体</h2>
        <div className="agents-header-actions">
          <span className="panel-count">
            {activeTab === 'software' ? softwareList.length : businessList.length} 个
          </span>
          {activeTab === 'business' && (
            <button
              type="button"
              className="agent-icon-button"
              onClick={openAuthoringDialog}
              title="创建业务智能体"
              aria-label="创建业务智能体"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="agent-tabs" role="tablist" aria-label="智能体分类">
        {['software', 'business'].map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`agent-tab ${activeTab === tab ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tabLabel(tab)}
            <span>{tab === 'software' ? softwareList.length : businessList.length}</span>
          </button>
        ))}
      </div>

      {activeTab === 'business' && selectedCount > 0 && (
        <div className="agent-selection-summary">本次会话已选择 {selectedCount} 个业务智能体</div>
      )}

      {(error || panelError) && (
        <div className="panel-error">{error ? `加载失败：${error}` : panelError}</div>
      )}

      <div className="panel-content">
        {loading && currentList.length === 0 ? (
          <div className="panel-loading">加载中...</div>
        ) : currentList.length === 0 ? (
          <div className="panel-loading">
            {error ? '无法连接到工厂服务' : `暂无${tabLabel(activeTab)}`}
          </div>
        ) : (
          <div className="agents-list">
            {currentList.map(agent => {
              const key = agentKey(agent)
              const enabled = isEnabled(agent)
              const selectedForConversation = Boolean(agent.isSelectedForConversation)
              return (
                <article
                  key={agentIdentity(agent)}
                  className={`agent-card ${enabled ? 'is-enabled' : 'is-disabled'} ${
                    selectedAgent?.id === agent.id ? 'is-selected' : ''
                  } ${selectedForConversation ? 'is-conversation-selected' : ''}`}
                >
                  <button
                    type="button"
                    className="agent-card-main"
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
                      {agent.description && <p className="agent-desc">{agent.description}</p>}
                    </div>
                  </button>

                  {activeTab === 'business' && (
                    <div className="agent-card-actions">
                      {selectedForConversation && (
                        <span className="agent-priority-badge">第 {agent.selectedPriority} 位</span>
                      )}
                      {selectedForConversation ? (
                        <button
                          type="button"
                          className="agent-secondary-button compact"
                          onClick={() => removeBusinessAgent(agent)}
                        >
                          移出会话
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="agent-primary-button compact"
                          onClick={() => addBusinessAgent(agent)}
                          disabled={!enabled}
                        >
                          加入会话
                        </button>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {detailOpen && selectedAgent && (
        <div className="agent-dialog-backdrop" role="presentation">
          <section className="agent-dialog agent-detail-dialog" role="dialog" aria-modal="true">
            <div className="agent-dialog-header">
              <h3>{selectedAgent.name || agentKey(selectedAgent)}</h3>
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
              <span className="agent-detail-subtitle">
                {selectedAgent.category === 'software' ? '只读软件开发智能体' : '业务智能体详情'}
              </span>
              <span
                className={`agent-enabled-badge ${selectedAgent.enabled === false ? 'off' : 'on'}`}
              >
                {selectedAgent.enabled === false ? '停用' : '启用'}
              </span>
            </div>

            {!editing ? (
              <>
                <dl className="agent-detail-grid">
                  <div>
                    <dt>标识</dt>
                    <dd>{agentKey(selectedAgent) || '-'}</dd>
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
                <div className="agent-prompt-section">
                  <h4>最终提示词</h4>
                  <pre className="agent-skills">{promptText(selectedAgent)}</pre>
                </div>
                {selectedAgent.category === 'business' && (
                  <div className="agent-dialog-actions">
                    <button
                      type="button"
                      className="agent-secondary-button"
                      onClick={() => toggleBusinessAgentEnabled(selectedAgent)}
                    >
                      <Power size={14} />
                      {isEnabled(selectedAgent) ? '停用' : '启用'}
                    </button>
                    <button type="button" className="agent-primary-button" onClick={startEditing}>
                      <Pencil size={14} />
                      编辑
                    </button>
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={saveBusinessAgent}>
                <label className="agent-field">
                  <span>名称</span>
                  <input
                    value={editForm.name}
                    onChange={event => updateEditForm('name', event.target.value)}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-field">
                  <span>标识</span>
                  <input value={agentKey(selectedAgent)} disabled />
                </label>
                <label className="agent-field">
                  <span>描述</span>
                  <textarea
                    value={editForm.description}
                    onChange={event => updateEditForm('description', event.target.value)}
                    rows={3}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-field">
                  <span>最终提示词</span>
                  <textarea
                    value={editForm.prompt}
                    onChange={event => updateEditForm('prompt', event.target.value)}
                    rows={7}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-toggle">
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={event => updateEditForm('enabled', event.target.checked)}
                    disabled={editSaving}
                  />
                  <span>启用</span>
                </label>
                {editError && <div className="agent-form-error">{editError}</div>}
                <div className="agent-dialog-actions">
                  <button
                    type="button"
                    className="agent-secondary-button"
                    onClick={() => setEditing(false)}
                    disabled={editSaving}
                  >
                    取消
                  </button>
                  <button type="submit" className="agent-primary-button" disabled={editSaving}>
                    <Save size={14} />
                    {editSaving ? '保存中...' : '保存'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {authoringOpen && (
        <div className="agent-dialog-backdrop" role="presentation">
          <section className="agent-dialog agent-authoring-dialog" role="dialog" aria-modal="true">
            <div className="agent-dialog-header">
              <h3>创建业务智能体</h3>
              <button
                type="button"
                className="agent-icon-button"
                onClick={closeAuthoringDialog}
                title="关闭"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="authoring-thread">
              <div className="authoring-message assistant">
                请描述这个业务智能体要关注的业务场景、判断标准、输出边界和禁忌。我会生成名称、标识和最终提示词。
              </div>
              {authoring.messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`authoring-message ${message.role}`}
                >
                  {message.content}
                </div>
              ))}
              {draft && (
                <div className="authoring-draft">
                  <div className="agent-detail-title">
                    <span className="agent-detail-subtitle">生成预览</span>
                    <span className="agent-enabled-badge on">待保存</span>
                  </div>
                  <dl className="agent-detail-grid">
                    <div>
                      <dt>名称</dt>
                      <dd>{draft.name || '-'}</dd>
                    </div>
                    <div>
                      <dt>标识</dt>
                      <dd>{draft.key || '-'}</dd>
                    </div>
                  </dl>
                  <p className="agent-detail-desc">{draft.description || '-'}</p>
                  <pre className="agent-skills">{draft.prompt || '暂无提示词'}</pre>
                </div>
              )}
            </div>

            <form className="authoring-input-row" onSubmit={submitAuthoringMessage}>
              <textarea
                value={authoring.input}
                onChange={event =>
                  setAuthoring(current => ({ ...current, input: event.target.value }))
                }
                rows={4}
                disabled={authoring.saving}
                placeholder="例如：创建海事预警专家，关注 AIS 异常航迹、越界、停留超时，并给出风险等级和处置建议"
              />
              <button
                type="submit"
                className="agent-icon-button"
                disabled={authoring.saving || !authoring.input.trim()}
                title="发送"
                aria-label="发送"
              >
                <Send size={16} />
              </button>
            </form>

            {authoring.error && <div className="agent-form-error">{authoring.error}</div>}

            <div className="agent-dialog-actions">
              <button
                type="button"
                className="agent-secondary-button"
                onClick={closeAuthoringDialog}
                disabled={authoring.saving}
              >
                取消
              </button>
              <button
                type="button"
                className="agent-primary-button"
                onClick={finalizeAuthoring}
                disabled={authoring.saving || !canFinalize}
              >
                <Check size={14} />
                保存智能体
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
