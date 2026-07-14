import { useState } from 'react'
import { Plus, FolderOpen, Clock, Trash2 } from 'lucide-react'
import './ProjectNav.css'

function formatTime(ts) {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

export function ProjectNav({ projects, selectedId, onNewProject, onSelectProject, onDeleteProject }) {
  const list = Array.isArray(projects) ? projects : []
  const [pendingDelete, setPendingDelete] = useState(null)
  const [creating, setCreating] = useState(false)
  const [nameInput, setNameInput] = useState('')

  async function confirmDelete() {
    if (!pendingDelete) return
    await onDeleteProject(pendingDelete.id)
    setPendingDelete(null)
  }

  return (
    <aside className="project-nav" aria-label="项目列表">
      <div className="project-nav-header">
        <span className="project-nav-title">项目列表</span>
        <button
          type="button"
          className="project-nav-new"
          onClick={() => { setCreating(true); setNameInput('') }}
          title="新建项目"
        >
          <Plus size={16} />
          <span>新建项目</span>
        </button>
      </div>

      {creating && (
        <div className="project-nav-create">
          <input
            type="text"
            className="project-nav-create-input"
            placeholder="输入项目名称…"
            value={nameInput}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameInput.trim()) { onNewProject(nameInput.trim()); setCreating(false); setNameInput('') }
              if (e.key === 'Escape') { setCreating(false); setNameInput('') }
            }}
          />
          <div className="project-nav-create-actions">
            <button
              type="button"
              className="project-nav-create-ok"
              disabled={!nameInput.trim()}
              onClick={() => { onNewProject(nameInput.trim()); setCreating(false); setNameInput('') }}
            >
              确定
            </button>
            <button
              type="button"
              className="project-nav-create-cancel"
              onClick={() => { setCreating(false); setNameInput('') }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="project-nav-list">
        {list.length === 0 ? (
          <div className="project-nav-empty">
            <FolderOpen size={32} />
            <span>暂无项目</span>
          </div>
        ) : (
          list.map((proj) => (
            <div
              key={proj.id}
              className={`project-nav-row${selectedId === proj.id ? ' is-selected' : ''}${pendingDelete?.id === proj.id ? ' is-deleting' : ''}`}
            >
              <button
                type="button"
                className="project-nav-row-main"
                onClick={() => onSelectProject(proj)}
              >
                <div className="project-nav-row-name">{proj.name}</div>
                <div className="project-nav-row-meta">
                  <Clock size={11} />
                  <span>{formatTime(proj.createdAt)}</span>
                  <span className="project-nav-row-code">{proj.projectname}</span>
                </div>
              </button>
              <button
                type="button"
                className="project-nav-del"
                title="删除项目"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(proj) }}
              >
                <Trash2 size={13} />
              </button>

              {pendingDelete?.id === proj.id && (
                <div className="project-nav-confirm">
                  <span className="project-nav-confirm-text">删除"{proj.name}"？</span>
                  <div className="project-nav-confirm-btns">
                    <button type="button" className="project-nav-confirm-yes" onClick={confirmDelete}>删除</button>
                    <button type="button" className="project-nav-confirm-no" onClick={() => setPendingDelete(null)}>取消</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
