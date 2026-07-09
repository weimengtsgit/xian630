import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const files = [
  'index.js',
  'preview/assets/index-DmVUBMo0.js',
]

const apps = [
  {
    id: 'app-001',
    name: '美航母AIS异常监测',
    description: '实时监测美国航母AIS信号异常，识别信号中断、轨迹偏离与伪装行为。',
    longDescription: '围绕航母目标AIS信号连续性、航迹一致性和异常停发事件进行监测，自动归集异常片段、轨迹偏移和疑似伪装行为，为态势研判提供事件线索。',
    icon: '美',
    category: '态势监测',
    status: '热门',
    version: 'v2.4.1',
    vendor: '电子云',
    publishDate: '2026-03-15',
    link: 'http://220.154.5.91:18013/',
    features: ['AIS信号异常监测', '轨迹偏离识别', '信号中断告警', '伪装行为研判', '态势事件汇总'],
  },
  {
    id: 'app-002',
    name: '舰载机归属判断',
    description: '基于航空器轨迹、起降窗口和航母位置关联，研判舰载机归属关系。',
    longDescription: '融合航空器轨迹、航母位置、活动时间窗和舰载机特征库，通过时空关联和概率推断输出舰载机归属判断结果，辅助分析航母空中联队活动。',
    icon: '舰',
    category: '情报分析',
    status: '已上架',
    version: 'v1.8.0',
    vendor: '中电科十五所',
    publishDate: '2026-01-20',
    link: 'http://220.154.5.91:18001/',
    features: ['航空轨迹关联', '母舰归属推断', '起降窗口分析', '编成活动识别', '置信度结果输出'],
  },
  {
    id: 'app-003',
    name: '华盛顿号航母打击群西太地区活动规律分析智能体',
    description: '追踪华盛顿号航母打击群部署动态，分析活动规律与战术模式。',
    longDescription: '聚焦华盛顿号航母打击群部署、航行、靠泊和演训活动，汇总时间线与区域活动特征，分析周期规律、伴随舰艇变化和重点海域存在态势。',
    icon: '华',
    category: '活动规律',
    status: '新品',
    version: 'v1.2.0',
    vendor: '电信十所',
    publishDate: '2026-06-10',
    link: 'http://106.63.8.234:7001/html/washington-carrier-activity-20260627-v2.html',
    features: ['部署时间线追踪', '打击群编成分析', '活动区域统计', '演训模式识别', '历史规律对比'],
  },
  {
    id: 'app-006',
    name: '航母打击群活动规律分析',
    description: '面向航母打击群全局活动，分析部署节奏、海域分布和行动模式。',
    longDescription: '对航母打击群活动进行多源汇聚和规律分析，覆盖部署周期、航线分布、海域停留、伴随舰艇变化与行动模式识别，支撑持续态势评估。',
    icon: '航',
    category: '活动规律',
    status: '已上架',
    version: 'v1.0.3',
    vendor: '电子云',
    publishDate: '2026-05-12',
    link: 'http://220.154.5.91:18015/',
    features: ['部署周期分析', '航线分布统计', '海域活动聚合', '行动模式识别', '规律报告生成'],
  },
  {
    id: 'app-004',
    name: '航母甲板风条件评估看板',
    description: '结合气象要素与航母航向航速，评估甲板风窗口和起降保障条件。',
    longDescription: '面向航母飞行甲板作业保障，综合风速、风向、航向、航速与海况条件，评估甲板风可用窗口、风险等级和作业建议。',
    icon: '航',
    category: '态势监测',
    status: '新品',
    version: 'v1.0.0',
    vendor: '电子云',
    publishDate: '2026-06-18',
    link: 'http://220.154.5.91:18009/',
    features: ['甲板风窗口评估', '气象条件融合', '起降风险分级', '作业条件看板', '保障建议输出'],
  },
  {
    id: 'app-005',
    name: '航母态势指挥仪表盘',
    description: '汇聚航母目标、编队、告警与任务指标，形成态势指挥总览。',
    longDescription: '面向航母态势指挥场景，集中展示航母目标状态、编队动态、告警事件、任务指标和区域态势，为值守人员提供一屏式指挥入口。',
    icon: '航',
    category: '指挥看板',
    status: '已上架',
    version: 'v1.1.0',
    vendor: '电子云',
    publishDate: '2026-04-28',
    link: 'http://220.154.5.91:18017/',
    features: ['态势总览大屏', '目标状态汇聚', '告警事件联动', '任务指标监控', '指挥入口整合'],
  },
  {
    id: 'app-007',
    name: '航母母港潮汐出港窗口计算器',
    description: '结合母港潮位、吃水阈值和出港窗口，计算航母可用出港时间段。',
    longDescription: '面向航母母港出港保障场景，结合潮汐曲线、港口水深、舰艇吃水和安全阈值，计算可用出港窗口并给出风险提示。',
    icon: '航',
    category: '态势监测',
    status: '已上架',
    version: 'v1.0.0',
    vendor: '电子云',
    publishDate: '2026-06-28',
    link: 'http://220.154.5.91:18000/',
    features: ['潮汐窗口计算', '吃水阈值校核', '出港风险提示', '母港条件对比', '窗口结果汇总'],
  },
  {
    id: 'app-008',
    name: '海域网格商船密度异常告警器',
    description: '按海域网格监测商船密度变化，识别异常聚集、稀疏和航道偏离事件。',
    longDescription: '基于海域网格化统计商船活动密度，监测异常聚集、密度骤降、航道偏离和重点区域拥挤态势，为海上异常发现提供告警线索。',
    icon: '海',
    category: '态势监测',
    status: '已上架',
    version: 'v1.0.0',
    vendor: '电子云',
    publishDate: '2026-06-28',
    link: 'http://220.154.5.91:18011/',
    features: ['海域网格统计', '商船密度监测', '异常聚集告警', '航道偏离识别', '重点区域态势'],
  },
  {
    id: 'app-009',
    name: '航母及舰载机时空伴随关系分析智能体',
    description: '可调海域范围或者是特定海域，分析航母周边与航母轨迹位置重叠，或者与航母区域时空伴随的舰载机、起降发现模型，通过智能交互发现航母与舰载机关系分析。',
    longDescription: '可调海域范围或者是特定海域，分析航母周边与航母轨迹位置重叠，或者与航母区域时空伴随的舰载机、起降发现模型，通过智能交互发现航母与舰载机关系分析。',
    icon: '航',
    category: '情报分析',
    status: '已上架',
    version: 'v1.0.0',
    vendor: '电信十所',
    publishDate: '2026-06-28',
    link: 'http://203.83.238.87:8848/',
    features: ['海域范围可调', '轨迹位置重叠分析', '时空伴随发现', '起降模型研判', '智能交互分析'],
  },
  {
    id: 'app-010',
    name: '航母舰载机挖掘分析',
    description: '融合航母轨迹、舰载机飞行轨迹和起降窗口，挖掘疑似舰载机活动线索与伴随关系。',
    longDescription: '面向航母舰载机活动线索挖掘，融合航母轨迹、舰载机飞行轨迹、起降窗口和海域活动特征，识别疑似舰载机集群活动、伴随关系和异常出动模式，辅助研判航母航空作战能力与任务动向。',
    icon: '航',
    category: '情报分析',
    status: '新品',
    version: 'v1.0.0',
    vendor: '领铄',
    publishDate: '2026-06-28',
    link: 'http://220.154.5.91:18010/',
    features: ['活动线索挖掘', '轨迹伴随分析', '起降窗口关联', '异常出动识别', '任务动向研判'],
  },
]

