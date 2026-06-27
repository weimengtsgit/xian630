function coord(value) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '-';
}

function aisLabel(platform) {
  if (!platform.aisStatus) return '-';
  if (platform.aisStatus === 'available') {
    return `可用 ${Number(platform.aisTrackTotal || 0).toLocaleString()} 点`;
  }
  if (platform.aisStatus === 'missing_mmsi') return '缺 MMSI';
  return '无 AIS 点';
}

export default function PlatformTable({ platforms, title, emptyMessage }) {
  if (!platforms || platforms.length === 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-dim)' }}>{title}</div>
        <div className="empty-state" style={{ padding: 12 }}>
          <div style={{ fontSize: '0.75rem' }}>{emptyMessage || '暂无平台数据'}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-dim)' }}>
        {title} ({platforms.length})
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
              <th>型号</th>
              <th>MMSI</th>
              <th>AIS</th>
              <th>状态</th>
              <th>经度</th>
              <th>纬度</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => (
              <tr key={p.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>{p.id}</td>
                <td>{p.name || '-'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>{p.typeCode || '-'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>{p.mmsi || '-'}</td>
                <td className={p.aisStatus === 'available' ? 'track-hit' : ''}>{aisLabel(p)}</td>
                <td>{p.curStatus || '-'}</td>
                <td>{coord(p.longitude)}</td>
                <td>{coord(p.latitude)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
