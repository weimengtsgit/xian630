import { useState, useEffect, useCallback } from 'react';
import { loadAffiliationData, clearCache } from '../data/carrierProvider';
import DataStatusBanner from './DataStatusBanner';
import CSGPanel from './CSGPanel';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    clearCache();
    try {
      const result = await loadAffiliationData();
      setData(result);
    } catch (e) {
      setError(e.message || String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <div className="loading"><div className="spinner" />正在从 DaaS 加载航母归属数据…</div>;

  if (error) {
    return (
      <div className="container">
        <div className="error-box">
          <strong>数据加载失败</strong>
          <p>{error}</p>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: 6 }}>
            确认 nginx 反向代理已启动（Vite dev 模式下由 vite.config.js proxy 处理）。
          </p>
        </div>
        <button className="btn btn-accent" onClick={fetchData}>重试</button>
      </div>
    );
  }

  if (!data || !data.strikeGroups || data.strikeGroups.length === 0) {
    return (
      <div className="container">
        <DataStatusBanner mode="establishment_based" modeNote="无可用数据" errors={[]} fetchedAt={null} onRefresh={fetchData} />
        <div className="empty-state" style={{ padding: 60 }}>
          <div className="empty-icon" style={{ fontSize: '3rem', opacity: 0.3 }}>—</div>
          <p style={{ fontSize: '0.85rem', marginTop: 8 }}>所有数据源均失败或返回空数据。</p>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            本体 DaaS 通过 nginx 代理访问：POST /api/ontology/daasDMS/entity/&lt;Entity&gt;/list
            （需 scopeType=Space + Authorization + Spaceid）。
          </p>
          <button className="btn btn-accent" onClick={fetchData} style={{ marginTop: 12 }}>重试</button>
        </div>
      </div>
    );
  }

  const { strikeGroups, mode, modeNote, errors, fetchedAt, capabilities } = data;
  const totalPlatforms = strikeGroups.reduce((s, sg) => s + sg.platformCount, 0);
  const totalAircraft = strikeGroups.reduce((s, sg) => s + sg.aircraft.length, 0);
  const totalShips = strikeGroups.reduce((s, sg) => s + sg.ships.length, 0);

  return (
    <div className="container">
      <DataStatusBanner
        mode={mode}
        modeNote={modeNote}
        errors={errors}
        fetchedAt={fetchedAt}
        capabilities={capabilities}
        onRefresh={fetchData}
      />

      <div className="stat-row" style={{ marginBottom: 16 }}>
        <div className="stat-item">打击群 <span>{strikeGroups.length}</span></div>
        <div className="stat-item">航母 <span>{strikeGroups.filter((sg) => sg.carrier).length}</span></div>
        <div className="stat-item">总平台 <span>{totalPlatforms}</span></div>
        <div className="stat-item">舰载机 <span>{totalAircraft}</span></div>
        <div className="stat-item">舰艇 <span>{totalShips}</span></div>
      </div>

      <div className="grid-2col">
        {strikeGroups
          .filter((sg) => sg.carrier || sg.platformCount > 0)
          .sort((a, b) => b.platformCount - a.platformCount)
          .map((sg) => <CSGPanel key={sg.id} sg={sg} />)}
      </div>

      {strikeGroups.every((sg) => !sg.carrier && sg.platformCount === 0) && (
        <div className="empty-state" style={{ padding: 40 }}>
          <p>所有打击群均未加载到有效数据。</p>
          <button className="btn btn-accent" onClick={fetchData} style={{ marginTop: 8 }}>重试</button>
        </div>
      )}
    </div>
  );
}
