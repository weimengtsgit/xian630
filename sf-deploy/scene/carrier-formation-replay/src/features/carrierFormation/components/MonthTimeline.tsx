import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect } from "react";
import { carrierFormation, severityMeta } from "../data/mockFormation";
import { useFleetStore } from "../useFleetStore";

const maxDayIndex = carrierFormation.track.length - 1;

export function MonthTimeline() {
  const dayIndex = useFleetStore((state) => state.dayIndex);
  const isPlaying = useFleetStore((state) => state.isPlaying);
  const setDayIndex = useFleetStore((state) => state.setDayIndex);
  const nextDay = useFleetStore((state) => state.nextDay);
  const previousDay = useFleetStore((state) => state.previousDay);
  const togglePlaying = useFleetStore((state) => state.togglePlaying);
  const selectEvent = useFleetStore((state) => state.selectEvent);
  const currentDay = carrierFormation.track[dayIndex];
  const progress = (dayIndex / maxDayIndex) * 100;

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    const timer = window.setInterval(nextDay, 900);
    return () => window.clearInterval(timer);
  }, [isPlaying, nextDay]);

  return (
    <section className="month-timeline" aria-label="月度复盘时间轴">
      <div className="timeline-controls">
        <button type="button" onClick={previousDay} title="前一天">
          <ChevronLeft size={18} />
        </button>
        <button type="button" className="play-toggle" onClick={togglePlaying} title="播放">
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" onClick={nextDay} title="后一天">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="timeline-main">
        <div className="timeline-summary">
          <strong>{currentDay.date}</strong>
          <span>{currentDay.phase}</span>
          <em>{Math.round(progress)}%</em>
        </div>

        <div className="range-shell">
          <div className="range-progress" style={{ width: `${progress}%` }} />
          {carrierFormation.events.map((event) => (
            <button
              key={event.id}
              type="button"
              className={`event-tick ${event.severity}`}
              style={{
                left: `${(event.dayIndex / maxDayIndex) * 100}%`,
                backgroundColor: severityMeta[event.severity].color,
              }}
              title={`${event.date} ${event.title}`}
              onClick={() => selectEvent(event.id)}
            />
          ))}
          <input
            type="range"
            min={0}
            max={maxDayIndex}
            value={dayIndex}
            onChange={(event) => setDayIndex(Number(event.currentTarget.value))}
            aria-label="复盘日期"
          />
        </div>

        <div className="timeline-scale">
          <span>{carrierFormation.startDate}</span>
          <span>{carrierFormation.endDate}</span>
        </div>
      </div>
    </section>
  );
}

