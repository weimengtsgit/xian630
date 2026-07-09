import { readFileSync } from 'node:fs'

const files = [
  './index.js',
  './preview/assets/index-DmVUBMo0.js',
]

function appNames(source) {
  return [...source.matchAll(/\{id:"app-\d{3}",name:"([^"]+)"/g)].map(match => match[1])
}

for (const file of files) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const names = appNames(source)

  const affiliationIndex = names.indexOf('舰载机归属判断')
  const washingtonIndex = names.indexOf('华盛顿号航母打击群西太地区活动规律分析智能体')
  const miningIndex = names.indexOf('航母舰载机挖掘分析')
  if (affiliationIndex === -1 || washingtonIndex === -1) {
    throw new Error(`${file} missing expected apps for all-app ordering`)
  }
  if (affiliationIndex > washingtonIndex) {
    throw new Error(`${file} 全部应用中“舰载机归属判断”应排在“华盛顿号航母打击群西太地区活动规律分析智能体”前面`)
  }
  if (miningIndex === -1) {
    throw new Error(`${file} missing 航母舰载机挖掘分析`)
  }
  if (miningIndex !== names.length - 1) {
    throw new Error(`${file} 全部应用中“航母舰载机挖掘分析”应排在最后一个`)
  }

  if (!source.includes('newRecPriority')) {
    throw new Error(`${file} missing dedicated 新品推荐 ordering`)
  }
  const miningPriorityIndex = source.indexOf('"航母舰载机挖掘分析":0')
  const deckIndex = source.indexOf('"航母甲板风条件评估看板":1')
  const washingtonPriorityIndex = source.indexOf('"华盛顿号航母打击群西太地区活动规律分析智能体":2')
  if (
    miningPriorityIndex === -1 ||
    deckIndex === -1 ||
    washingtonPriorityIndex === -1 ||
    miningPriorityIndex > deckIndex ||
    deckIndex > washingtonPriorityIndex
  ) {
    throw new Error(`${file} 新品推荐顺序应为“航母舰载机挖掘分析 / 航母甲板风条件评估看板 / 华盛顿号航母打击群西太地区活动规律分析智能体”`)
  }
}

console.log('order update checks passed')
