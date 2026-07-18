// 监测区域和判定阈值属于业务规则，不是 CSV/接口返回的数据。
export const MONITORED_AREAS = [
  { id: "bahrain-gulf-test", name: "巴林港区/波斯湾测试点", center: { lon: 50.608, lat: 26.205 }, radiusNm: 3 },
  { id: "san-diego-naval-area", name: "圣迭戈军港周边", center: { lon: -117.24, lat: 32.77 }, radiusNm: 15 },
  { id: "south-china-sea-low-speed", name: "南海低速活动区", center: { lon: 120.985, lat: 14.562 }, radiusNm: 10 },
  { id: "taiwan-southwest-offshore", name: "台湾西南近海活动区", center: { lon: 120.28, lat: 22.6 }, radiusNm: 10 },
];

export const JUDGEMENT_PARAMETERS = {
  lowSpeedMaxKn: 3,
  lowSpeedDurationMinutes: 10,
  repeatedPathRatio: 3,
  aisGapWarningMinutes: 30,
  aisGapCriticalMinutes: 360,
  segmentGapMinutes: 360,
  segmentJumpNm: 50,
};
