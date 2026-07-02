import { ArrowUp, Clock3, Gauge, MapPin, X } from "lucide-react";
import { fmtDuration } from "../logic/domain.js";

function speedTier(min) {
  if (min == null) return "info";
  if (min > 360) return "high";
  if (min > 30) return "medium";
  return "low";
}

export function AlertCard({ alert, onClose }) {
  if (!alert) return null;
  const avg = alert.segmentAvgSpeedKn ?? alert.preSpeedKn ?? 0;
  const pre = alert.preSpeedKn ?? 0;
  const post = alert.postSpeedKn ?? 0;
  const maxBar = Math.max(pre, post, avg, 1);
  const tier = speedTier(alert.gapMinutes);
  const origin = alert.trackOrigin;
  const heading = alert.orientation ?? alert.courseDeg;

  return (
    <div className="alert-card" role="dialog" aria-label="AIS 开闭异常详情">
      <header>
        <strong><Gauge size={15} /> AIS 开闭异常</strong>
        <button className="card-close" onClick={onClose} aria-label="关闭"><X size={14} /></button>
      </header>
      <div className="card-grid">
        <div className="card-cell">
          <span className="cell-label"><Gauge size={12} /> 平均速度</span>
          <span className="cell-big">{avg.toFixed(1)}<small>kt</small></span>
          <div className="mini-bars">
            <span style={{ height: `${(pre / maxBar) * 100}%` }} title={`中断前 ${pre}kt`} />
            <span style={{ height: `${(post / maxBar) * 100}%` }} title={`中断后 ${post}kt`} />
          </div>
          <small className="cell-sub">前 {pre}kt → 后 {post}kt</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><ArrowUp size={12} /> 航向</span>
          <span className="compass" style={{ transform: `rotate(${heading ?? 0}deg)` }}><ArrowUp size={28} /></span>
          <small className="cell-sub">{heading != null ? `${heading.toFixed(0)}°` : "--"}</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><Clock3 size={12} /> 中断时长</span>
          <span className={`cell-big tier-${tier}`}>{fmtDuration(alert.gapMinutes)}</span>
          <small className="cell-sub">{tier === "high" ? ">6h 紧急" : tier === "medium" ? ">30min 关注" : "短时"}</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><MapPin size={12} /> 起始位置</span>
          {origin ? (
            <small className="cell-mono">{origin.lon.toFixed(2)}, {origin.lat.toFixed(2)}</small>
          ) : <small className="cell-sub">--</small>}
          {origin?.time && <small className="cell-sub">{String(origin.time).slice(0, 10)}</small>}
        </div>
      </div>
    </div>
  );
}
