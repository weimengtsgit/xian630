import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText, Folder, Loader2 } from 'lucide-react'
import { factoryApi } from '../api/client'
import './ApplicationProjectPanel.css'

export function ApplicationProjectPanel({ applicationId, dialogueId, onDraftApplied }) {
  const [tree, setTree] = useState(null)
  const [treeError, setTreeError] = useState('')
  const [loadingTree, setLoadingTree] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [expanded, setExpanded] = useState({})
  const [mode, setMode] = useState('preview')
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftSaving, setDraftSaving] = useState(false)

  useEffect(() => {
    setTree(null)
    setTreeError('')
    setSelectedPath('')
    setPreview(null)
    if (!applicationId) return undefined
    let canceled = false
    setLoadingTree(true)
    factoryApi.getApplicationProjectTree(applicationId, dialogueId)
      .then(data => {
        if (canceled) return
        setTree(data)
        const nextExpanded = {}
        ;(data.groups || []).forEach(group => { nextExpanded[`group:${group.id}`] = !!group.defaultExpanded })
        setExpanded(nextExpanded)
        const first = firstFile(data.groups || [], node => node.path.endsWith('.md')) || firstFile(data.groups || [])
        if (first) setSelectedPath(first.path)
      })
      .catch(err => { if (!canceled) setTreeError(err.message || String(err)) })
      .finally(() => { if (!canceled) setLoadingTree(false) })
    return () => { canceled = true }
  }, [applicationId, dialogueId])

  useEffect(() => {
    setPreview(null)
    setPreviewError('')
    setMode('preview')
    if (!applicationId || !selectedPath) return undefined
    let canceled = false
    setLoadingPreview(true)
    factoryApi.getApplicationProjectFile(applicationId, selectedPath, dialogueId)
      .then(data => { if (!canceled) setPreview(data) })
      .catch(err => { if (!canceled) setPreviewError(err.message || String(err)) })
      .finally(() => { if (!canceled) setLoadingPreview(false) })
    return () => { canceled = true }
  }, [applicationId, selectedPath, dialogueId])

  const groups = useMemo(() => (tree && Array.isArray(tree.groups) ? tree.groups : []), [tree])
  const canEditDraft = !!(dialogueId && preview && preview.kind === 'markdown' && preview.checksum)
  const startDraft = () => {
    if (!canEditDraft || preview.draft?.isStale) return
    setDraftText(preview.draft && preview.draft.content ? preview.draft.content : preview.content || '')
    setEditing(true)
    setMode('source')
  }
  const saveDraft = async () => {
    if (!canEditDraft || draftSaving || preview.draft?.isStale) return
    setDraftSaving(true)
    try {
      await factoryApi.saveApplicationProjectDraft(applicationId, { dialogueId, path: preview.path, sourceChecksum: preview.checksum, content: draftText })
      const next = await factoryApi.getApplicationProjectFile(applicationId, preview.path, dialogueId)
      setPreview(next)
      setEditing(false)
    } finally {
      setDraftSaving(false)
    }
  }
  const discardDraft = async () => {
    if (!preview?.draft || draftSaving) return
    setDraftSaving(true)
    try {
      await factoryApi.discardApplicationProjectDraft(applicationId, { dialogueId, path: preview.path })
      const next = await factoryApi.getApplicationProjectFile(applicationId, preview.path, dialogueId)
      setPreview(next)
      setEditing(false)
    } finally {
      setDraftSaving(false)
    }
  }
  const applyDraft = async () => {
    if (!preview?.draft || preview.draft.isStale || draftSaving) return
    setDraftSaving(true)
    try {
      await factoryApi.applyApplicationProjectDraft(applicationId, { dialogueId, path: preview.path })
      const next = await factoryApi.getApplicationProjectFile(applicationId, preview.path, dialogueId)
      setPreview(next)
      setEditing(false)
      if (onDraftApplied) await onDraftApplied()
    } finally {
      setDraftSaving(false)
    }
  }
  const restartDraftFromCurrentSource = async () => {
    if (!preview?.draft || !preview.draft.isStale || draftSaving) return
    const currentSourceContent = preview.content || ''
    setDraftSaving(true)
    try {
      await factoryApi.saveApplicationProjectDraft(applicationId, { dialogueId, path: preview.path, sourceChecksum: preview.checksum, content: preview.content || '' })
      const next = await factoryApi.getApplicationProjectFile(applicationId, preview.path, dialogueId)
      setPreview(next)
      setDraftText(currentSourceContent)
      setEditing(true)
      setMode('source')
    } finally {
      setDraftSaving(false)
    }
  }
  const continueDraftFromStaleContent = async () => {
    if (!preview?.draft || !preview.draft.isStale || draftSaving) return
    const staleDraftContent = preview.draft.content
    setDraftSaving(true)
    try {
      await factoryApi.saveApplicationProjectDraft(applicationId, { dialogueId, path: preview.path, sourceChecksum: preview.checksum, content: staleDraftContent || '' })
      const next = await factoryApi.getApplicationProjectFile(applicationId, preview.path, dialogueId)
      setPreview(next)
      setDraftText(staleDraftContent || '')
      setEditing(true)
      setMode('source')
    } finally {
      setDraftSaving(false)
    }
  }

  if (!applicationId) {
    return <div className="application-project-panel app-project-empty">项目尚未准备好。</div>
  }

  return (
    <div className="application-project-panel">
      <section className="app-project-groups">
        <header className="app-project-title">
          <strong>{tree?.app?.name || '应用项目'}</strong>
          {loadingTree ? <Loader2 size={13} className="spin" /> : null}
        </header>
        {treeError ? <p className="app-project-error">{treeError}</p> : null}
        {groups.length === 0 && !loadingTree && !treeError ? <p className="app-project-empty">暂无项目文件。</p> : null}
        {groups.map(group => (
          <ProjectGroup
            key={group.id}
            group={group}
            expanded={expanded}
            setExpanded={setExpanded}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
          />
        ))}
      </section>

      <section className="app-project-preview">
        {loadingPreview ? <p className="app-project-empty"><Loader2 size={13} className="spin" /> 加载预览...</p> : null}
        {previewError ? <p className="app-project-error">{previewError}</p> : null}
        {preview && !loadingPreview ? <Preview preview={preview} mode={mode} setMode={setMode} canEditDraft={canEditDraft} editing={editing} draftText={draftText} setDraftText={setDraftText} startDraft={startDraft} saveDraft={saveDraft} discardDraft={discardDraft} applyDraft={applyDraft} restartDraftFromCurrentSource={restartDraftFromCurrentSource} continueDraftFromStaleContent={continueDraftFromStaleContent} draftSaving={draftSaving} /> : null}
        {!preview && !loadingPreview && !previewError ? <p className="app-project-empty">选择文件查看预览。</p> : null}
      </section>
    </div>
  )
}

