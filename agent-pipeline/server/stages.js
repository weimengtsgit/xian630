import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.resolve(__dirname, 'stages.json')

export const STAGE_KEYS = ['agent-business', 'agent-prototype', 'agent-data', 'agent-production']
const VALID_STATUS = ['pending', 'working', 'completed']

// stages.json 只存静态配置（name/url）；运行状态不读不写盘，默认 pending。
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).stages
  } catch {
    return DEFAULT_CONFIG()
  }
}

export function DEFAULT_CONFIG() {
  return [
    { key: 'agent-business', name: '业务逻辑', url: 'https://115.190.228.77:18701' },
    { key: 'agent-prototype', name: '界面解析', url: 'http://220.154.5.91:18020' },
    { key: 'agent-data', name: '数据抓取', url: '' },
    { key: 'agent-production', name: '生产交付', url: '' }
  ]
}

// 内存状态 store：状态只存内存（重启/reset 回全 pending），不写盘。
export function createStageStore(config) {
  const cfg = Array.from(config)
  const state = new Map()
  for (const s of cfg) state.set(s.key, 'pending')

  function snapshot() {
    return cfg.map(s => ({
      key: s.key,
      name: s.name,
      url: s.url,
      status: state.get(s.key) || 'pending'
    }))
  }

  return {
    read() { return snapshot() },
    update(key, patch = {}) {
      if (!STAGE_KEYS.includes(key)) throw new Error(`unknown stage key: ${key}`)
      const stage = cfg.find(s => s.key === key)
      if (patch.status !== undefined) {
        if (!VALID_STATUS.includes(patch.status)) throw new Error(`invalid status: ${patch.status}`)
        state.set(key, patch.status)
      }
      if (patch.url !== undefined) {
        stage.url = String(patch.url)
      }
      return snapshot()
    },
    reset() {
      for (const s of cfg) state.set(s.key, 'pending')
      return snapshot()
    }
  }
}

export const store = createStageStore(readConfig())
