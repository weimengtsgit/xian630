import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FILE = path.resolve(__dirname, 'stages.json')

export const STAGE_KEYS = ['agent-business', 'agent-prototype', 'agent-data', 'agent-production']
const VALID_STATUS = ['pending', 'completed']

export function DEFAULT_STAGES() {
  return [
    { key: 'agent-business', name: '业务逻辑', status: 'completed', url: 'https://115.190.228.77:18701' },
    { key: 'agent-prototype', name: '界面解析', status: 'pending', url: 'http://220.154.5.91:18020' },
    { key: 'agent-data', name: '数据抓取', status: 'pending', url: '' },
    { key: 'agent-production', name: '生产交付', status: 'pending', url: '' }
  ]
}

export function createStageStore(filepath, initial) {
  let cache
  try {
    cache = JSON.parse(fs.readFileSync(filepath, 'utf8')).stages
  } catch {
    cache = Array.from(initial)
    fs.writeFileSync(filepath, JSON.stringify({ stages: cache }, null, 2))
  }
  return {
    read() { return cache },
    update(key, status) {
      if (!STAGE_KEYS.includes(key)) throw new Error(`unknown stage key: ${key}`)
      if (!VALID_STATUS.includes(status)) throw new Error(`invalid status: ${status}`)
      cache = cache.map(s => (s.key === key ? { ...s, status } : s))
      fs.writeFileSync(filepath, JSON.stringify({ stages: cache }, null, 2))
      return cache
    }
  }
}

export const store = createStageStore(DEFAULT_FILE, DEFAULT_STAGES())
