import { readFileSync } from 'node:fs'

const bundlePaths = [
  './index.js',
  './preview/assets/index-DmVUBMo0.js',
]

const iterationVersions = new Map([
  ['app-001', 'v1.9.0'],
  ['app-002', 'v1.8.0'],
  ['app-003', 'v1.2.0'],
  ['app-005', 'v1.1.0'],
  ['app-006', 'v1.0.3'],
])

const expectedTail = [
  {
    name: '航母母港潮汐出港窗口计算器',
    link: 'http://220.154.5.91:18000/',
    vendor: '电子云',
  },
  {
    name: '海域网格商船密度异常告警器',
    link: 'http://220.154.5.91:18011/',
    vendor: '电子云',
  },
  {
    name: '航母及舰载机时空伴随关系分析智能体',
    link: 'http://203.83.238.87:8848/',
    vendor: '电信十所',
  },
  {
    name: '航母舰载机挖掘分析',
    link: 'http://220.154.5.91:18010/',
    vendor: '领铄',
  },
]

function extractBuiltInApps(source) {
  return [...source.matchAll(/\{id:"app-\d{3}",name:"([^"]+)"[\s\S]*?(?=\},\{id:"app-\d{3}"|\}\],Wf=)/g)].map(match => match[0])
}

for (const relativePath of bundlePaths) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const apps = extractBuiltInApps(source)
  const names = apps.map(app => app.match(/name:"([^"]+)"/)?.[1])

  if (apps.length !== 10) {
    throw new Error(`${relativePath} should contain 10 built-in apps, found ${apps.length}`)
  }

  for (const appSource of apps) {
    const id = appSource.match(/\{id:"(app-\d{3})"/)?.[1]
    const name = appSource.match(/name:"([^"]+)"/)?.[1] || 'unknown app'
    const publishDate = appSource.match(/publishDate:"([^"]+)"/)?.[1]
    const version = appSource.match(/version:"([^"]+)"/)?.[1]
    const expectedVersion = iterationVersions.get(id) || 'v1.0.0'
    if (version !== expectedVersion) {
      throw new Error(`${relativePath} ${name} version must be ${expectedVersion}, got ${version || 'missing'}`)
    }
    if (!publishDate) {
      throw new Error(`${relativePath} ${name} must include publishDate`)
    }
    if (publishDate <= '2026-05-20') {
      throw new Error(`${relativePath} ${name} publishDate must be after 2026-05-20, got ${publishDate}`)
    }
  }

  const tailNames = names.slice(-4)
  const expectedTailNames = expectedTail.map(app => app.name)
  if (JSON.stringify(tailNames) !== JSON.stringify(expectedTailNames)) {
    throw new Error(`${relativePath} last four apps should be ${expectedTailNames.join(' / ')}, got ${tailNames.join(' / ')}`)
  }

  for (const app of expectedTail) {
    const appSource = apps.find(item => item.includes(`name:"${app.name}"`))
    if (!appSource) throw new Error(`${relativePath} missing app ${app.name}`)
    if (!appSource.includes(`link:"${app.link}"`)) {
      throw new Error(`${relativePath} ${app.name} link should be ${app.link}`)
    }
    if (!appSource.includes(`vendor:"${app.vendor}"`)) {
      throw new Error(`${relativePath} ${app.name} vendor should be ${app.vendor}`)
    }
  }

  const affiliation = apps.find(app => app.includes('name:"舰载机归属判断"'))
  if (!affiliation?.includes('link:"http://220.154.5.91:18001/"')) {
    throw new Error(`${relativePath} 舰载机归属判断 link should be http://220.154.5.91:18001/`)
  }
  if (!affiliation.includes('vendor:"中电科十五所"')) {
    throw new Error(`${relativePath} 舰载机归属判断 vendor should be 中电科十五所`)
  }

  if (source.includes('中电十所')) {
    throw new Error(`${relativePath} should not contain 中电十所`)
  }
  if (source.includes('中电十五所')) {
    throw new Error(`${relativePath} should not contain 中电十五所`)
  }
  if (!source.includes('电信十所')) {
    throw new Error(`${relativePath} should contain 电信十所`)
  }
  if (source.includes('航母级舰载机时空伴随关系分析智能体')) {
    throw new Error(`${relativePath} should not contain old app name 航母级舰载机时空伴随关系分析智能体`)
  }
}

console.log('operations-management app update checks passed')
