// 网格方格卡：编号 + 当前在航商船数 + 当前/基线比率 + 近 24h 曲线（实线）+ 30 天基线（虚线）+ 图标/中文状态徽标
// compact 变体（<768px）：紧凑行卡（编号+数量+比率+状态徽标+可展开曲线），选中即展开。
import Sparkline from './Sparkline.jsx';
import StatusBadge from './StatusBadge.jsx';
import { fmtCount, fmtBaseline, fmtPct } from '../utils/format.js';

export default function GridCell({ cell, selected, onSelect, compact = false, loading = false }) {
  const meta = { green: '正常', yellow: '净空预警', red: '净空告警', none: '基线不可算' }[cell.level];
  if (loading) {
    return (
      <div className="cell cell-skel" aria-hidden="true">
        <span className="skel skel-line w40" />
        <span className="skel skel-num" />
        <span className="skel skel-line w60" />
        <span className="skel skel-spark" />
      </div>
    );
  }
  const ariaLabel = `${cell.grid.gridId}（${cell.grid.seaAreaName}）：当前在航商船 ${fmtCount(cell.currentCount)} 艘，30 天基线 ${fmtBaseline(cell.baseline30d)}，比率 ${fmtPct(cell.ratioPct)}，状态 ${meta}`;
  if (compact) {
    return (
      <button
        type="button"
        id={`cell-${cell.grid.gridId}`}
        className={`cell-compact lv-${cell.level}${selected ? ' selected' : ''}`}
        onClick={() => onSelect(cell.grid.gridId)}
        onFocus={() => onSelect(cell.grid.gridId)}
        aria-label={ariaLabel}
        aria-expanded={selected}
      >
        <span className="cc-main">
          <span className="cc-id num">{cell.grid.gridId}</span>
          <span className="cc-count num">
            <b>{fmtCount(cell.currentCount)}</b>艘
          </span>
          <span className="cc-ratio num">比率 {fmtPct(cell.ratioPct)}</span>
          <StatusBadge level={cell.level} compact />
          <span className="cc-chevron" aria-hidden="true">{selected ? '▾' : '▸'}</span>
        </span>
        {selected && (
          <span className="cc-expand">
            <span className="cc-baseline num">30 天基线 {fmtBaseline(cell.baseline30d)} · 近 24h 走势与基线对比</span>
            <Sparkline
              series={cell.recent}
              baseline={cell.baseline30d}
              t0Ms={cell.recentT0Ms}
              stepMs={cell.recentStepMs}
              ariaName={`${cell.grid.gridId} `}
            />
          </span>
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      id={`cell-${cell.grid.gridId}`}
      className={`cell lv-${cell.level}${selected ? ' selected' : ''}`}
      onClick={() => onSelect(cell.grid.gridId)}
      onFocus={() => onSelect(cell.grid.gridId)}
      aria-label={ariaLabel}
    >
      <span className="cell-head">
        <span className="cell-id num">{cell.grid.gridId}</span>
        <StatusBadge level={cell.level} />
      </span>
      <span className="cell-num num">
        <b>{fmtCount(cell.currentCount)}</b>
        <i>艘在航</i>
      </span>
      <span className="cell-meta num">
        基线 {fmtBaseline(cell.baseline30d)} · 比率 <b className={`rp lv-${cell.level}-t`}>{fmtPct(cell.ratioPct)}</b>
      </span>
      <Sparkline
        series={cell.recent}
        baseline={cell.baseline30d}
        t0Ms={cell.recentT0Ms}
        stepMs={cell.recentStepMs}
        ariaName={`${cell.grid.gridId} `}
      />
    </button>
  );
}
