import { AlertTriangle, CalendarClock, MapPin, ShieldCheck } from "lucide-react";
import { carrierFormation, severityMeta } from "../data/mockFormation";
import { formatCoordinate, seaAreaFor } from "../geo";
import { getCurrentTrackPoint, getSelectedEvent, useFleetStore } from "../useFleetStore";

export function EventDetailPanel() {
  const dayIndex = useFleetStore((state) => state.dayIndex);
  const selectedEventId = useFleetStore((state) => state.selectedEventId);
  const event = getSelectedEvent(selectedEventId, dayIndex) ?? carrierFormation.events[0];
  const trackPoint = getCurrentTrackPoint(dayIndex);
  const meta = severityMeta[event.severity];
  const relatedShips = event.relatedShipIds
    .map((shipId) => carrierFormation.ships.find((ship) => ship.id === shipId))
    .filter(Boolean);

  const previous = carrierFormation.track[Math.max(0, dayIndex - 3)];
  const next = carrierFormation.track[Math.min(carrierFormation.track.length - 1, dayIndex + 3)];

  return (
    <aside className="event-panel" aria-label="事件详情">
      <div className="event-panel-title">
        <span>事件详情</span>
        <em style={{ color: meta.color }}>{meta.label}</em>
      </div>

      <article className={`event-detail-card ${event.severity}`}>
        <header>
          <div>
            <span>{event.type}</span>
            <h2>{event.title}</h2>
          </div>
          <AlertTriangle size={22} />
        </header>
        <p>{event.summary}</p>
      </article>

      <div className="event-facts">
        <div>
          <CalendarClock size={15} />
          <span>{event.date}</span>
        </div>
        <div>
          <MapPin size={15} />
          <span>{formatCoordinate(event.coordinate)}</span>
        </div>
        <div>
          <ShieldCheck size={15} />
          <span>{seaAreaFor(event.coordinate)}</span>
        </div>
      </div>

      <section className="event-section">
        <h3>关联舰艇</h3>
        <div className="related-ship-tags">
          {relatedShips.map((ship) => (
            <span key={ship?.id}>{ship?.name}</span>
          ))}
        </div>
      </section>

      <section className="event-section">
        <h3>研判结论</h3>
        <p>{event.assessment}</p>
      </section>

      <section className="event-section">
        <h3>前后状态</h3>
        <div className="state-delta">
          <article>
            <span>{previous.date}</span>
            <strong>{previous.phase}</strong>
          </article>
          <article className="active">
            <span>{trackPoint.date}</span>
            <strong>{trackPoint.phase}</strong>
          </article>
          <article>
            <span>{next.date}</span>
            <strong>{next.phase}</strong>
          </article>
        </div>
      </section>
    </aside>
  );
}

