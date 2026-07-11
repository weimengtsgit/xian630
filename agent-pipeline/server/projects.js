import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function isValidProjectName(name) {
  return typeof name === 'string' && PROJECT_KEY_REGEX.test(name)
}

export function listProjects() {
  return readAll()
}

export function createProject(data) {
  // F1: validate a caller-provided projectname against the strict regex before
  // it is ever sent to interface-agent resolve (which builds Blade OS paths from
  // it). The randomCode default already satisfies the regex.
  const projectname = data.projectname || randomCode(4)
  if (!isValidProjectName(projectname)) {
    throw new InvalidProjectNameError(projectname)
  }
  const list = readAll()
  const proj = {
    id: `proj_${Date.now()}`,
    name: data.name || `项目 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
    projectname,
    createdAt: Date.now(),
    // interface-agent credentials (T4): the long edit token is held server-side
    // only and NEVER sent to the browser. Undefined until the first interface-launch.
    interfaceEditToken: undefined,
    interfaceSessionId: undefined,
  }
  list.unshift(proj)
  writeAll(list)
  return proj
}

export function findProject(id) {
  return readAll().find((p) => p.id === id) || null
}

export function updateProject(id, updates) {
  const list = readAll()
  const idx = list.findIndex((p) => p.id === id)
  if (idx < 0) return null
  list[idx] = { ...list[idx], ...updates }
  writeAll(list)
  return list[idx]
}

export function deleteProject(id) {
  const list = readAll().filter(p => p.id !== id)
  writeAll(list)
  return list
}

function randomCode(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
