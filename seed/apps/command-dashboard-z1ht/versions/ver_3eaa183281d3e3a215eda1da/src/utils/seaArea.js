// 海域推定：经纬度落入公开常识海域框 → 海域名（顺序判定，小而具体的框在前）
// 说明：结果为「推定海域」标注，供值班参考，不代表精确海区划界。
const SEA_AREA_FRAMES = [
  { name: '地中海', minLat: 30, maxLat: 46, minLon: -6, maxLon: 36 },
  { name: '红海', minLat: 12, maxLat: 30, minLon: 32, maxLon: 43 },
  { name: '波斯湾', minLat: 24, maxLat: 30, minLon: 47, maxLon: 57 },
  { name: '阿拉伯海', minLat: 8, maxLat: 25, minLon: 55, maxLon: 75 },
  { name: '南中国海', minLat: 0, maxLat: 23, minLon: 105, maxLon: 121 },
  { name: '东海', minLat: 24, maxLat: 33, minLon: 120, maxLon: 130 },
  { name: '日本周边海域', minLat: 33, maxLat: 46, minLon: 129, maxLon: 146 },
  { name: '菲律宾海', minLat: 5, maxLat: 30, minLon: 121, maxLon: 150 },
  { name: '孟加拉湾', minLat: 5, maxLat: 22, minLon: 80, maxLon: 98 },
  { name: '印度洋', minLat: -35, maxLat: 25, minLon: 20, maxLon: 98 },
  { name: '珊瑚海', minLat: -25, maxLat: -8, minLon: 145, maxLon: 165 },
  { name: '西太平洋', minLat: 0, maxLat: 50, minLon: 120, maxLon: 180 },
  { name: '夏威夷周边海域', minLat: 15, maxLat: 26, minLon: -165, maxLon: -150 },
  { name: '美国西海岸近海', minLat: 32, maxLat: 50, minLon: -130, maxLon: -120 },
  { name: '东太平洋', minLat: -10, maxLat: 50, minLon: -180, maxLon: -100 },
  { name: '墨西哥湾', minLat: 18, maxLat: 31, minLon: -98, maxLon: -80 },
  { name: '加勒比海', minLat: 8, maxLat: 25, minLon: -90, maxLon: -58 },
  { name: '美国东海岸近海', minLat: 30, maxLat: 45, minLon: -82, maxLon: -70 },
  { name: '北大西洋', minLat: 25, maxLat: 65, minLon: -75, maxLon: 10 },
  { name: '南大西洋', minLat: -60, maxLat: 25, minLon: -70, maxLon: 20 },
  { name: '北印度洋—阿曼湾', minLat: 22, maxLat: 27, minLon: 56, maxLon: 68 },
];

export function resolveSeaArea(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  for (const f of SEA_AREA_FRAMES) {
    if (la >= f.minLat && la <= f.maxLat && lo >= f.minLon && lo <= f.maxLon) return f.name;
  }
  return '其他海域';
}
