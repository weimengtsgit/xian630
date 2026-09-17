// 地理工具：等距圆柱投影、Haversine 距离、海区判定。
// 地图为本地示意底图（非精确地理渲染），投影仅用于演示落点展示。

export const MAP_W = 960;
export const MAP_H = 480;

// 经纬度 → SVG 坐标（等距圆柱投影）
export function project(lon, lat) {
  return [((lon + 180) / 360) * MAP_W, ((90 - lat) / 180) * MAP_H];
}

export function unproject(x, y) {
  return [(x / MAP_W) * 360 - 180, 90 - (y / MAP_H) * 180];
}

const R_EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

// Haversine 距离（km）
export function distKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
}

// 半径 km → 地图上椭圆的 rx/ry（SVG 世界像素；可见下限由调用方按缩放级别决定）
export function radiusToPx(radiusKm, centerLat) {
  const degLat = radiusKm / 111;
  const degLon = radiusKm / (111 * Math.max(0.2, Math.cos(rad(centerLat))));
  const rx = (degLon / 360) * MAP_W;
  const ry = (degLat / 180) * MAP_H;
  return [rx, ry];
}

// 经纬度格式化为可读坐标徽标文本
export function formatCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}
