import './EventCard.css'

function EventCard({ event, onClose }) {
  return (
    <div className="event-card-overlay" onClick={onClose}>
      <div className="event-card" onClick={(e) => e.stopPropagation()}>
        <div className="event-card-header">
          <div className="event-day-badge">DAY {event.day}</div>
          <button className="close-btn" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="event-card-body">
          <div className="event-date">{event.date}</div>
          <h2 className="event-title">{event.eventName}</h2>

          <div className="event-section">
            <div className="section-label">事件概述</div>
            <div className="section-content">{event.description}</div>
          </div>

          <div className="event-section">
            <div className="section-label">详细信息</div>
            <div className="section-content">{event.detail}</div>
          </div>

          <div className="event-coordinates">
            <div className="coord-row">
              <span className="coord-icon">📍</span>
              <span className="coord-text">
                经度: {event.position[0].toFixed(4)}°E / 纬度: {event.position[1].toFixed(4)}°N
              </span>
            </div>
          </div>
        </div>

        <div className="event-card-footer">
          <div className="status-indicator">
            <span className="status-dot"></span>
            <span className="status-text">已确认</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default EventCard
