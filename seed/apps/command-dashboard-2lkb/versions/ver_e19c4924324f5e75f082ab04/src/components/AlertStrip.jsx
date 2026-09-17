// 告警滚动条：红优先黄次之的净空告警摘要（网格、海域、当前/基线、比率），点击定位对应网格
import { LEVEL_META } from '../utils/alertRule.js';
import { fmtCount, fmtBaseline, fmtPct } from '../utils/format.js';

export default function AlertStrip({ alerts, onLocate, ready = true }) {
  return (
    <div className="alert-strip" role="region" aria-label="净空告警滚动条">
      {!ready ? (
        <span className="strip-empty strip-loading">
          <span className="fb-spinner" aria-hidden="true" /> 正在拉取演示数据流…
        </span>
      ) : alerts.length === 0 ? (
        <span className="strip-empty">
          <span aria-hidden="true">●</span> 全域正常 · 当前无净空预警 / 净空告警
        </span>
      ) : (
        <>
          <span className="strip-title">净空告警</span>
          <div className="strip-track">
            {alerts.map((cell) => {
              const meta = LEVEL_META[cell.level];
              return (
                <button
                  type="button"
                  key={cell.grid.gridId}
                  className={`chip lv-${cell.level}`}
                  onClick={() => onLocate(cell)}
                  title={`定位到 ${cell.grid.gridId}`}
                >
                  <b aria-hidden="true">{meta.icon}</b>
                  <span className="chip-id">{cell.grid.gridId}</span>
                  <span className="chip-area">{cell.grid.seaAreaName}</span>
                  <span className="num">
                    {fmtCount(cell.currentCount)}/{fmtBaseline(cell.baseline30d)}
                  </span>
                  <span className="chip-ratio num">{fmtPct(cell.ratioPct)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
