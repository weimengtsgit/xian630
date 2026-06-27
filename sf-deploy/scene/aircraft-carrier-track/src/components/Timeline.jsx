import './Timeline.css'

function Timeline({ data, selectedDay, onDaySelect }) {
  return (
    <div className="timeline">
      <div className="timeline-header">
        <div className="timeline-title">时间轴</div>
        <div className="timeline-subtitle">TIMELINE</div>
      </div>
      <div className="timeline-items">
        {data.map((item) => (
          <div
            key={item.day}
            className={`timeline-item ${selectedDay === item.day ? 'active' : ''}`}
            onClick={() => onDaySelect(item.day)}
          >
            <div className="timeline-node">
              <div className="node-inner">
                <span className="node-day">{item.day}</span>
              </div>
            </div>
            <div className="timeline-content">
              <div className="timeline-date">{item.date}</div>
              <div className="timeline-event">{item.eventName}</div>
              <div className="timeline-desc">{item.description}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="timeline-footer">
        <div className="footer-line"></div>
        <div className="footer-text">7天轨迹追踪</div>
      </div>
    </div>
  )
}

export default Timeline
