import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  MessageSquarePlus,
  Trash2,
  X,
} from 'lucide-react'
import { statusText, titleForDialogue } from '../hooks/dialogueTimeline'
import './SessionNav.css'

// Conservative height budget for the delete-confirm popover (~150–170px card
// + padding + shadow). Used to decide whether opening the popover BELOW the
// clicked row would overflow either the viewport OR the .session-nav-list
// scroll container's visible area; if so the popover flips to sit ABOVE the
// row so it stays fully visible (会话删除确认浮层: clamped to rail, never
// clipped by the list's scroll box — overflow-y:auto makes overflow-x compute
// to auto too, so anything past the list's visible bottom is clipped).
const POPOVER_FLIP_BUDGET = 200

// SessionNav is the left 会话导航栏: a collapsible rail that owns the new-session
// action and the historical-dialogue list (moved here from ConversationWorkbench's
// top header buttons + its DialogueHistoryDrawer in Phase 1 of the workbench-drawer
// migration).
//
// The history list reuses the same delete-confirm pattern the old
// DialogueHistoryDrawer used (in-app confirm card, never window.confirm). Each row
// shows the dialogue title, status, updated_at, summary, and resolved outcome.
export function SessionNav({
  sessions,
  selectedId,
  collapsed,
  onToggleCollapse,
  onNewSession,
  onSelect,
  onDeleteSession,
  deletingDialogueId,
}) {
  const list = Array.isArray(sessions) ? sessions : []
  const [pendingDelete, setPendingDelete] = useState(null)
  // `flipUp` is set when the clicked row sits near the bottom of the viewport OR
  // the .session-nav-list scroll container's visible area — the popover then opens
  // ABOVE the row instead of below so it is never clipped by the list's scroll box.
  const [flipUp, setFlipUp] = useState(false)
  const pendingTitle = pendingDelete ? titleForDialogue(pendingDelete.session || pendingDelete) : ''
  const confirmingDelete = pendingDelete && deletingDialogueId === (pendingDelete.session && pendingDelete.session.id)

  // Drop a pending-delete card once the session disappears from the list, so a
  // successful delete (or a concurrent one) closes the confirm card on its own.
  useEffect(() => {
    if (!pendingDelete) return
    const pid = pendingDelete.session && pendingDelete.session.id
    if (!list.some(v => v.session && v.session.id === pid)) setPendingDelete(null)
  }, [pendingDelete, list.map(v => v.session && v.session.id).join('|')])

  const requestDelete = (entry, clickEvent) => {
    const sess = entry && entry.session
    if (!sess) return
    // Decide whether the popover would overflow the viewport OR the
    // .session-nav-list scroll container's visible bottom if it opened below
    // the clicked row. The card is ~150–170px tall; we measure the space
    // below the click target against BOTH constraints and take the binding one
    // (min). The list scroll box (overflow-y:auto → overflow-x:auto too) clips
    // anything past its visible bottom, so a row that is fine relative to the
    // viewport can still have its popover clipped by a short / non-full-height
    // list — the container-aware check fixes that. If it would be clipped, flip
    // the popover to sit ABOVE the row.
    const target = clickEvent && clickEvent.currentTarget
    let flip = false
    if (target && typeof target.getBoundingClientRect === 'function') {
      const rect = target.getBoundingClientRect()
      const viewportSpaceBelow = (window.innerHeight || document.documentElement.clientHeight) - rect.bottom
      let spaceBelow = viewportSpaceBelow
      // The popover renders inside .session-nav-row inside .session-nav-list;
      // the list's visible bottom is the real clipping edge when the rail is
      // shorter than the viewport.
      const listEl = target.closest && target.closest('.session-nav-list')
      if (listEl && typeof listEl.getBoundingClientRect === 'function') {
        const listRect = listEl.getBoundingClientRect()
        const listSpaceBelow = listRect.bottom - rect.bottom
        if (listSpaceBelow < spaceBelow) spaceBelow = listSpaceBelow
      }
      if (spaceBelow < POPOVER_FLIP_BUDGET) flip = true
    }
    setFlipUp(flip)
    setPendingDelete(entry)
  }

  const confirmDelete = async () => {
    if (!pendingDelete || confirmingDelete) return
    const sess = pendingDelete.session
    if (!sess) return
    try {
      await onDeleteSession(sess.id)
      setPendingDelete(null)
      setFlipUp(false)
    } catch (_) {
      // The dialogue hook surfaces the error in the workbench error bar.
    }
  }

  const cancelDelete = () => {
    setPendingDelete(null)
    setFlipUp(false)
  }

  if (collapsed) {
    return (
      <aside className="session-nav session-nav-collapsed" aria-label="会话导航">
        <button
          type="button"
          className="session-nav-new session-nav-new-mini"
          onClick={onNewSession}
          title="新建会话"
          aria-label="新建会话"
        >
          <MessageSquarePlus size={18} />
        </button>
        <button
          type="button"
          className="session-nav-expand"
          onClick={onToggleCollapse}
          title="展开会话导航"
          aria-label="展开会话导航"
        >
          <ChevronRight size={16} />
          <span className="session-nav-expand-label">会话</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="session-nav" aria-label="会话导航">
      <header className="session-nav-header">
        <strong className="session-nav-title">会话导航</strong>
        <button
          type="button"
          className="session-nav-collapse"
          onClick={onToggleCollapse}
          title="收起会话导航"
          aria-label="收起会话导航"
        >
          <ChevronLeft size={16} />
        </button>
      </header>

      <div className="session-nav-actions">
        <button
          type="button"
          className="session-nav-new"
          onClick={onNewSession}
          title="新建会话"
          aria-label="新建会话"
        >
          <MessageSquarePlus size={14} />
          <span>新建会话</span>
        </button>
      </div>

      <div className="session-nav-list sf-scroll">
        {list.length === 0 ? (
          <div className="session-nav-empty">
            <History size={16} />
            <span>暂无历史会话</span>
          </div>
        ) : (
          list.map(entry => {
            const sess = entry && entry.session
            if (!sess) return null
            return (
              <div key={sess.id} className={`session-nav-row${sess.id === selectedId ? ' active' : ''}`}>
                <button
                  type="button"
                  className="session-nav-item"
                  onClick={() => onSelect(sess.id)}
                  title={titleForDialogue(sess)}
                >
                  <span className="session-nav-item-title">{titleForDialogue(sess)}</span>
                  <span className="session-nav-item-meta">
                    <em>{statusText(sess.status)}</em>
                    <time dateTime={sess.updated_at}>{formatSessionTime(sess.updated_at)}</time>
                  </span>
                  <small>{summaryForEntry(entry)}</small>
                  {resultForEntry(entry) ? <b className="session-nav-item-result">{resultForEntry(entry)}</b> : null}
                </button>
                <button
                  type="button"
                  className="session-nav-delete"
                  disabled={deletingDialogueId === sess.id}
                  onClick={e => requestDelete(entry, e)}
                  title="删除历史会话"
                  aria-label="删除历史会话"
                >
                  {deletingDialogueId === sess.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                </button>
                {pendingDelete && (pendingDelete.session && pendingDelete.session.id) === sess.id ? (
                  <div
                    className={`session-nav-delete-confirm${flipUp ? ' flip-up' : ''}`}
                    role="dialog"
                    aria-labelledby="session-nav-delete-title"
                  >
                    <div className="session-nav-delete-card">
                      <span className="session-nav-delete-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
                      <div className="session-nav-delete-copy">
                        <strong id="session-nav-delete-title">删除历史会话</strong>
                        <p>将删除「{pendingTitle}」的会话记录，不会删除已生成的智能体或 Agent。</p>
                      </div>
                      <div className="session-nav-delete-actions">
                        <button type="button" className="session-nav-delete-cancel" onClick={cancelDelete} disabled={confirmingDelete}>
                          <X size={12} /> 取消
                        </button>
                        <button type="button" className="session-nav-delete-danger" onClick={confirmDelete} disabled={confirmingDelete}>
                          {confirmingDelete ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}

function formatSessionTime(value) {
  if (!value) return '未更新'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function summaryForEntry(entry) {
  const child = entry && entry.child
  const req = (child && child.requirement) || {}
  const parts = [req.appType, req.coreScenario].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  const sess = entry && entry.session
  return (sess && sess.initial_prompt) || '暂无摘要'
}

function resultForEntry(entry) {
  if (!entry) return ''
  const sess = entry.session || {}
  if (entry.resolvedApplication) return entry.resolvedApplication.name || '应用已就绪'
  if (entry.createdAgent) return entry.createdAgent.name || 'Agent 已创建'
  if (entry.seededJob) return entry.seededJob.app_name ? `生成任务：${entry.seededJob.app_name}` : '生成任务已创建'
  if (sess.status === 'resolved') return '已完成'
  return ''
}
