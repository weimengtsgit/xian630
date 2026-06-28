import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText, Folder, Loader2 } from 'lucide-react'
import { factoryApi } from '../api/client'
import './ApplicationProjectPanel.css'

export function ApplicationProjectPanel({ applicationId }) {
  const [tree, setTree] = useState(null)
  const [treeError, setTreeError] = useState('')
  const [loadingTree, setLoadingTree] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [expanded, setExpanded] = useState({})
  const [mode, setMode] = useState('preview')

  useEffect(() => {
    setTree(null)
    setTreeError('')
    setSelectedPath('')
    setPreview(null)
    if (!applicationId) return undefined
    let canceled = false
    setLoadingTree(true)
    factoryApi.getApplicationProjectTree(applicationId)
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
  }, [applicationId])

  useEffect(() => {
    setPreview(null)
    setPreviewError('')
    setMode('preview')
    if (!applicationId || !selectedPath) return undefined
    let canceled = false
    setLoadingPreview(true)
    factoryApi.getApplicationProjectFile(applicationId, selectedPath)
      .then(data => { if (!canceled) setPreview(data) })
      .catch(err => { if (!canceled) setPreviewError(err.message || String(err)) })
      .finally(() => { if (!canceled) setLoadingPreview(false) })
    return () => { canceled = true }
  }, [applicationId, selectedPath])

  const groups = useMemo(() => (tree && Array.isArray(tree.groups) ? tree.groups : []), [tree])

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
        {preview && !loadingPreview ? <Preview preview={preview} mode={mode} setMode={setMode} /> : null}
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

function Preview({ preview, mode, setMode }) {
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
      {preview.kind === 'large' ? <Metadata preview={preview} message={`文件超过 ${formatBytes(preview.limit)}，本阶段仅显示元数据。`} /> : null}
      {preview.kind === 'binary' ? <Metadata preview={preview} message="二进制或未知文件，本阶段仅显示元数据。" /> : null}
      {preview.kind === 'markdown' && mode === 'preview' ? <MarkdownPreview content={preview.content || ''} /> : null}
      {preview.kind === 'markdown' && mode === 'source' ? <pre className="app-project-source">{preview.content}</pre> : null}
      {preview.kind === 'json' ? <pre className="app-project-source">{mode === 'source' ? preview.content : preview.formatted || preview.content}</pre> : null}
      {preview.kind === 'text' ? <pre className="app-project-source">{preview.content}</pre> : null}
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
