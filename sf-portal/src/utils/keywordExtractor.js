// 关键字提炼：从用户在 AI 应用生成助手对话中输入的文本里抽取关键字
// 策略：领域词典子串匹配 + 英文/数字 token 切分，去重后取前 8 个

// 软件工厂 / 海空态势 业务领域词典
const DOMAIN_KEYWORDS = [
  // 作战与平台
  '航母', '舰艇', '战舰', '驱逐舰', '巡洋舰', '护卫舰', '两栖', '潜艇', '军港', '港口', '码头', '基地',
  '轨迹', '航线', '航迹', '航行', '态势', '情报', '侦察', '预警', '雷达', '电子战', '作战', '指挥', '协同',
  '编队', '任务', '辖区',
  // 数据源
  'AIS', 'ADS-B', '卫星', '遥感', '影像', '地理', '地图', '海图', '经纬度', '坐标',
  // 数据处理
  '数据', '采集', '抓取', '抽取', '清洗', '建模', '分析', '统计', '可视化', '图表', '指标', '密度', '分布',
  '报告', '日报', '周报', '告警', '预警', '监控', '监测', '实时', '历史',
  // 界面与前端
  '原型', '界面', '交互', '页面', '组件', '表单', '表格', '列表', '仪表盘', '大屏', '看板',
  // 工程与业务
  '应用', '系统', '平台', '服务', '模块', '功能', '需求', '业务', '流程', '逻辑',
  '用户', '权限', '登录', '认证', '鉴权', '角色',
  // 技术栈
  'React', 'Vue', 'Vite', 'TypeScript', 'JavaScript', 'Python', 'Java', 'Go', 'Docker', 'K8s', 'API', 'REST', 'GraphQL',
  'MySQL', 'PostgreSQL', 'Redis', 'Kafka', 'Elasticsearch',
  // 环境
  '气象', '水文', '风速', '风向', '温度', '湿度', '潮汐', '海况'
]

// 英文 token 停用词
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'are', 'be',
  'i', 'want', 'need', 'please', 'help', 'me', 'my', 'app', 'application'
])

export function extractKeywords(text) {
  if (!text || !text.trim()) return []

  const found = []
  const lower = text.toLowerCase()

  // 1. 领域词典子串匹配（对中文友好：能从无空格的整句中识别术语）
  for (const kw of DOMAIN_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      found.push(kw)
    }
  }

  // 2. 英文 / 数字 token 切分
  const tokens = text.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []
  for (const t of tokens) {
    const lt = t.toLowerCase()
    if (STOPWORDS.has(lt)) continue
    if (found.some((k) => k.toLowerCase() === lt)) continue
    found.push(t)
  }

  // 3. 去重并截断
  const seen = new Set()
  const out = []
  for (const k of found) {
    const key = k.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(k)
    }
    if (out.length >= 8) break
  }

  return out
}
