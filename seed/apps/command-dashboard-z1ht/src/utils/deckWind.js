// 甲板风矢量合成与起降条件分级（判定核心，纯函数，可复核）
// 模型（需求固定口径，常量不可被数据覆盖）：
//   W = 航母活动区域 10 米自然风速（节，Open-Meteo GFS 当前 UTC 小时槽）
//   可实现甲板风范围 = [ |W − 30|, W + 30 ]（30 节 = 航母最大航速）
//   阈值 20 节：
//     |W−30| ≥ 20        → 满足（全向）：任意航向/航速组合下甲板风均 ≥ 20 节
//     |W−30| < 20 ≤ W+30 → 条件满足：需顶风并采用最大航速机动
//     W+30 < 20          → 不满足
//     数据失败/不可信    → 无法判定（显示错误态，不给出数值结论）
import { DECK_WIND_THRESHOLD_KT, CARRIER_MAX_SPEED_KT, GRADE_LABELS } from '../constants.js';

// 16 方位罗盘文本（索引取整，无三角运算）
const CARDINAL_16 = [
  '北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
  '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北',
];

export function directionCardinal16(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '—';
  const idx = ((Math.round(d / 22.5) % 16) + 16) % 16;
  return CARDINAL_16[idx];
}

// 判定主函数：输入当前小时槽自然风速（节），输出合成范围、分级与两项判定。
// 返回 null 表示输入无效（调用方应呈现「无法判定」，不得伪造数值）。
export function assessDeckWind(windSpeedKt) {
  const w = Number(windSpeedKt);
  if (!Number.isFinite(w) || w < 0) return null;

  const minDeck = Math.abs(w - CARRIER_MAX_SPEED_KT);
  const maxDeck = w + CARRIER_MAX_SPEED_KT;
  const t = DECK_WIND_THRESHOLD_KT;

  let grade;
  if (minDeck >= t) grade = 'satisfied';
  else if (maxDeck >= t) grade = 'conditional';
  else grade = 'unsatisfied';

  // 两项判定共用 20 节阈值（需求固定口径）：上限可达即视为可行
  const feasible = maxDeck >= t;

  return {
    naturalWindKt: w,
    minDeckWindKt: minDeck,
    maxDeckWindKt: maxDeck,
    thresholdKt: t,
    maxSpeedKt: CARRIER_MAX_SPEED_KT,
    grade,
    gradeLabel: GRADE_LABELS[grade],
    unassistedTakeoff: feasible, // 「无弹射器辅助起飞」
    safeRecovery: feasible, // 「安全着舰」
    basisText: buildBasisText(grade, w, minDeck, maxDeck, t),
  };
}

// 「无法判定」视图模型（风场缺失时使用，不携带任何数值结论）
export function undeterminedAssessment(reasonText) {
  return {
    naturalWindKt: null,
    minDeckWindKt: null,
    maxDeckWindKt: null,
    thresholdKt: DECK_WIND_THRESHOLD_KT,
    maxSpeedKt: CARRIER_MAX_SPEED_KT,
    grade: 'undetermined',
    gradeLabel: GRADE_LABELS.undetermined,
    unassistedTakeoff: null,
    safeRecovery: null,
    basisText: reasonText || '风场数据不可用，不做判定（不展示估算值）',
  };
}

// 依据文案：展示 |W−30|、W+30 与 20 节阈值的对比，保证判定可复核
function buildBasisText(grade, w, minDeck, maxDeck, t) {
  const f = (v) => v.toFixed(1);
  if (grade === 'satisfied') {
    return `自然风 W=${f(w)} 节：|W−30|=${f(minDeck)} ≥ ${t} 节，任意航向/航速组合下甲板风均 ≥ ${t} 节，「无弹射器辅助起飞」与「安全着舰」条件均满足。`;
  }
  if (grade === 'conditional') {
    return `自然风 W=${f(w)} 节：|W−30|=${f(minDeck)} < ${t} ≤ W+30=${f(maxDeck)} 节，需航母顶风并采用最大航速（30 节）机动方可合成 ≥ ${t} 节甲板风，两项条件可行但依赖机动。`;
  }
  return `自然风 W=${f(w)} 节：W+30=${f(maxDeck)} < ${t} 节，当前自然风下无法合成 ${t} 节甲板风，两项条件均不满足。`;
}

// 摘要文案（矩阵徽标悬浮/详情用）
export function gradeSummary(deckWind) {
  if (!deckWind) return GRADE_LABELS.undetermined;
  return deckWind.gradeLabel;
}
