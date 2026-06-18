import { Anchor, Gauge, Radar, Route, Shield } from "lucide-react";
import { carrierFormation, severityMeta } from "../data/mockFormation";
import { formatCoordinate, seaAreaFor, shipPositionAt } from "../geo";
import { getCurrentTrackPoint, useFleetStore } from "../useFleetStore";

function shipStatusLabel(status: string) {
  return {
    normal: "正常",
    watch: "关注",
    warning: "告警",
  }[status] ?? status;
}

export function FleetOverviewPanel() {
  const dayIndex = useFleetStore((state) => state.dayIndex);
  const selectEvent = useFleetStore((state) => state.selectEvent);
  const trackPoint = getCurrentTrackPoint(dayIndex);
  const progress = Math.round((dayIndex / (carrierFormation.track.length - 1)) * 100);
  const visibleEvents = carrierFormation.events
    .filter((event) => event.dayIndex <= dayIndex)
    .slice(-4)
    .reverse();

  return (
    <section className="fleet-panel" aria-label="航母编队概览">
      <div className="fleet-kicker">
        <Anchor size={16} />
        <span>月度航迹复盘</span>
      </div>

      <header className="fleet-header">
        <h2>{carrierFormation.name}</h2>
        <p>{carrierFormation.mission}</p>
      </header>

      <div className="fleet-metrics">
        <article>
          <Route size={16} />
          <span>复盘进度</span>
          <strong>{progress}%</strong>
        </article>
        <article>
          <Gauge size={16} />
          <span>航速</span>
          <strong>{trackPoint.speed} kt</strong>
        </article>
        <article>
          <Radar size={16} />
          <span>航向</span>
          <strong>{trackPoint.heading}°</strong>
        </article>
        <article>
          <Shield size={16} />
          <span>包络</span>
          <strong>{trackPoint.formationRadiusKm} km</strong>
        </article>
      </div>

      <div className="fleet-section">
        <div className="section-heading">
          <span>当前阶段</span>
          <em>{trackPoint.date}</em>
        </div>
        <p className="phase-text">
          {trackPoint.phase}，位置 {formatCoordinate(trackPoint.position)}，
          位于{seaAreaFor(trackPoint.position)}。
        </p>
      </div>

      <div className="fleet-section">
        <div className="section-heading">
          <span>舰艇列表</span>
          <em>{carrierFormation.ships.length} 艘</em>
        </div>
        <div className="ship-roster">
          {carrierFormation.ships.map((ship) => {
            const position = shipPositionAt(trackPoint, ship);
            return (
              <article key={ship.id} className={ship.kind}>
                <div>
                  <strong>{ship.name}</strong>
                  <span>{ship.role}</span>
                </div>
                <em className={ship.status}>{shipStatusLabel(ship.status)}</em>
                <small>{formatCoordinate(position)}</small>
              </article>
            );
          })}
        </div>
      </div>

      <div className="fleet-section recent-events-section">
        <div className="section-heading">
          <span>已触发事件</span>
          <em>{visibleEvents.length}</em>
        </div>
        <div className="recent-event-list">
          {visibleEvents.map((event) => (
            <button key={event.id} type="button" onClick={() => selectEvent(event.id)}>
              <span style={{ backgroundColor: severityMeta[event.severity].color }} />
              <strong>{event.title}</strong>
              <em>{event.date}</em>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

