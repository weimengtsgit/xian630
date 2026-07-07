import { readFileSync } from 'node:fs'

const css = [
  readFileSync(new URL('./index.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./app-store-overrides.css', import.meta.url), 'utf8'),
].join('\n')

function assertContains(selector, required) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  if (matches.length === 0) {
    throw new Error(`Missing selector: ${selector}`)
  }
  for (const declaration of required) {
    const found = matches.some(match => {
      const body = match[1]
        .replace(/\s+/g, ' ')
        .replace(/\s*:\s*/g, ':')
        .replace(/\s*,\s*/g, ',')
      return body.includes(declaration)
    })
    if (!found) {
      throw new Error(`${selector} missing declaration: ${declaration}`)
    }
  }
}

assertContains('.app-content', ['min-height:0'])
assertContains('.app-grid', ['flex:1', 'width:100%', 'repeat(3,minmax(0,1fr))', 'justify-content:start'])
assertContains('.app-main', ['background:', 'max-width:'])
assertContains('.app-card__desc', ['-webkit-line-clamp:2'])
assertContains('.app-card__icon-wrap', ['border-radius:50%'])
assertContains('.new-rec-card__icon', ['border-radius:50%'])
assertContains('.app-card__heading', ['display:flex', 'align-items:center'])
assertContains('.app-card__name', ['font-size:20px'])
assertContains('.app-card__desc', ['font-size:15px'])
assertContains('.app-card__version', ['font-size:13px'])
assertContains('.app-card__vendor', ['font-size:13px'])
assertContains('.new-rec-card__name', ['font-size:16px'])
assertContains('.new-rec-card__meta', ['display:flex', 'flex-direction:column'])

const js = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const overrideCss = readFileSync(new URL('./app-store-overrides.css', import.meta.url), 'utf8')

if (!html.includes('/api/apps') || !html.includes('window.__STORE_APPS__')) {
  throw new Error('index.html must load runtime apps from /api/apps')
}

for (const forbidden of ['演示数据', 'DEMO', '数据来源', 'app-header__badge', 'demo-watermark', 'xx智能体', 'https://www.baidu.com', '✨ 新品推荐', '软件厂商：']) {
  if (js.includes(forbidden) || html.includes(forbidden) || overrideCss.includes(forbidden)) {
    throw new Error(`Forbidden marker remains: ${forbidden}`)
  }
}

const expectedApps = [
  ['美航母AIS异常监测', 'http://220.154.5.91:18013/'],
  ['舰载机归属判断', 'http://220.154.5.91:18001/'],
  ['华盛顿号航母打击群西太地区活动规律分析智能体', 'http://220.154.5.91:18015/'],
  ['航母甲板风条件评估看板', 'http://220.154.5.91:18009/'],
  ['航母态势指挥仪表盘', 'http://220.154.5.91:18017/'],
  ['航母打击群活动规律分析', 'http://220.154.5.91:18015/'],
  ['航母母港潮汐出港窗口计算器', 'http://220.154.5.91:18000/'],
  ['海域网格商船密度异常告警器', 'http://220.154.5.91:18011/'],
  ['航母及舰载机时空伴随关系分析智能体', 'http://203.83.238.87:8848/'],
  ['航母舰载机挖掘分析', 'http://220.154.5.91:18010/'],
]

for (const [name, link] of expectedApps) {
  if (!js.includes(name)) throw new Error(`Missing app: ${name}`)
  if (!js.includes(link)) throw new Error(`Missing app link: ${link}`)
}

const appIdCount = (js.match(/id:"app-\d{3}"/g) || []).length
if (appIdCount !== 10) {
  throw new Error(`Expected 10 built-in apps, found ${appIdCount}`)
}

const vendorCount = (js.match(/vendor:"电子云"/g) || []).length
if (vendorCount < 6) {
  throw new Error(`Expected default vendor on remaining built-in apps, found ${vendorCount}`)
}

