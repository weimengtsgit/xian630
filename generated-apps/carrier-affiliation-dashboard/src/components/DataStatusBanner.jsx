// 数据状态横条：推断模式 + 数据缺口警告

export default function DataStatusBanner({ mode, modeNote, errors, fetchedAt, capabilities, onRefresh }) {
  const modeLabel = mode === 'event_based' ? '事件推断模式 (A)' : '编制归属模式 (B)';
  const modeClass = mode === 'event_based' ? 'badge-event' : 'badge-est';

  return (
    <div className="status-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`dot ${errors.length > 0 ? 'dot-warn' : 'dot-ok'}`} />
          <span className={`badge ${modeClass}`}>{modeLabel}</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>{modeNote}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {fetchedAt && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
              取数时间：{new Date(fetchedAt).toLocaleTimeString('zh-CN')}
            </span>
          )}
          <button className="btn" onClick={onRefresh}>刷新数据</button>
        </div>
      </div>
      {errors.length > 0 && (
        <details className="error-box" style={{ width: '100%', margin: 0 }}>
          <summary>数据缺口({errors.length})</summary>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}
      {capabilities && (
        <div className="capability-grid">
          {Object.entries(capabilities).map(([key, item]) => (
            <div className={`capability capability-${item.level}`} key={key}>
              <strong>{item.label}</strong>
              <span>{item.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