function toBundleObject(app) {
  return `{id:${JSON.stringify(app.id)},name:${JSON.stringify(app.name)},description:${JSON.stringify(app.description)},longDescription:${JSON.stringify(app.longDescription)},icon:${JSON.stringify(app.icon)},category:${JSON.stringify(app.category)},status:${JSON.stringify(app.status)},version:${JSON.stringify(app.version)},vendor:${JSON.stringify(app.vendor)},publishDate:${JSON.stringify(app.publishDate)},link:${JSON.stringify(app.link)},favorited:!1,features:${JSON.stringify(app.features)}}`
}

const replacement = `$f=[${apps.map(toBundleObject).join(',')}]`

for (const file of files) {
  const path = resolve(file)
  const source = readFileSync(path, 'utf8')
  let updated = source.replace(/\$f=\[[\s\S]*?\](?=,Wf=)/, replacement)
  updated = updated.replace(
    /const (?:newRecPriority=\{[^}]*\},)?m=w\.filter\(M=>M\.status==="新品"\)(?:\.sort\(\(M,O\)=>\(newRecPriority\[M\.name\]\?\?99\)-\(newRecPriority\[O\.name\]\?\?99\)\))?;/,
    'const newRecPriority={"航母舰载机挖掘分析":0,"航母甲板风条件评估看板":1,"华盛顿号航母打击群西太地区活动规律分析智能体":2},m=w.filter(M=>M.status==="新品").sort((M,O)=>(newRecPriority[M.name]??99)-(newRecPriority[O.name]??99));',
  )
  if (updated === source) throw new Error(`Did not update bundle in ${file}`)
  writeFileSync(path, updated, 'utf8')
}
