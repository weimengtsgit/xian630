import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store as defaultStore } from './stages.js'

export function createApp(storeOverride) {
  const store = storeOverride || defaultStore
  const app = express()
  app.use(express.json())

  // CORS: allow cross-origin browser calls (preflight + actual). Mirrors the
  // factory-server corsMiddleware policy. Allow all origins by request.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type')
    res.set('Access-Control-Max-Age', '86400')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

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

  app.post('/api/stages/:key', (req, res) => {
    try {
      const stages = store.update(req.params.key, req.body || {})
      res.json({ stages })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const distDir = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(distDir))
  return app
}
