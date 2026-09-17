// 港口档案、判定口径与刷新策略常量（静态配置，非外源数据）。
//
// 泊位基准水深 chartedDepthM 为公开资料整理缺省值（数据接入阶段已确认沿用，待官方海图校准）。
// 潮高判定阈值换算：thresholdValueM = DRAFT_LIMIT_M − chartedDepthM，
// 结果落在与该港潮高相同的基准（tideDatum）上，可与潮高直接比较。

export const DRAFT_LIMIT_M = 12.8;           // 航母吃水阈值（米）
export const REFRESH_INTERVAL_MINUTES = 10;  // 自动刷新周期（分钟）
export const STALE_AFTER_MINUTES = 10;       // 超过该时长未成功刷新 → 数据陈旧
export const FORECAST_HOURS = 72;            // 预测覆盖窗口（小时）
export const FETCH_TIMEOUT_MS = 10000;       // 单次取数超时（毫秒）

export const PORTS = [
  {
    key: 'norfolk',
    portId: '8638610',
    portName: '诺福克',
    portNameEn: 'Norfolk',
    portCode: '诺福克海军基地 NOB Norfolk',
    lat: 36.95,
    lng: -76.33,
    timezone: 'America/New_York',
    tzLabel: '美东当地时间',
    tideDatum: 'MLLW（平均低低潮基准）',
    tideDatumShort: 'MLLW',
    chartedDepthM: 12.2,
    chartedDepthSource: '公开资料整理缺省值（待校准）',
    sourceKind: 'noaa',
    dataSourceName: 'NOAA CO-OPS 预测 API · 站 8638610',
    dataSourceUrl: 'https://tidesandcurrents.noaa.gov/stations.html',
    note: '',
  },
  {
    key: 'sandiego',
    portId: '9410170',
    portName: '圣迭戈',
    portNameEn: 'San Diego',
    portCode: '圣迭戈海军基地 Naval Base San Diego',
    lat: 32.68,
    lng: -117.13,
    timezone: 'America/Los_Angeles',
    tzLabel: '美西当地时间',
    tideDatum: 'MLLW（平均低低潮基准）',
    tideDatumShort: 'MLLW',
    chartedDepthM: 12.0,
    chartedDepthSource: '公开资料整理缺省值（待校准）',
    sourceKind: 'noaa',
    dataSourceName: 'NOAA CO-OPS 预测 API · 站 9410170',
    dataSourceUrl: 'https://tidesandcurrents.noaa.gov/stations.html',
    note: '',
  },
  {
    key: 'bremerton',
    portId: '9447130',
    portName: '布雷默顿',
    portNameEn: 'Bremerton · 普吉特湾',
    portCode: '布雷默顿普吉特湾海军船厂 PSNS',
    lat: 47.56,
    lng: -122.63,
    timezone: 'America/Los_Angeles',
    tzLabel: '美西当地时间',
    tideDatum: 'MLLW（平均低低潮基准）',
    tideDatumShort: 'MLLW',
    chartedDepthM: 12.2,
    chartedDepthSource: '公开资料整理缺省值（待校准）',
    sourceKind: 'noaa',
    dataSourceName: 'NOAA CO-OPS 预测 API · 站 9447130（普吉特湾/西雅图）',
    dataSourceUrl: 'https://tidesandcurrents.noaa.gov/stations.html',
    note: '布雷默顿本站 9446486 不发布 MLLW 逐时预测，采用普吉特湾预测站 9447130（西雅图）作为邻近工作源。',
  },
  {
    key: 'yokosuka',
    portId: '1407',
    portName: '横须贺',
    portNameEn: 'Yokosuka',
    portCode: '横须贺海军基地 Fleet Activities Yokosuka',
    lat: 35.29,
    lng: 139.67,
    timezone: 'Asia/Tokyo',
    tzLabel: '日本当地时间',
    tideDatum: '平均海面基准',
    tideDatumShort: '平均海面',
    chartedDepthM: 11.9,
    chartedDepthSource: '公开资料整理缺省值（待校准）',
    sourceKind: 'jcg',
    dataSourceName: 'JCG 日本海上保安厅潮汐推算 · area=1407',
    dataSourceUrl: 'https://www1.kaiho.mlit.go.jp/TIDE/pred2/',
    note: 'JCG 毎時潮高表单位为 cm（平均海面基准），解析后换算为 m。',
  },
];

export const PORT_BY_KEY = Object.fromEntries(PORTS.map((p) => [p.key, p]));

// 潮高判定阈值（米，与该港潮高同基准）：12.8 − 泊位基准水深
export function thresholdFor(port) {
  return DRAFT_LIMIT_M - port.chartedDepthM;
}