function ProjectGroup({ group, expanded, setExpanded, selectedPath, onSelect }) {
  const key = `group:${group.id}`
  const open = !!expanded[key]
  return (
    <div className="app-project-group">
      <button type="button" className="app-project-group-toggle" onClick={() => setExpanded(prev => ({ ...prev, [key]: !open }))}>
        <ChevronRight size={13} className={open ? 'is-open' : ''} />
        <span>{group.title}</span>
      </button>
      {open ? <div className="app-project-tree">{(group.nodes || []).map(node => <ProjectNode key={node.path} node={node} expanded={expanded} setExpanded={setExpanded} selectedPath={selectedPath} onSelect={onSelect} />)}</div> : null}
    </div>
  )
}

function ProjectNode({ node, expanded, setExpanded, selectedPath, onSelect }) {
  const open = !!expanded[`dir:${node.path}`]
  if (node.type === 'directory') {
    return (
      <div className="app-project-tree-dir">
        <button type="button" className="app-project-tree-node" onClick={() => setExpanded(prev => ({ ...prev, [`dir:${node.path}`]: !open }))}>
          <ChevronRight size={12} className={open ? 'is-open' : ''} />
          <Folder size={13} />
          <span>{node.name}</span>
        </button>
        {open ? <div className="app-project-tree-children">{(node.children || []).map(child => <ProjectNode key={child.path} node={child} expanded={expanded} setExpanded={setExpanded} selectedPath={selectedPath} onSelect={onSelect} />)}</div> : null}
      </div>
    )
  }
  return (
    <button type="button" className={`app-project-tree-node app-project-file${selectedPath === node.path ? ' is-selected' : ''}`} onClick={() => onSelect(node.path)}>
      <FileText size={13} />
      <span>{node.name}</span>
    </button>
  )
}

