// 阈值标尺：0–50–70–100% 分段色带（红/黄/绿）+ 当前比率游标
// 分段为状态分区示意，配图标与文字说明（不以颜色为唯一通道）；分段间以表面色分隔线隔开。
import { RATIO_RED_THRESHOLD, RATIO_YELLOW_THRESHOLD } from '../constants.js';

export default function ThresholdRuler({ ratioPct }) {
  const valid = Number.isFinite(ratioPct);
  const clamped = valid ? Math.min(Math.max(ratioPct, 0), 100) : 0;
  const over = valid && ratioPct > 100;
  const redPct = Math.round(RATIO_RED_THRESHOLD * 100);
  const yellowPct = Math.round(RATIO_YELLOW_THRESHOLD * 100);
  return (
    <div className="ruler">
      <div className="ruler-legend">
        <span className="rl rl-red"><b aria-hidden="true">■</b> 净空告警 &lt; {redPct}%</span>
        <span className="rl rl-yellow"><b aria-hidden="true">▲</b> 净空预警 {redPct}–{yellowPct}%</span>
        <span className="rl rl-green"><b aria-hidden="true">●</b> 正常 ≥ {yellowPct}%</span>
      </div>
      <div
        className="ruler-band"
        role="img"
        aria-label={`阈值标尺：当前比率 ${valid ? ratioPct + '%' : '不可算'}；低于 ${redPct}% 为净空告警，${redPct}% 至 ${yellowPct}% 为净空预警`}
      >
        <span className="seg seg-red" style={{ width: `${redPct}%` }} />
        <span className="seg seg-yellow" style={{ width: `${yellowPct - redPct}%` }} />
        <span className="seg seg-green" style={{ width: `${100 - yellowPct}%` }} />
        {/* 分段间表面色分隔（2px），位置由阈值常量派生 */}
        <i className="seg-split" style={{ left: `${redPct}%` }} aria-hidden="true" />
        <i className="seg-split" style={{ left: `${yellowPct}%` }} aria-hidden="true" />
        {valid && (
          <span className="ruler-cursor" style={{ left: `${clamped}%` }}>
            <span className="ruler-cursor-flag num">
              当前 {ratioPct}%{over ? '（>100%）' : ''}
            </span>
          </span>
        )}
      </div>
      <div className="ruler-marks num" aria-hidden="true">
        <span>0%</span>
        <span style={{ left: `${redPct}%` }}>{redPct}%</span>
        <span style={{ left: `${yellowPct}%` }}>{yellowPct}%</span>
        <span style={{ right: 0 }}>100%</span>
      </div>
    </div>
  );
}
