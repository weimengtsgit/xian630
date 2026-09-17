import type { SmartApp, CategoryFilter } from '../types';

/**
 * 演示应用所在主机的地址前缀（含协议，不带端口）。
 * 构建期通过 VITE_DEMO_APP_HOST 注入（Dockerfile ARG → ENV），默认指向
 * 91 生产环境；部署到其他环境时用 --build-arg VITE_DEMO_APP_HOST=http://10.253.28.62
 * 之类覆盖，无需改代码。
 */
const DEMO_APP_HOST_BASE: string =
  import.meta.env.VITE_DEMO_APP_HOST || 'http://220.154.5.91';

/**
 * 演示数据 — 从线上 18016 当前运行产物还原的内置智能软件目录。
 * 动态新增应用通过 /api/apps 合并进列表。
 *
 * 2026-09-16 按"只保留公网/mock 数据"口径（91 实测）隐藏以下卡片：
 * app-001 AIS异常监测 / app-006 打击群规律 / app-010 舰载机挖掘 —— 本体平台（daasDMS）取数；
 * app-002 舰载机归属判断（91:18001 jzjsb3，data_source=mcp 本体）/ app-004 甲板风看板
 * （91:18009 jtln，航母位置取本体）—— 同为本体取数，实测后补隐藏；
 * app-003 华盛顿号 / app-009 时空伴随 —— 外部链接不可达，无法验证。
 * app-005 态势指挥仪表盘经 91 实测为 mock（mockData.ts、无外部 API），按口径保留。
 */
export const DEMO_APPS: SmartApp[] = [
  {
    id: 'app-005',
    name: '航母态势指挥仪表盘',
    description: '汇聚航母目标、编队、告警与任务指标，形成态势指挥总览。',
    longDescription:
      '面向航母态势指挥场景，集中展示航母目标状态、编队动态、告警事件、任务指标和区域态势，为值守人员提供一屏式指挥入口。',
    icon: '航',
    category: '状态研判',
    status: '已上架',
    version: 'v1.1.0',
    vendor: '电子云',
    publishDate: '2026-05-25',
    link: `${DEMO_APP_HOST_BASE}:18017/`,
    favorited: false,
    features: ['态势总览大屏', '目标状态汇聚', '告警事件联动', '任务指标监控', '指挥入口整合'],
  },
  {
    id: 'app-007',
    name: '航母母港潮汐出港窗口计算器',
    description: '结合母港潮位、吃水阈值和出港窗口，计算航母可用出港时间段。',
    longDescription:
      '面向航母母港出港保障场景，结合潮汐曲线、港口水深、舰艇吃水和安全阈值，计算可用出港窗口并给出风险提示。',
    icon: '航',
    category: '其他',
    status: '已上架',
    version: 'v1.0.0',
    vendor: '电子云',
    publishDate: '2026-06-28',
    link: `${DEMO_APP_HOST_BASE}:18000/`,
    favorited: false,
    features: ['潮汐窗口计算', '吃水阈值校核', '出港风险提示', '母港条件对比', '窗口结果汇总'],
  },
  // app-008 海域网格商船密度异常告警器已补隐藏：91 实测其内置样本溯源为
  // "ontology-AIS-实测(航母编队)"（bingosoft 本体平台实测航母编队 AIS 快照），非公网/mock。
];

/** 分类筛选选项 */
export const CATEGORY_FILTERS: CategoryFilter[] = [
  { key: 'all', label: '全部' },
  { key: '状态研判', label: '状态研判' },
  { key: '动向研判', label: '动向研判' },
  { key: '意图研判', label: '意图研判' },
  { key: '威胁研判', label: '威胁研判' },
  { key: '其他', label: '其他' },
];

/** 分类对应的颜色标识（CSS 变量名） */
export const CATEGORY_COLORS: Record<string, string> = {
  '状态研判': '#8CB7FF',
  '动向研判': '#F6B73C',
  '意图研判': '#A78BFA',
  '威胁研判': '#FF6B6B',
  '其他': '#9AA4B2',
};
