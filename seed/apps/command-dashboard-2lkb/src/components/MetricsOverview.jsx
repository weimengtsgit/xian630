// 指标总览条：监控网格总数、绿/黄/红计数、告警海域数、上次刷新时间（口径：全部海域或当前选中海域）
import { fmtDateTime } from '../utils/format.js';

export default function MetricsOverview({ totals, lastUpdatedAt, scopeLabel, isStale, ready = true }) {
  const dash = ready ? null : '—';
  const items = [
    { icon: '▦', label: `监控网格 · ${scopeLabel}`, value: ready ? totals.totalGrids : dash, unit: '格' },
    { icon: '●', label: '正常', value: ready ? totals.greenCount : dash, unit: '格', cls: 'mv-green' },
    { icon: '▲', label: '净空预警', value: ready ? totals.yellowCount : dash, unit: '格', cls: 'mv-yellow' },
    { icon: '■', label: '净空告警', value: ready ? totals.redCount : dash, unit: '格', cls: 'mv-red' },
    { icon: '⌖', label: '告警海域', value: ready ? totals.alertSeaAreaCount : dash, unit: '个', cls: 'mv-area' },
  ];
  return (
    <section className={`metrics${isStale ? ' metrics-stale' : ''}`} aria-label="指标总览">
      {items.map((it, i) => (
        <div className={`metric ${it.cls || ''}`} key={i}>
          <span className="metric-icon" aria-hidden="true">{it.icon}</span>
          <span className="metric-body">
            <span className="metric-label">{it.label}</span>
            <span className="metric-value num">
              {it.value}
              <i>{ready ? it.unit : ''}</i>
            </span>
          </span>
        </div>
      ))}
      <div className="metric metric-time">
        <span className="metric-icon" aria-hidden="true">⟳</span>
        <span className="metric-body">
          <span className="metric-label">上次刷新{isStale ? '（滞后）' : ''}</span>
          <span className="metric-value num">{lastUpdatedAt ? fmtDateTime(lastUpdatedAt) : '—'}</span>
        </span>
      </div>
    </section>
  );
}
