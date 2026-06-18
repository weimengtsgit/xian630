import { targets } from "../data/mockSituation";
import { useSituationStore } from "../useSituationStore";

export function TimelineOverlay() {
  const selectedTargetId = useSituationStore((state) => state.selectedTargetId);
  const selectedTarget =
    targets.find((target) => target.id === selectedTargetId) ?? targets[0];
  const events = selectedTarget.events.slice(0, 4);

  return (
    <section className="timeline-overlay" aria-label="关系时间线">
      <div className="timeline-track">
        {events.map((event, index) => (
          <article
            key={event.id}
            className={index % 2 === 0 ? "above" : "below"}
            style={{ left: `${12 + index * 26}%` }}
          >
            <span className="timeline-dot" />
            <div>
              <strong>{event.title}</strong>
              <span>{event.time}</span>
              <p>{event.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

