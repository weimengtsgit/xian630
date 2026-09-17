// 应用级常量与静态配置（公开常识表）
// 注意：本文件只承载判定常量、时效阈值与公开常识在册清单；
// 不包含任何风场数值或伪造的实时数据（数据一律来自运行时真实请求）。

// ── 判定模型固定常量（需求确认口径，不可被数据覆盖） ──────────────────────
export const DECK_WIND_THRESHOLD_KT = 20; // 甲板风阈值（节）
export const CARRIER_MAX_SPEED_KT = 30; // 航母最大航速（节），合成上限

// ── 刷新与超时配置 ─────────────────────────────────────────────────────────
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟自动刷新
export const REQUEST_TIMEOUT_MS = 15000; // 单请求超时 15s
export const WIND_REQUEST_RETRY = 1; // 失败重试 1 次后进入降级序

// ── 时效阈值（数据接入方案确认的值班口径） ────────────────────────────────
export const POSITION_FRESH_HOURS = 72; // ≤72h 正常
export const POSITION_STALE_DAYS = 7; // 72h–7d 陈旧；>7d 深度陈旧
export const WIND_SLOT_STALE_HOURS = 2; // 风场槽龄 >2h 标注陈旧

// ── 数据来源标签 ──────────────────────────────────────────────────────────
export const SOURCE_LABELS = {
  'open-meteo-gfs': 'Open-Meteo GFS 公开朗格',
  'open-meteo-bestmatch': 'Open-Meteo best_match 公开朗格',
  'ontology-daas': '本体 DaaS 公开情报位置库',
  'static-default-region': '静态默认活动区域（公开常识，非当前位置）',
  'ontology-ais': '本体 DaaS AIS 历史存档（佐证）',
};

// 官方数据源入口（降级态与详情面板引用）
export const OFFICIAL_SOURCE_LINKS = [
  { label: 'Open-Meteo GFS API（10 米风场）', url: 'https://open-meteo.com/en/docs/gfs-api' },
  { label: 'NOAA NOMADS GFS（模式官方源）', url: 'https://nomads.ncep.noaa.gov/' },
  { label: '本体 DaaS 接口文档目录（内部网络）', url: 'http://ceshi.projects.bingosoft.net:8081/ontology_docs/?doc=catalog' },
];

// ── 公开常识：美海军现役航母在册清单 + 默认活动区域代表点 ──────────────────
// 用途：航母位置库（本体 DaaS）不可用时的降级兜底口径——按各舰默认活动区域
// 代表点（母港外海，公开常识坐标）取风场评估，界面显著标注「非当前位置」。
// 舷号/舰级/母港均为公开常识；不代表当前实时位置。
export const STATIC_US_CARRIER_REGISTRY = [
  { id: 'CVN-68', name: '尼米兹号航空母舰', className: '尼米兹级', homeport: '布雷默顿',
    defaultRegion: { lat: 47.55, lon: -122.63, area: '美国西海岸·普吉特湾' } },
  { id: 'CVN-69', name: '艾森豪威尔号航空母舰', className: '尼米兹级', homeport: '诺福克',
    defaultRegion: { lat: 36.9, lon: -76.3, area: '美国东海岸·诺福克外海' } },
  { id: 'CVN-70', name: '卡尔·文森号航空母舰', className: '尼米兹级', homeport: '圣迭戈',
    defaultRegion: { lat: 32.68, lon: -117.13, area: '东太平洋·南加州近海' } },
  { id: 'CVN-71', name: '罗斯福号航空母舰', className: '尼米兹级', homeport: '圣迭戈',
    defaultRegion: { lat: 32.68, lon: -117.13, area: '东太平洋·南加州近海' } },
  { id: 'CVN-72', name: '林肯号航空母舰', className: '尼米兹级', homeport: '圣迭戈',
    defaultRegion: { lat: 32.68, lon: -117.13, area: '东太平洋·南加州近海' } },
  { id: 'CVN-73', name: '华盛顿号航空母舰', className: '尼米兹级', homeport: '横须贺',
    defaultRegion: { lat: 35.29, lon: 139.67, area: '西太平洋·东京湾口' } },
  { id: 'CVN-74', name: '斯坦尼斯号航空母舰', className: '尼米兹级', homeport: '布雷默顿',
    defaultRegion: { lat: 47.55, lon: -122.63, area: '美国西海岸·普吉特湾' } },
  { id: 'CVN-75', name: '杜鲁门号航空母舰', className: '尼米兹级', homeport: '诺福克',
    defaultRegion: { lat: 36.9, lon: -76.3, area: '美国东海岸·诺福克外海' } },
  { id: 'CVN-76', name: '里根号航空母舰', className: '尼米兹级', homeport: '布雷默顿',
    defaultRegion: { lat: 47.55, lon: -122.63, area: '美国西海岸·普吉特湾' } },
  { id: 'CVN-77', name: '布什号航空母舰', className: '尼米兹级', homeport: '诺福克',
    defaultRegion: { lat: 36.9, lon: -76.3, area: '美国东海岸·诺福克外海' } },
  { id: 'CVN-78', name: '福特号航空母舰', className: '福特级', homeport: '诺福克',
    defaultRegion: { lat: 36.9, lon: -76.3, area: '美国东海岸·诺福克外海' } },
];

// ── 分级与状态文案 ────────────────────────────────────────────────────────
export const GRADE_LABELS = {
  satisfied: '满足（全向）',
  conditional: '条件满足',
  unsatisfied: '不满足',
  undetermined: '无法判定',
};

export const DATA_QUALITY_LABELS = {
  normal: '正常',
  stale: '陈旧',
  error: '异常',
};

export const STALE_LEVEL_LABELS = {
  normal: '时效正常',
  stale: '位置陈旧',
  'deep-stale': '深度陈旧',
  unavailable: '时效不可用',
};

// 状态灯语义：绿=正常 黄=降级/陈旧 红=失败（颜色 + 文本双信号）
export const LIGHT_STATE_LABELS = {
  ok: '正常',
  degraded: '降级',
  error: '失败',
};