for (const required of ['软件厂商', 'registerStoreApp', 'deleteStoreApp', 'normalizeStoreApp', 'status:"新品"']) {
  if (!js.includes(required)) {
    throw new Error(`Missing runtime/app requirement: ${required}`)
  }
}

const appExpectations = [
  ['美航母AIS异常监测', '美', '电子云'],
  ['舰载机归属判断', '舰', '中电科十五所'],
  ['华盛顿号航母打击群西太地区活动规律分析智能体', '华', '电信十所'],
  ['航母甲板风条件评估看板', '航', '电子云'],
  ['航母态势指挥仪表盘', '航', '电子云'],
  ['航母打击群活动规律分析', '航', '电子云'],
  ['航母母港潮汐出港窗口计算器', '航', '电子云'],
  ['海域网格商船密度异常告警器', '海', '电子云'],
  ['航母及舰载机时空伴随关系分析智能体', '航', '电信十所'],
  ['航母舰载机挖掘分析', '航', '领铄'],
]

for (const [name, icon, vendor] of appExpectations) {
  const index = js.indexOf(`name:"${name}"`)
  if (index === -1) throw new Error(`Missing app for expectation: ${name}`)
  const next = js.indexOf('},{id:"app-', index + 1)
  const appSource = js.slice(index, next === -1 ? js.indexOf('}],Wf=', index) : next)
  if (!appSource.includes(`icon:"${icon}"`)) {
    throw new Error(`${name} icon should be first character ${icon}`)
  }
  if (!appSource.includes(`vendor:"${vendor}"`)) {
    throw new Error(`${name} vendor should be ${vendor}`)
  }
}

if (!js.includes('icon:we.slice(0,1)')) {
  throw new Error('Registered apps must use the first character of the name as icon')
}

if (!js.includes('app-card__heading')) {
  throw new Error('App card icon should be rendered with the title')
}

const builtInOrder = [...js.matchAll(/id:"app-\d{3}",name:"([^"]+)"/g)].map(match => match[1])
if (builtInOrder[1] !== '舰载机归属判断') {
  throw new Error(`舰载机归属判断 should be the second app in the lower list, got ${builtInOrder[1]}`)
}

if (builtInOrder[2] !== '华盛顿号航母打击群西太地区活动规律分析智能体') {
  throw new Error(`华盛顿号航母打击群西太地区活动规律分析智能体 should be the third app in the lower list, got ${builtInOrder[2]}`)
}

if (builtInOrder[3] !== '航母打击群活动规律分析') {
  throw new Error(`航母打击群活动规律分析 should be the fourth app in the lower list, got ${builtInOrder[3]}`)
}

if (builtInOrder[builtInOrder.length - 1] !== '航母舰载机挖掘分析') {
  throw new Error(`航母舰载机挖掘分析 should be the last app in the lower list, got ${builtInOrder[builtInOrder.length - 1]}`)
}

const washingtonIndex = js.indexOf('name:"华盛顿号航母打击群西太地区活动规律分析智能体"')
if (washingtonIndex === -1) {
  throw new Error('Missing 华盛顿号航母打击群西太地区活动规律分析智能体')
}
const washingtonNext = js.indexOf('},{id:"app-', washingtonIndex + 1)
const washingtonSource = js.slice(washingtonIndex, washingtonNext === -1 ? js.indexOf('}],Wf=', washingtonIndex) : washingtonNext)
if (!washingtonSource.includes('link:"http://106.63.8.234:7001/html/washington-carrier-activity-20260627-v2.html"')) {
  throw new Error('华盛顿号航母打击群西太地区活动规律分析智能体 link is not updated')
}

if (js.includes('航母级舰载机时空伴随关系分析智能体')) {
  throw new Error('Old app name should be removed: 航母级舰载机时空伴随关系分析智能体')
}

console.log('operations-management layout and app-data checks passed')
