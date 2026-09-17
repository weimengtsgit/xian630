// 告警分级：唯一判定入口（阈值常量集中在 constants.js，判定顺序先红后黄）
import { RATIO_RED_THRESHOLD, RATIO_YELLOW_THRESHOLD } from '../constants.js';

// ratio = currentCount / baseline30d
// 返回 'red' | 'yellow' | 'green'；基线不可算时返回 'none'（走空态，不显示伪造分级）
export function classifyRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'none';
  if (ratio < RATIO_RED_THRESHOLD) return 'red'; // 先判红
  if (ratio < RATIO_YELLOW_THRESHOLD) return 'yellow'; // 再判黄
  return 'green';
}

// 状态徽标元数据：图标 + 中文标签（不以颜色为唯一通道）
export const LEVEL_META = {
  green: { icon: '●', label: '正常' },
  yellow: { icon: '▲', label: '净空预警' },
  red: { icon: '■', label: '净空告警' },
  none: { icon: '◌', label: '基线不可算' },
};

// 告警级别排序权重（红最优先）
export const LEVEL_ORDER = { red: 0, yellow: 1, green: 2, none: 3 };
