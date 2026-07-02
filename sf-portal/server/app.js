import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store as defaultStore } from './stages.js'

export function createApp(storeOverride) {
  const store = storeOverride || defaultStore
  const app = express()
  app.use(express.json())

  app.get('/api/stages', (_req, res) => {
    res.json({ stages: store.read() })
  })

  // 必须在 /:key 之前注册，否则 "reset" 会被当成 :key
  app.post('/api/stages/reset', (_req, res) => {
    res.json({ stages: store.reset() })
  })

  app.post('/api/stages/:key', (req, res) => {
    try {
      const stages = store.update(req.params.key, req.body?.status)
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
