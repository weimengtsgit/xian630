import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAGE_KEYS } from './stages.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.resolve(__dirname, 'projects.json')

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return []
  }
}

function writeAll(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2))
}

/**
 * F1: strict project-key validation. Blocks path traversal via `projectname`
 * (agent-pipeline holds the internal token → confused deputy that could write
 * outside the project dir). Same regex as interface-agent validateProjectKey.
 * Throws on invalid input.
 */
const PROJECT_KEY_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/

export class InvalidProjectNameError extends Error {
  constructor(value) {
    super('项目标识只能包含小写字母、数字和连字符，长度 1-32。')
    this.name = 'InvalidProjectNameError'
  }
}

export class MissingProjectNameError extends Error {
  constructor() {
    super('项目显示名(name)必填。')
    this.name = 'MissingProjectNameError'
  }
}

export function isValidProjectName(name) {
  return typeof name === 'string' && PROJECT_KEY_REGEX.test(name)
}

// ---- 智能体状态(per-project,持久在 projects.json) ----
// canonical 四态;兼容旧值 working→running、completed→succeeded。
const AGENT_STATUS = ['pending', 'running', 'failed', 'succeeded']
const TERMINAL_STATUS = ['failed', 'succeeded']
const STATUS_ALIAS = { working: 'running', completed: 'succeeded' }

export function isValidAgentKey(key) {
  return STAGE_KEYS.includes(key)
}

/** 规范化状态:返回 canonical 串;非法返回 null(working/completed 兼容映射)。 */
export function normalizeAgentStatus(s) {
  if (typeof s !== 'string') return null
  if (STATUS_ALIAS[s]) return STATUS_ALIAS[s]
  return AGENT_STATUS.includes(s) ? s : null
}

export function isTerminalStatus(s) {
  return TERMINAL_STATUS.includes(s)
}

function defaultAgentStatus() {
  const o = {}
  for (const k of STAGE_KEYS) o[k] = 'pending'
  return o
}

/** 四个智能体皆为 failed/succeeded → 项目完成(派生)。 */
export function computeCompleted(agentStatus) {
  const st = agentStatus || {}
  return STAGE_KEYS.every((k) => isTerminalStatus(st[k]))
}

/** 读取时装饰:补全 agentStatus(旧项目惰性补全为全 pending)+ 派生 completed。 */
export function decorateProject(p) {
  if (!p) return p
  const agentStatus =
    p.agentStatus && typeof p.agentStatus === 'object'
      ? { ...defaultAgentStatus(), ...p.agentStatus }
      : defaultAgentStatus()
  return { ...p, agentStatus, completed: computeCompleted(agentStatus) }
}

export function listProjects() {
  return readAll().map(decorateProject)
}

export function findProject(id) {
  const p = readAll().find((x) => x.id === id)
  return p ? decorateProject(p) : null
}

export function findProjectByProjectname(projectname) {
  const p = readAll().find((x) => x.projectname === projectname)
  return p ? decorateProject(p) : null
}

export function createProject(data) {
  const dataObj = data || {}
  const name = typeof dataObj.name === 'string' ? dataObj.name.trim() : ''
  if (!name) throw new MissingProjectNameError()
  const now = new Date()
  // 项目标识 = 随机码 + 当日日期(YYYYMMDD)，例如 s57820260714。日期后缀便于按天
  // 区分项目、定位 Blade OS 路径；仍满足 PROJECT_KEY_REGEX（小写字母数字，≤32）。
  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const projectname = dataObj.projectname || (randomCode(4) + dateStamp)
  if (!isValidProjectName(projectname)) {
    throw new InvalidProjectNameError(projectname)
  }
  const list = readAll()
  const proj = {
    id: `proj_${now.getTime()}`,
    name,
    projectname,
    createdAt: now.getTime(),
    agentStatus: defaultAgentStatus(),
    // interface-agent credentials (T4): the long edit token is held server-side
    // only and NEVER sent to the browser. Undefined until the first interface-launch.
    interfaceEditToken: undefined,
    interfaceSessionId: undefined,
  }
  list.unshift(proj)
  writeAll(list)
  return decorateProject(proj)
}

export function updateProject(id, updates) {
  const list = readAll()
  const idx = list.findIndex((p) => p.id === id)
  if (idx < 0) return null
  list[idx] = { ...list[idx], ...updates }
  writeAll(list)
  return decorateProject(list[idx])
}

/**
 * 智能体回调:按 projectname 设置该智能体状态(canonical 化,working/completed 兼容)。
 * 返回装饰后的项目(含最新 agentStatus + completed);项目不存在返回 null。
 */
export function setAgentStatus(projectname, key, status) {
  if (!isValidAgentKey(key)) {
    const err = new Error(`unknown agent key: ${key}`)
    err.code = 'INVALID_KEY'
    throw err
  }
  const norm = normalizeAgentStatus(status)
  if (!norm) {
    const err = new Error(`invalid status: ${status}`)
    err.code = 'INVALID_STATUS'
    throw err
  }
  const list = readAll()
  const idx = list.findIndex((p) => p.projectname === projectname)
  if (idx < 0) return null
  const agentStatus =
    list[idx].agentStatus && typeof list[idx].agentStatus === 'object'
      ? { ...list[idx].agentStatus }
      : defaultAgentStatus()
  agentStatus[key] = norm
  list[idx] = { ...list[idx], agentStatus }
  writeAll(list)
  return decorateProject(list[idx])
}

export function deleteProject(id) {
  const list = readAll().filter((p) => p.id !== id)
  writeAll(list)
  return list
}

function randomCode(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
