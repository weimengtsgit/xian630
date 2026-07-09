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

export function listProjects() {
  return readAll()
}

export function createProject(data) {
  const list = readAll()
  const proj = {
    id: `proj_${Date.now()}`,
    name: data.name || `项目 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
    projectname: data.projectname || randomCode(4),
    createdAt: Date.now(),
  }
  list.unshift(proj)
  writeAll(list)
  return proj
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
