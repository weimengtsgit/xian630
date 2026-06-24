export const WORLD_WIDTH = 560;
export const WORLD_HEIGHT = 420;

export function projectWorld(lat, lon, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
  const safeLat = Math.max(-90, Math.min(90, Number(lat)));
  const safeLon = Math.max(-180, Math.min(180, Number(lon)));
  const x = ((safeLon + 180) / 360) * width;
  const y = ((90 - safeLat) / 180) * height;
  return [x, y];
}