function Preview({ preview, mode, setMode, canEditDraft, editing, draftText, setDraftText, startDraft, saveDraft, discardDraft, applyDraft, restartDraftFromCurrentSource, continueDraftFromStaleContent, draftSaving }) {
  const sourceModes = preview.kind === 'markdown'
    ? [['preview', '预览'], ['source', '源码']]
    : preview.kind === 'json'
      ? [['preview', '格式化'], ['source', '原始']]
      : []
  return (
    <div className="app-project-preview-card">
      <header className="app-project-preview-head">
        <strong>{preview.path}</strong>
        <small>{formatBytes(preview.size)} · {preview.kind}</small>
      </header>
      {sourceModes.length > 0 ? (
        <div className="app-project-preview-tabs">
          {sourceModes.map(([id, label]) => <button key={id} type="button" className={mode === id ? 'is-active' : ''} onClick={() => setMode(id)}>{label}</button>)}
        </div>
      ) : null}
      {canEditDraft ? (
        <div className="app-project-draft-actions">
          {!preview.draft?.isStale ? <button type="button" onClick={startDraft}>{preview.draft ? '继续编辑草稿' : '编辑草稿'}</button> : null}
          {editing ? <button type="button" onClick={saveDraft} disabled={draftSaving}>保存草稿</button> : null}
          {preview.draft && preview.draft.status === 'draft' && !preview.draft.isStale ? <button type="button" onClick={applyDraft} disabled={draftSaving}>应用为变更需求</button> : null}
          {preview.draft && preview.draft.status === 'proposed' ? <span className="app-project-proposed">已应用为变更需求，等待中心会话确认。</span> : null}
          {preview.draft ? <button type="button" onClick={discardDraft} disabled={draftSaving}>丢弃草稿</button> : null}
          {preview.draft && preview.draft.isStale ? <button type="button" onClick={restartDraftFromCurrentSource} disabled={draftSaving}>重新以当前源文档创建草稿</button> : null}
          {preview.draft && preview.draft.isStale ? <button type="button" onClick={continueDraftFromStaleContent} disabled={draftSaving}>以草稿内容继续</button> : null}
          {preview.draft && preview.draft.isStale ? <span className="app-project-stale">源文档已更新，请丢弃草稿后重新编辑。</span> : null}
        </div>
      ) : null}
      {preview.draft && preview.draft.isStale ? (
        <div className="app-project-stale-info">
          <div className="app-project-stale-checksums">
            <span>当前校验: <code>{preview.checksum?.slice(0, 12)}...</code></span>
            <span>草稿基于: <code>{preview.draft.sourceChecksum?.slice(0, 12)}...</code></span>
          </div>
          <LineDiffView sourceText={preview.content} draftText={preview.draft.content} />
        </div>
      ) : null}
      {editing ? <textarea className="app-project-draft-editor" value={draftText} onChange={event => setDraftText(event.target.value)} /> : null}
      {preview.kind === 'large' ? <Metadata preview={preview} message={`文件超过 ${formatBytes(preview.limit)}，本阶段仅显示元数据。`} /> : null}
      {preview.kind === 'binary' ? <Metadata preview={preview} message="二进制或未知文件，本阶段仅显示元数据。" /> : null}
      {preview.kind === 'markdown' && mode === 'preview' && !editing ? <MarkdownPreview content={preview.content || ''} /> : null}
      {preview.kind === 'markdown' && mode === 'source' && !editing ? <pre className="app-project-source">{preview.content}</pre> : null}
      {preview.kind === 'json' && !editing ? <pre className="app-project-source">{mode === 'source' ? preview.content : preview.formatted || preview.content}</pre> : null}
      {preview.kind === 'text' && !editing ? <pre className="app-project-source">{preview.content}</pre> : null}
    </div>
  )
}

