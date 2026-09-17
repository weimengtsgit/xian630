// 内置海区表：≥8 个主要海域（示意格网，bbox 为 [minLon, minLat, maxLon, maxLat]）。
// 演示散点仅落在海域内；聚类海域判定基于该表。

export const SEA_AREAS = [
  { id: 'wpac', name: '西太平洋', bbox: [126, 12, 148, 38] },
  { id: 'scs', name: '南海', bbox: [107, 3, 120, 22] },
  { id: 'ecs', name: '东海', bbox: [120, 24, 128, 32] },
  { id: 'arab', name: '阿拉伯海', bbox: [60, 6, 74, 22] },
  { id: 'beng', name: '孟加拉湾', bbox: [82, 5, 92, 20] },
  { id: 'med', name: '地中海', bbox: [6, 32, 28, 40] },
  { id: 'natl', name: '北大西洋', bbox: [-42, 36, -22, 56] },
  { id: 'satl', name: '南大西洋', bbox: [-24, -34, -6, -16] },
  { id: 'carib', name: '加勒比海', bbox: [-84, 10, -62, 22] },
  { id: 'gulf', name: '波斯湾', bbox: [49, 25, 57, 29] },
  { id: 'north', name: '北海', bbox: [-1, 52, 7, 59] },
  { id: 'coral', name: '珊瑚海', bbox: [150, -22, 160, -8] },
];

export const SEA_AREA_BY_NAME = Object.fromEntries(SEA_AREAS.map((a) => [a.name, a]));

export function seaAreaForPoint(lon, lat) {
  for (const area of SEA_AREAS) {
    const [lo1, la1, lo2, la2] = area.bbox;
    if (lon >= lo1 && lon <= lo2 && lat >= la1 && lat <= la2) return area;
  }
  return null;
}

export function seaAreaCenter(area) {
  const [lo1, la1, lo2, la2] = area.bbox;
  return [(lo1 + lo2) / 2, (la1 + la2) / 2];
}
