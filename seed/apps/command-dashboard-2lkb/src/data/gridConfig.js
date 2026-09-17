// 演示网格静态配置（网格定义唯一来源）：4 海域 × 每海域 8 格（2 行 × 4 列），共 32 格，边长固定 50 海里。
// 本文件属数据层：只做静态定义与算术展开，不含任何随机数与三角函数（生成器在 src/utils/seriesGen.js）。
import { GRID_EDGE_NM } from '../constants.js';

// 美航母主要活动海域（演示配置）：基准经纬度为演示值，界面标注"演示坐标"
export const SEA_AREAS = [
  { id: 'wpac', code: 'WPAC', name: '西太平洋', baseLat: 24.5, baseLon: 131.0 },
  { id: 'scs', code: 'SCS', name: '南海', baseLat: 14.2, baseLon: 113.5 },
  { id: 'mea', code: 'MEA', name: '中东', baseLat: 23.8, baseLon: 60.5 },
  { id: 'med', code: 'MED', name: '地中海', baseLat: 34.2, baseLon: 18.5 },
];

export const GRID_ROWS = 2;
export const GRID_COLS = 4;

// 演示网格步距：约 50 海里网格的邻格中心距（演示近似常数，非运行时三角换算）
const LAT_STEP_DEG = 0.85; // 纬向步距 ≈ 0.85° ≈ 51 海里
const LON_STEP_DEG = 0.95; // 经向步距（中低纬度演示近似）≈ 51 海里

// 展开全部 32 个网格：gridId 形如 WPAC-r1c1，坐标取网格中心（演示值）
function buildGrids() {
  const grids = [];
  for (const area of SEA_AREAS) {
    for (let r = 1; r <= GRID_ROWS; r++) {
      for (let c = 1; c <= GRID_COLS; c++) {
        grids.push({
          gridId: `${area.code}-r${r}c${c}`,
          gridLabel: `${area.code}-r${r}c${c}`,
          seaAreaId: area.id,
          seaAreaName: area.name,
          edgeLenNm: GRID_EDGE_NM,
          centerLat: Number((area.baseLat + (r - 1) * LAT_STEP_DEG).toFixed(2)),
          centerLon: Number((area.baseLon + (c - 1) * LON_STEP_DEG).toFixed(2)),
        });
      }
    }
  }
  return grids;
}

export const ALL_GRIDS = buildGrids();

// 读取与归一化：按海域过滤网格
export function gridsOfArea(seaAreaId) {
  if (!seaAreaId || seaAreaId === 'all') return ALL_GRIDS;
  return ALL_GRIDS.filter((g) => g.seaAreaId === seaAreaId);
}
