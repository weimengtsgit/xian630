// 快照构建（派生计算层）：对全部网格一次性求值，供 UI 消费。
// 产出：当前值、30 天基线、比率、分级、近 24h 序列、告警事件、聚合统计、数据流状态。
import {
  ANCHOR_EPOCH_MS,
  TICK_MS,
  RECENT_WINDOW_TICKS,
  FEED_CYCLE_TICKS,
  FEED_OUTAGE_TICK_PHASES,
} from '../constants.js';
import { ALL_GRIDS } from '../data/gridConfig.js';
import { classifyRatio, LEVEL_ORDER } from './alertRule.js';
import { baseline30d, recentSeries } from './seriesGen.js';

// 演示数据流状态（确定性段位注入）：每 288 tick 周期固定相位中断 2 步（6 分钟）
export function feedStatusAtTick(tick) {
  const phase = ((tick % FEED_CYCLE_TICKS) + FEED_CYCLE_TICKS) % FEED_CYCLE_TICKS;
  return FEED_OUTAGE_TICK_PHASES.includes(phase) ? 'interrupted' : 'live';
}

// 中断段预计恢复时刻（用于错误态文案；非中断 tick 返回 null）
export function outageRecoverAtMs(tick) {
  if (feedStatusAtTick(tick) !== 'interrupted') return null;
  const cycleStart = Math.floor(tick / FEED_CYCLE_TICKS) * FEED_CYCLE_TICKS;
  const lastPhase = Math.max(...FEED_OUTAGE_TICK_PHASES);
  return ANCHOR_EPOCH_MS + (cycleStart + lastPhase + 1) * TICK_MS;
}

// 构建指定游标时刻的全量快照
export function buildSnapshot(refTick) {
  const generatedAtMs = ANCHOR_EPOCH_MS + refTick * TICK_MS;

  const cells = ALL_GRIDS.map((grid) => {
    const baseline = baseline30d(grid, refTick);
    const recent = recentSeries(grid, refTick);
    const currentCount = recent[recent.length - 1];
    const ratio = baseline > 0 ? currentCount / baseline : NaN;
    const level = classifyRatio(ratio);

    // 告警事件扫描：近 24h 窗口内分级转换点（分母取当前基线，窗口内基线漂移可忽略）
    const events = [];
    let prev = 'none';
    for (let i = 0; i < recent.length; i++) {
      const lv = baseline > 0 ? classifyRatio(recent[i] / baseline) : 'none';
      if (lv !== prev) {
        events.push({
          tsMs: ANCHOR_EPOCH_MS + (refTick - (RECENT_WINDOW_TICKS - 1 - i)) * TICK_MS,
          from: prev,
          to: lv,
          ratioPct: baseline > 0 ? Math.round((recent[i] / baseline) * 100) : null,
        });
        prev = lv;
      }
    }

    return {
      grid,
      baseline30d: baseline,
      currentCount,
      ratio,
      ratioPct: baseline > 0 ? Math.round(ratio * 100) : null,
      level,
      recent,
      recentT0Ms: ANCHOR_EPOCH_MS + (refTick - (RECENT_WINDOW_TICKS - 1)) * TICK_MS,
      recentStepMs: TICK_MS,
      events,
    };
  });

  // 聚合统计（全域口径）
  const byLevel = { green: 0, yellow: 0, red: 0, none: 0 };
  const alertAreas = new Set();
  for (const cell of cells) {
    byLevel[cell.level] += 1;
    if (cell.level === 'red' || cell.level === 'yellow') alertAreas.add(cell.grid.seaAreaId);
  }

  // 当前告警清单：红优先黄次之，同级按比率升序（更严重在前）
  const alerts = cells
    .filter((c) => c.level === 'red' || c.level === 'yellow')
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.ratioPct - b.ratioPct);

  return {
    refTick,
    generatedAtMs,
    feedStatus: feedStatusAtTick(refTick),
    cells,
    alerts,
    totals: {
      totalGrids: cells.length,
      greenCount: byLevel.green,
      yellowCount: byLevel.yellow,
      redCount: byLevel.red,
      noneCount: byLevel.none,
      alertSeaAreaCount: alertAreas.size,
    },
  };
}
