// 演示序列生成器：种子化确定性生成（mulberry32），同一（时刻, 网格）全网取值一致、刷新可复现。
// 依据数据接入契约：确定性生成器置于 src/utils/；数据层目录（src/data/）只做读取与归一化。
// 序列包含昼夜节律、种子噪声与预置锐减（净空）场景段，支撑 30 天滑动平均基线与黄/红告警验收。
import { ANCHOR_EPOCH_MS, TICK_MS, RECENT_WINDOW_TICKS, BASELINE_WINDOW_HOURS } from '../constants.js';
import { noiseAt } from './prng.js';

// 正常段波动参数
const CYCLE_AMP = 0.08; // 昼夜节律幅度（商船活动昼间/夜间差异）
const NOISE_AMP = 0.05; // 种子噪声幅度
// 净空段波动收窄（数量低位平稳），保证黄/红分级在验收演示中稳定可触发
const DROP_CYCLE_AMP = 0.03;
const DROP_NOISE_AMP = 0.03;

// 预置锐减场景（验收保障：≥2 格黄、≥2 格红、跨 ≥2 海域）
// key = gridId；value = 净空段相对基线水平的目标乘数
const DROPOUT_GRIDS = {
  'WPAC-r2c3': 0.38, // 净空告警（红，ratio<0.50）
  'MED-r1c2': 0.41, // 净空告警（红，ratio<0.50）
  'SCS-r1c4': 0.61, // 净空预警（黄，0.50≤ratio<0.70）
  'WPAC-r1c2': 0.63, // 净空预警（黄，0.50≤ratio<0.70）
};
// 锐减时间窗：距当前游标 130 tick（约 6.5 小时）前开始，30 分钟内锐减到位
const DROP_START_PHASE = 130;
const DROP_RAMP_TICKS = 10;

export function isDropoutGrid(gridId) {
  return Object.prototype.hasOwnProperty.call(DROPOUT_GRIDS, gridId);
}

// 每格基线水平（18~60 艘，由 gridId 确定性散列，带缓存）
const baseCache = new Map();
export function baseLevelOf(gridId) {
  let v = baseCache.get(gridId);
  if (v === undefined) {
    const unit = (noiseAt('base:' + gridId, 11) + 1) / 2; // 0..1
    v = Math.round(18 + unit * 42);
    baseCache.set(gridId, v);
  }
  return v;
}

// 每格昼夜相位偏移（确定性）
const phaseCache = new Map();
function dayPhaseOf(gridId) {
  let v = phaseCache.get(gridId);
  if (v === undefined) {
    v = noiseAt('phase:' + gridId, 5) * Math.PI;
    phaseCache.set(gridId, v);
  }
  return v;
}

// 锐减场景乘数：phase = 当前游标 - 序列点游标（越大越久远）
// phase > 130：正常 1；130..120：线性过渡 1→target；< 120：维持 target
function scenarioFactor(gridId, phase) {
  const target = DROPOUT_GRIDS[gridId];
  if (target === undefined || phase > DROP_START_PHASE) return 1;
  if (phase >= DROP_START_PHASE - DROP_RAMP_TICKS) {
    const k = (DROP_START_PHASE - phase) / DROP_RAMP_TICKS;
    return 1 + (target - 1) * k;
  }
  return target;
}

// 网格在任意时刻的演示在航商船数（唯一取值入口，小时点与 3 分钟点共用）
export function countAt(grid, tMs, refTick) {
  const tick = Math.floor((tMs - ANCHOR_EPOCH_MS) / TICK_MS);
  const phase = refTick - tick;
  const scenario = scenarioFactor(grid.gridId, phase);
  const inDrop = scenario < 1;
  const cycleAmp = inDrop ? DROP_CYCLE_AMP : CYCLE_AMP;
  const noiseAmp = inDrop ? DROP_NOISE_AMP : NOISE_AMP;
  const hourFrac = (((tMs / 3600000) % 24) + 24) % 24;
  const cycle = 1 + cycleAmp * Math.sin((2 * Math.PI * hourFrac) / 24 + dayPhaseOf(grid.gridId));
  const noise = 1 + noiseAmp * noiseAt('cnt:' + grid.gridId, tick);
  return Math.max(0, Math.round(baseLevelOf(grid.gridId) * cycle * scenario * noise));
}

// 近 24h 走势序列（3 分钟粒度 480 点，末位为当前游标值）
export function recentSeries(grid, refTick) {
  const values = new Array(RECENT_WINDOW_TICKS);
  for (let i = 0; i < RECENT_WINDOW_TICKS; i++) {
    const tick = refTick - (RECENT_WINDOW_TICKS - 1 - i);
    values[i] = countAt(grid, ANCHOR_EPOCH_MS + tick * TICK_MS, refTick);
  }
  return values;
}

// 30 天滑动平均密度基线：过去 720 个整点小时值的均值（窗口随游标前移）
export function baseline30d(grid, refTick) {
  const nowHour = Math.floor((ANCHOR_EPOCH_MS + refTick * TICK_MS) / 3600000);
  let sum = 0;
  for (let h = nowHour - BASELINE_WINDOW_HOURS; h < nowHour; h++) {
    sum += countAt(grid, ANCHOR_EPOCH_MS + h * 3600000, refTick);
  }
  return sum / BASELINE_WINDOW_HOURS;
}

// 30 天小时粒度序列（下钻大图，720 点）
export function history30dSeries(grid, refTick) {
  const nowHour = Math.floor((ANCHOR_EPOCH_MS + refTick * TICK_MS) / 3600000);
  const values = new Array(BASELINE_WINDOW_HOURS);
  for (let i = 0; i < BASELINE_WINDOW_HOURS; i++) {
    const h = nowHour - BASELINE_WINDOW_HOURS + i;
    values[i] = countAt(grid, ANCHOR_EPOCH_MS + h * 3600000, refTick);
  }
  return values;
}
