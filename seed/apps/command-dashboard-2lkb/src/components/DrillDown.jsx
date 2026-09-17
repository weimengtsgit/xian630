// 下钻详情面板（必选组件）：30 天走势大图（基线虚线 + 10% 面积填充）、当前/基线/比率统计、
// 70%/50% 阈值标尺与当前游标、网格元数据（海域 / 边长 50 海里 / 中心坐标演示值）、状态时间线。
import { useMemo } from 'react';
import { ANCHOR_EPOCH_MS, TICK_MS, BASELINE_WINDOW_HOURS, GRID_EDGE_NM } from '../constants.js';
import { history30dSeries } from '../utils/seriesGen.js';
import { LEVEL_META } from '../utils/alertRule.js';
import { fmtCount, fmtBaseline, fmtPct, fmtDateTime } from '../utils/format.js';
import StatusBadge from './StatusBadge.jsx';
import TrendChart from './TrendChart.jsx';
import ThresholdRuler from './ThresholdRuler.jsx';

export default function DrillDown({ cell, refTick }) {
  const history = useMemo(() => history30dSeries(cell.grid, refTick), [cell.grid.gridId, refTick]);
  const hourStepMs = 3600000;
  // 30 天窗口起点（小时粒度，随游标前移）
  const t0Ms = useMemo(() => {
    const nowHour = Math.floor((ANCHOR_EPOCH_MS + refTick * TICK_MS) / 3600000);
    return ANCHOR_EPOCH_MS + (nowHour - BASELINE_WINDOW_HOURS) * hourStepMs;
  }, [refTick]);
  const events = useMemo(() => [...cell.events].reverse(), [cell.events]);

  return (
    <section className="drilldown" aria-label={`网格 ${cell.grid.gridId} 下钻详情`}>
      <header className="dd-head">
        <span className="dd-title num">{cell.grid.gridId}</span>
        <StatusBadge level={cell.level} />
      </header>

      <dl className="dd-meta">
        <div><dt>所属海域</dt><dd>{cell.grid.seaAreaName}</dd></div>
        <div><dt>网格边长</dt><dd className="num">{GRID_EDGE_NM} 海里</dd></div>
        <div><dt>中心坐标（演示值）</dt><dd className="num">{cell.grid.centerLat.toFixed(2)}°, {cell.grid.centerLon.toFixed(2)}°</dd></div>
      </dl>

      <div className="dd-stats">
        <div className="ds">
          <span className="ds-label">当前在航</span>
          <span className="ds-value num">{fmtCount(cell.currentCount)}<i>艘</i></span>
        </div>
        <div className="ds">
          <span className="ds-label">30 天基线</span>
          <span className="ds-value num">{fmtBaseline(cell.baseline30d)}<i>艘</i></span>
        </div>
        <div className="ds">
          <span className="ds-label">当前/基线</span>
          <span className="ds-value num">{fmtPct(cell.ratioPct)}</span>
        </div>
      </div>

      <ThresholdRuler ratioPct={cell.ratioPct} />

      <div className="dd-chart">
        <h3 className="dd-sub">近 30 天商船数量走势（小时粒度，{BASELINE_WINDOW_HOURS} 点）</h3>
        <TrendChart series={history} baseline={cell.baseline30d} t0Ms={t0Ms} stepMs={hourStepMs} />
      </div>

      <div className="dd-timeline">
        <h3 className="dd-sub">状态时间线（近 24 小时阈值穿越事件）</h3>
        {events.length === 0 ? (
          <p className="dd-empty-timeline">近 24 小时无告警事件 · 状态持续正常</p>
        ) : (
          <ul className="tl">
            {events.map((ev, i) => (
              <li className={`tl-item tl-${ev.to}`} key={i}>
                <span className="tl-dot" aria-hidden="true">{LEVEL_META[ev.to] ? LEVEL_META[ev.to].icon : '·'}</span>
                <span className="tl-time num">{fmtDateTime(ev.tsMs)}</span>
                <span className="tl-desc">
                  {LEVEL_META[ev.from] ? LEVEL_META[ev.from].label : '—'} → <b>{LEVEL_META[ev.to] ? LEVEL_META[ev.to].label : '—'}</b>
                </span>
                <span className="tl-ratio num">{ev.ratioPct === null ? '' : `比率 ${ev.ratioPct}%`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
