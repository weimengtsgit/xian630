import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store as defaultStore } from './stages.js'
import { listProjects, createProject, findProject, findProjectByProjectname, updateProject, deleteProject, setAgentStatus } from './projects.js'

export function createApp(storeOverride, options = {}) {
  const store = storeOverride || defaultStore
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const interfaceAgentUrl =
    options.interfaceAgentUrl ||
    process.env.INTERFACE_AGENT_URL ||
    'http://127.0.0.1:18020'
  // Fix 4: server-to-server shared secret for interface-agent resolve CREATE.
  // Both services must have the same value; agent-pipeline sends it as
  // X-Internal-Token so only it can mint the long edit token.
  const internalToken =
    options.internalToken || process.env.INTERFACE_AGENT_INTERNAL_TOKEN || ''
  const app = express()
  app.use(express.json())

  // S1: NO global permissive CORS. The agent-pipeline SPA is served same-origin
  // and its fetch calls are same-origin, so the default same-origin policy is
  // correct. A global `Access-Control-Allow-Origin: *` let any cross-site page
  // mint edit-access startCodes (POST /api/projects/:id/interface-launch has no
  // auth). agent-pipeline user-auth is a separate pre-existing gap that must be
  // network-restricted; dropping `*` closes the versioning feature's cross-site
  // startCode minting contribution.

  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ip=${req.socket.remoteAddress}`)
    })
    next()
  })

  app.get('/api/stages', (_req, res) => {
    res.json({ stages: store.read() })
  })

  // 必须在 /:key 之前注册，否则 "reset" 会被当成 :key
  app.post('/api/stages/reset', (_req, res) => {
    res.json({ stages: store.reset() })
  })

  // 合并 stage 静态配置(key/name/url) + 该项目的 agentStatus → 卡片视图。
  function projectStagesView(project) {
    const cfg = store.read()
    const stages = cfg.map((s) => ({
      key: s.key,
      name: s.name,
      url: s.url,
      status: (project && project.agentStatus && project.agentStatus[s.key]) || 'pending',
    }))
    return { stages, completed: Boolean(project && project.completed) }
  }

  // 智能体回调:按 projectname 设置该智能体状态(per-project,持久)。
  // body: { projectname, status }。status 兼容旧值 working→running、completed→succeeded。
  app.post('/api/stages/:key', (req, res) => {
    const { projectname, status } = req.body || {}
    if (!projectname) return res.status(400).json({ error: '缺少 projectname。' })
    try {
      const project = setAgentStatus(projectname, req.params.key, status)
      if (!project) return res.status(404).json({ error: '项目不存在。' })
      res.json(projectStagesView(project))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ---- 项目管理 ----
  // interfaceEditToken is server-side only — NEVER expose it to the browser.
  function sanitizeProject(p) {
    if (!p) return p
    const { interfaceEditToken, ...safe } = p
    return safe
  }

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjects().map(sanitizeProject) })
  })

  app.post('/api/projects', (req, res) => {
    // F1: reject path-traversal / invalid projectname → 400 (confused-deputy
    // guard: agent-pipeline holds the internal token).
    try {
      const proj = createProject(req.body || {})
      res.status(201).json(sanitizeProject(proj))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  app.delete('/api/projects/:id', (req, res) => {
    const projects = deleteProject(req.params.id)
    res.json({ projects: projects.map(sanitizeProject) })
  })

  // 按项目的智能体状态视图(供 AgentsPanel 渲染 + 轮询):合并 stage 配置 + agentStatus。
  app.get('/api/projects/:id/stages', (req, res) => {
    const project = findProject(req.params.id)
    if (!project) return res.status(404).json({ error: '项目不存在。' })
    res.json(projectStagesView(project))
  })

  // ---- 界面智能体启动（凭证服务端传递）----
  // Browser calls this → server calls interface-agent resolve (holding the
  // edit token server-side) → returns only a one-time startCode to the browser.
  // The long edit token NEVER reaches the browser URL/Referer/logs.
  // M1: same-origin Origin guard — reject a foreign Origin so a cross-site page
  // cannot mint startCodes via a form/fetch POST (defense-in-depth on top of the
  // S1 CORS removal). No Origin header (non-browser / direct) is allowed.
  app.post('/api/projects/:id/interface-launch', (req, res, next) => {
    const origin = req.get('origin')
    if (origin) {
      let originHost = null
      try { originHost = new URL(origin).host } catch { originHost = '__malformed__' }
      // The request's own Host header is the agent-pipeline origin.
      const ownHost = req.get('host')
      if (originHost !== ownHost) {
        return res.status(403).json({ error: '跨站请求被拒绝。' })
      }
    }
    next()
  }, async (req, res) => {
    const project = findProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: '项目不存在。' })
    }

    try {
      const iaRes = await fetchImpl(
        `${interfaceAgentUrl}/api/interface-sessions/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Fix 4: server-to-server secret for resolve CREATE. Sent on every
            // call; the interface-agent only checks it on the CREATE branch.
            ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
          },
          body: JSON.stringify({
            projectKey: project.projectname,
            editToken: project.interfaceEditToken || undefined,
          }),
        },
      )

      if (!iaRes.ok) {
        const detail = await iaRes.text().catch(() => '')
        console.error(`[interface-launch] resolve failed: ${iaRes.status} ${detail}`)
        return res.status(iaRes.status === 401 ? 401 : 502).json({
          error: '界面智能体会话启动失败，请稍后重试。',
        })
      }

      const data = await iaRes.json()

      // First launch: resolve returns the new editToken (201). Store it
      // server-side so subsequent launches reuse the same session.
      if (data.editToken) {
        updateProject(project.id, {
          interfaceEditToken: data.editToken,
          interfaceSessionId: data.sessionId,
        })
      }

      // Only the one-time startCode goes to the browser.
      return res.json({ startCode: data.startCode, sessionId: data.sessionId })
    } catch (err) {
      console.error('[interface-launch] error:', err)
      return res.status(502).json({ error: '无法连接界面智能体服务。' })
    }
  })

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const distDir = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(distDir))
  return app
}
