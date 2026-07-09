import type { SmartApp, CategoryFilter } from '../types';

/**
 * 演示数据 — 智能应用商店内置四款智能软件。
 * 数据策略为 mock_data，所有数据均为演示用途。
 */
export const DEMO_APPS: SmartApp[] = [
  {
    id: 'app-001',
    name: '美航母AIS异常监测',
    description: '实时监测美国航母AIS信号异常，自动识别信号中断、轨迹偏离与伪装行为',
    longDescription:
      '基于全球AIS数据流，对美国航母及大型水面舰艇的AIS信号进行持续性监测。系统自动识别信号异常模式，包括信号突然中断、轨迹异常偏离、航速突变和疑似伪装行为，并生成告警事件供情报分析人员研判。',
    icon: '🚢',
    category: '态势监测',
    status: '热门',
    version: 'v2.4.1',
    publishDate: '2026-03-15',
    link: 'https://www.baidu.com',
    favorited: false,
    features: [
      'AIS信号实时监测与异常检测',
      '航母轨迹历史回放与对比',
      '信号中断自动告警',
      '异常行为模式库匹配',
      '每日态势报告自动生成',
    ],
  },
  {
    id: 'app-002',
    name: '航母舰载机归属推断工具',
    description: '通过ADS-B轨迹与舰载机特征库，推断舰载机所属航母及起降活动规律',
    longDescription:
      '融合ADS-B航空器轨迹数据与航母舰载机特征数据库，利用时空关联算法推断舰载机的母舰归属。支持航母空中联队编成识别、起降周期分析和舰载机活动热力图展示。',
    icon: '🛩️',
    category: '情报分析',
    status: '已上架',
    version: 'v1.8.0',
    publishDate: '2026-01-20',
    link: 'https://www.baidu.com',
    favorited: false,
    features: [
      '舰载机ADS-B轨迹关联分析',
      '航母归属概率推断引擎',
      '空中联队编成自动识别',
      '起降周期统计分析',
      '活动热力图可视化展示',
    ],
  },
  {
    id: 'app-003',
    name: '华盛顿号航母打击群活动规律平台',
    description: '追踪华盛顿号航母打击群部署动态，分析活动规律与战术模式',
    longDescription:
      '聚焦华盛顿号（CVN-73）航母打击群的全球部署活动，汇集多源情报数据，分析打击群的部署周期、航行规律、演训模式和区域存在特征，为战略态势评估提供数据支撑。',
    icon: '⚓',
    category: '活动规律',
    status: '新品',
    version: 'v1.2.0',
    publishDate: '2026-06-10',
    link: 'https://www.baidu.com',
    favorited: false,
    features: [
      '华盛顿号CSG部署时间线',
      '打击群编成与伴随舰艇追踪',
      '活动区域统计分析',
      '演训模式识别',
      '历史部署数据对比',
    ],
  },
  {
    id: 'app-004',
    name: 'xx智能体',
    description: '智能化情报分析助手，支持自然语言查询、多源数据融合与智能推理',
    longDescription:
      '面向情报分析场景的智能体应用，集成大语言模型能力，支持自然语言交互式查询、多源异构数据自动融合、情报关联图谱构建和智能推理辅助决策。',
    icon: '🤖',
    category: '智能助手',
    status: '新品',
    version: 'v0.9.0-beta',
    publishDate: '2026-06-25',
    link: 'https://www.baidu.com',
    favorited: false,
    features: [
      '自然语言情报查询',
      '多源数据自动融合',
      '情报关联图谱构建',
      '智能推理辅助决策',
      '查询历史与上下文记忆',
    ],
  },
];

/** 分类筛选选项 */
export const CATEGORY_FILTERS: CategoryFilter[] = [
  { key: 'all', label: '全部应用' },
  { key: '态势监测', label: '态势监测' },
  { key: '情报分析', label: '情报分析' },
  { key: '活动规律', label: '活动规律' },
  { key: '智能助手', label: '智能助手' },
];

/** 分类对应的颜色标识（CSS 变量名） */
export const CATEGORY_COLORS: Record<string, string> = {
  '态势监测': '#3b82f6',
  '情报分析': '#8b5cf6',
  '活动规律': '#f59e0b',
  '智能助手': '#10b981',
};
