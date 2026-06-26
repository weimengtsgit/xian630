export default function CarrierCard({ carrier }) {
  if (!carrier) {
    return (
      <div className="card">
        <div className="card-body empty-state">
          <div className="empty-icon">-</div>
          暂无航母数据
        </div>
      </div>
    );
  }

  const {
    name,
    lat,
    lon,
    curStatus,
    heading,
    speed,
    homeport,
    airWing,
    aircraftCarried,
    track = [],
    mmsi,
    trackSource,
    trackTotal,
    trackReturned,
  } = carrier;

  const sourceLabel = trackSource === 'ais'
    ? 'AIS / RawAISData'
    : trackSource === 'tracklog'
      ? 'AircraftCarrierTrackLog'
      : trackSource === 'missing_mmsi'
        ? '缺 MMSI，无法关联 AIS'
        : '无可用轨迹';

  return (
    <div className="card">
      <div className="card-header">
        <span>{name} {mmsi ? `(MMSI ${mmsi})` : ''}</span>
        <span style={{ color: curStatus === 'active' ? 'var(--green)' : 'var(--text-dim)', fontSize: '0.75rem' }}>
          {curStatus || '状态未知'}
        </span>
      </div>
      <div className="card-body">
        <div className="stat-row">
          <div className="stat-item">经度 <span>{lon != null ? lon.toFixed(4) : '-'}</span></div>
          <div className="stat-item">纬度 <span>{lat != null ? lat.toFixed(4) : '-'}</span></div>
          <div className="stat-item">航向 <span>{heading} deg</span></div>
          <div className="stat-item">航速 <span>{speed} kn</span></div>
          <div className="stat-item">母港 <span>{homeport || '-'}</span></div>
        </div>
        {airWing && <div className="stat-item" style={{ marginBottom: 4 }}>联队 <span>{airWing}</span></div>}
        {aircraftCarried && <div className="stat-item" style={{ marginBottom: 4 }}>载机 <span>{aircraftCarried}</span></div>}
        <div className="stat-item" style={{ marginTop: 6 }}>
          轨迹来源 <span>{sourceLabel}</span>
          {trackSource === 'ais' && (
            <span>，总点数 {Number(trackTotal || 0).toLocaleString()}，显示 {trackReturned || track.length}</span>
          )}
        </div>
        {track.length > 0 ? (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: '0.76rem', color: 'var(--accent)', marginTop: 6 }}>
              轨迹点 ({track.filter((t) => t.lat != null).length}/{track.length} 有效点)
            </summary>
            <ul className="track-list">
              {track.map((pt, i) => (
                <li key={i} className={pt.lat != null ? 'track-hit' : ''}>
                  {pt.time || `#${i + 1}`} - {pt.lat != null ? `${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}` : '坐标缺失'}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <div className="stat-item" style={{ marginTop: 6 }}>航迹 <span>无可用坐标点</span></div>
        )}
      </div>
    </div>
  );
}
