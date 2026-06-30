import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { factoryApi } from '../api/client'

// InterfacePreviewModal renders the retained interface-preview manifest (F4) the
// design_contract step produces. The manifest holds the design contract's
// summary, designDocument, and assumedDataFields — NOT a runnable HTML preview
// (that is a separate, larger generation-capability follow-up, deferred). On
// open the modal FETCHES the manifest via getJobInterfacePreview and renders it
// readably so the user can inspect the proposed interface (spec #7). The retained
// snapshot also serves as acceptance evidence (spec #38).
//
// designDocument may be any shape (string, object, array). To stay robust to
// arbitrary shapes we render: a string as-is; an object's known sections
// (views/layout/components/notes) when present, with a JSON fallback for the
// rest; everything else as pretty-printed JSON in a scrollable <pre>.
export function InterfacePreviewModal({ artifact, jobId, onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })

  const resolvedJobId = (artifact && (artifact.jobId || artifact.job_id)) || jobId

  useEffect(() => {
    if (!artifact || !resolvedJobId) {
      setState({ status: 'error', data: null, error: '缺少任务上下文，无法加载界面预览。' })
      return
    }
    if (!artifact.id) {
      setState({ status: 'error', data: null, error: '界面预览产物标识缺失。' })
      return
    }
    let cancelled = false
    setState({ status: 'loading', data: null, error: '' })
    factoryApi
      .getJobInterfacePreview(resolvedJobId, artifact.id)
      .then(data => {
        if (cancelled) return
        setState({ status: 'ready', data, error: '' })
      })
      .catch(err => {
        if (cancelled) return
        const status = err && err.status
        const msg =
          status === 404
            ? '界面预览快照未找到，可能尚未生成或已失效。'
            : '界面预览加载失败，请稍后重试。'
        setState({ status: 'error', data: null, error: msg })
      })
    return () => {
      cancelled = true
    }
  }, [artifact && artifact.id, resolvedJobId])

  if (!artifact) return null
  const title = artifact.label || '界面预览'
  const { status, data, error } = state

  return (
    <div className="cw-doc-modal-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="cw-doc-modal cw-interface-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="关闭预览">
            <X size={16} />
          </button>
        </header>
        {status === 'loading' ? (
          <div className="cw-doc-rich cw-interface-loading">
            <Loader2 size={16} className="spin" />
            <span>加载中…</span>
          </div>
        ) : status === 'error' ? (
          <div className="cw-doc-rich cw-interface-error">
            <p>{error}</p>
          </div>
        ) : (
          <InterfacePreviewContent data={data} />
        )}
      </section>
    </div>
  )
}

function InterfacePreviewContent({ data }) {
  const summary = (data && data.summary) || ''
  const designDocument = data && data.designDocument
  const assumedDataFields =
    data && Array.isArray(data.assumedDataFields) ? data.assumedDataFields : []

  return (
    <div className="cw-doc-rich cw-interface-preview">
      {summary ? (
        <p className="cw-interface-summary">{String(summary)}</p>
      ) : null}
      <DesignDocumentView value={designDocument} />
      {assumedDataFields.length ? (
        <div className="cw-interface-fields">
          <h3>假定数据字段（预览假设，待数据契约确认）</h3>
          <ul className="cw-interface-field-list">
            {assumedDataFields.map((field, idx) => (
              <li key={idx} className="cw-interface-field-chip">
                {String(field)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

// DesignDocumentView renders the designDocument field robustly to any shape.
// Known keys (views/layout/components/notes) are rendered as labelled sections
// when present; any remaining object/array content falls back to pretty JSON.
function DesignDocumentView({ value }) {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'string') {
    return (
      <div className="cw-interface-section">
        <h3>设计说明</h3>
        <pre className="cw-interface-text">{value}</pre>
      </div>
    )
  }

  if (typeof value === 'object') {
    const sections = []
    const known = ['views', 'layout', 'components', 'notes']
    const seen = new Set()
    for (const key of known) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        seen.add(key)
        sections.push({ key, val: value[key] })
      }
    }
    const rest = Object.keys(value).filter(k => !seen.has(k))
    const rendered = sections.map(s => (
      <div key={s.key} className="cw-interface-section">
        <h3>{designLabel(s.key)}</h3>
        <DesignValue value={s.val} />
      </div>
    ))
    if (rest.length) {
      const leftover = {}
      for (const k of rest) leftover[k] = value[k]
      rendered.push(
        <div key="__rest" className="cw-interface-section">
          <h3>其他</h3>
          <pre className="cw-interface-json">{safeJson(leftover)}</pre>
        </div>,
      )
    }
    if (!rendered.length) {
      // Empty object/array — show the raw JSON so the user sees the shape.
      return (
        <div className="cw-interface-section">
          <h3>设计说明</h3>
          <pre className="cw-interface-json">{safeJson(value)}</pre>
        </div>
      )
    }
    return <>{rendered}</>
  }

  // Primitives (number/boolean) — render as a string.
  return (
    <div className="cw-interface-section">
      <h3>设计说明</h3>
      <pre className="cw-interface-text">{String(value)}</pre>
    </div>
  )
}

function DesignValue({ value }) {
  if (Array.isArray(value)) {
    if (!value.length) return <p className="cw-interface-empty">（无）</p>
    return (
      <ul className="cw-interface-list">
        {value.map((item, idx) => (
          <li key={idx} className="cw-interface-list-item">
            {typeof item === 'object' && item !== null ? (
              <pre className="cw-interface-json">{safeJson(item)}</pre>
            ) : (
              String(item)
            )}
          </li>
        ))}
      </ul>
    )
  }
  if (typeof value === 'object' && value !== null) {
    return <pre className="cw-interface-json">{safeJson(value)}</pre>
  }
  return <p className="cw-interface-text">{String(value)}</p>
}

function designLabel(key) {
  switch (key) {
    case 'views':
      return '界面视图'
    case 'layout':
      return '布局'
    case 'components':
      return '组件'
    case 'notes':
      return '说明'
    default:
      return key
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