function Metadata({ preview, message }) {
  return <div className="app-project-metadata"><p>{message}</p><small>{preview.mime || 'unknown'} · {formatBytes(preview.size)}</small></div>
}

function MarkdownPreview({ content }) {
  return (
    <div className="app-project-markdown">
      {content.split(/\n{2,}/).map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  )
}

function renderMarkdownBlock(block, index) {
  const text = block.trim()
  if (!text) return null
  if (text.startsWith('### ')) return <h4 key={index}>{text.slice(4)}</h4>
  if (text.startsWith('## ')) return <h3 key={index}>{text.slice(3)}</h3>
  if (text.startsWith('# ')) return <h2 key={index}>{text.slice(2)}</h2>
  if (text.startsWith('```')) return <pre key={index}>{text.replace(/^```\w*\n?/, '').replace(/```$/, '')}</pre>
  if (text.split('\n').every(line => /^[-*] /.test(line.trim()))) {
    return <ul key={index}>{text.split('\n').map((line, i) => <li key={i}>{line.trim().slice(2)}</li>)}</ul>
  }
  return <p key={index}>{text}</p>
}

function firstFile(groups, predicate = () => true) {
  for (const group of groups) {
    const found = findFile(group.nodes || [], predicate)
    if (found) return found
  }
  return null
}

function findFile(nodes, predicate) {
  for (const node of nodes) {
    if (node.type === 'file' && predicate(node)) return node
    if (node.children) {
      const found = findFile(node.children, predicate)
      if (found) return found
    }
  }
  return null
}

function formatBytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}

const MAX_DIFF_LINES = 500

// LCS-based line diff helper
function computeLineDiff(sourceText, draftText) {
  const sourceLines = (sourceText || '').split('\n')
  const draftLines = (draftText || '').split('\n')

  // Compute LCS table
  const m = sourceLines.length
  const n = draftLines.length
  if (m + n > MAX_DIFF_LINES) {
    return { tooLarge: true, sourceLineCount: m, draftLineCount: n, lines: [] }
  }
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sourceLines[i - 1] === draftLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  const diff = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && sourceLines[i - 1] === draftLines[j - 1]) {
      diff.unshift({ type: 'same', line: sourceLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'added', line: draftLines[j - 1] })
      j--
    } else if (i > 0) {
      diff.unshift({ type: 'removed', line: sourceLines[i - 1] })
      i--
    }
  }

  return { tooLarge: false, lines: diff }
}

function LineDiffView({ sourceText, draftText }) {
  const diff = useMemo(() => computeLineDiff(sourceText, draftText), [sourceText, draftText])

  if (diff.tooLarge) {
    return (
      <div className="app-project-diff app-project-diff-too-large">
        当前文档差异较大（源文档 {diff.sourceLineCount} 行，草稿 {diff.draftLineCount} 行），已跳过逐行对比。请选择一种变基方式后继续编辑。
      </div>
    )
  }

  return (
    <div className="app-project-diff">
      <div className="app-project-diff-lines">
        {diff.lines.map((item, index) => (
          <div key={index} className={`app-project-diff-line app-project-diff-line-${item.type}`}>
            <span className="app-project-diff-line-gutter">
              {item.type === 'same' ? ' ' : item.type === 'added' ? '+' : '-'}
            </span>
            <span className="app-project-diff-line-text">{item.line}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
