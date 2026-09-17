import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REFRESH_INTERVAL_MS, DECK_WIND_THRESHOLD_KT, CARRIER_MAX_SPEED_KT, SOURCE_LABELS } from './constants.js';
import { fetchAssessmentSnapshot } from './data/assessmentProvider.js';
import { fetchAisEvidence } from './data/aisProvider.js';
import { formatCountdown } from './utils/timeFormat.js';
import TopStatusBar from './components/TopStatusBar.jsx';
import AlertStrip from './components/AlertStrip.jsx';
import MetricsRow from './components/MetricsRow.jsx';
import CarrierMatrix from './components/CarrierMatrix.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import { DataUnavailable, AppEmptyState } from './components/DataUnavailable.jsx';

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | ready | empty | error
  const [snapshot, setSnapshot] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fatalError, setFatalError] = useState(null);
  const [nextRunAt, setNextRunAt] = useState(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [aisCache, setAisCache] = useState({});
  const [highlightIds, setHighlightIds] = useState([]);
  const matrixSectionRef = useRef(null);

  // 数据加载（真实取数；结果含双源健康度，永不以编造值填充）
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const snap = await fetchAssessmentSnapshot();
      setSnapshot(snap);
      setPhase(snap.position.empty ? 'empty' : 'ready');
      setFatalError(null);
    } catch (err) {
      setFatalError(err);
      setPhase('error');
    } finally {
      setRefreshing(false);
      setNextRunAt(Date.now() + REFRESH_INTERVAL_MS);
    }
  }, []);

  // 5 分钟自动刷新链（完成后再排下一次；手动刷新不重置链）
  useEffect(() => {
    let stop = false;
    let timer;
    const run = async () => {
      await load();
      if (!stop) timer = setTimeout(run, REFRESH_INTERVAL_MS);
    };
    run();
    return () => { stop = true; clearTimeout(timer); };
  }, [load]);

  // 倒计时本地秒级 tick（仅驱动显示，不触发取数）
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 首次到达数据后默认选中第一艘
  useEffect(() => {
    if (snapshot && snapshot.carriers.length && !selectedId) setSelectedId(snapshot.carriers[0].id);
  }, [snapshot, selectedId]);

  // AIS 佐证：仅本体位置源且有 mmsi 的选中舰惰性加载（失败静默）
  useEffect(() => {
    if (!snapshot || !selectedId || aisCache[selectedId]) return;
    const c = snapshot.carriers.find((x) => x.id === selectedId);
    if (!c || c.position.source !== 'ontology-daas' || !c.position.mmsi) return;
    let cancelled = false;
    setAisCache((prev) => ({ ...prev, [selectedId]: { loading: true } }));
    fetchAisEvidence(c.position.mmsi).then((ev) => {
      if (!cancelled) setAisCache((prev) => ({ ...prev, [selectedId]: ev }));
    });
    return () => { cancelled = true; };
  }, [snapshot, selectedId, aisCache]);

  const remainingMs = nextRunAt ? Math.max(0, nextRunAt - nowTs) : null;

  const selectedCarrier = useMemo(
    () => (snapshot ? snapshot.carriers.find((c) => c.id === selectedId) || null : null),
    [snapshot, selectedId]
  );

  const handleAlertClick = useCallback((alert) => {
    if (alert && alert.targetGrade) setGradeFilter(alert.targetGrade);
    if (matrixSectionRef.current && matrixSectionRef.current.scrollIntoView) {
      matrixSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const ids = snapshot
      ? snapshot.carriers.filter((c) => (alert && alert.targetGrade ? c.deckWind.grade === alert.targetGrade : c.dataQuality === 'error')).map((c) => c.id)
      : [];
    if (ids.length) {
      setHighlightIds(ids);
      setTimeout(() => setHighlightIds([]), 2600);
    }
  }, [snapshot]);

  if (phase === 'loading' && !snapshot) {
    return (
      <div className="app">
        <HeaderSkeleton />
        <main className="main-grid" aria-busy="true">
          <section className="panel skeleton-panel"><div className="skeleton-line w60" /><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line w80" /></section>
          <section className="panel skeleton-panel"><div className="skeleton-line w40" /><div className="skeleton-line" /><div className="skeleton-line w80" /><div className="skeleton-line w60" /></section>
        </main>
        <p className="loading-note">正在接入公开格点风场与公开情报航母位置库…</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="app">
        <AppHeaderLite />
        <DataUnavailable
          title="评估快照获取失败"
          reason={fatalError && fatalError.message ? fatalError.message : '未知错误'}
          triedSources={[SOURCE_LABELS['open-meteo-gfs'], SOURCE_LABELS['ontology-daas']]}
          onRetry={load}
          retrying={refreshing}
          note="数据恢复后此处将显示航母甲板风起降条件评估矩阵与单舰明细。"
        />
      </div>
    );
  }

  if (phase === 'empty') {
    return (
      <div className="app">
        <AppHeaderLite />
        <AppEmptyState onRefresh={load} refreshing={refreshing} detail={snapshot && snapshot.position.error ? snapshot.position.error.message : ''} />
      </div>
    );
  }

  return (
    <div className="app">
      <TopStatusBar
        snapshot={snapshot}
        refreshing={refreshing}
        countdownText={remainingMs != null ? formatCountdown(remainingMs) : '--:--'}
        onRefresh={() => load()}
      />
      <AlertStrip alerts={snapshot.alerts} onAlertClick={handleAlertClick} />
      <MetricsRow metrics={snapshot.metrics} />

      {!snapshot.wind.ok && (
        <DataUnavailable
          title="风场数据源不可用（所有公开格点来源均失败）"
          reason={snapshot.wind.error || '未知错误'}
          triedSources={snapshot.wind.tried}
          onRetry={load}
          retrying={refreshing}
          note="数据恢复后矩阵与详情将显示各舰活动区域 10 米风速/风向及甲板风范围判定。"
        />
      )}

      <main className="main-grid" ref={matrixSectionRef}>
        <CarrierMatrix
          carriers={snapshot.carriers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          query={query}
          onQuery={setQuery}
          gradeFilter={gradeFilter}
          onGradeFilter={setGradeFilter}
          highlightIds={highlightIds}
        />
        <DetailPanel carrier={selectedCarrier} aisNote={selectedId ? aisCache[selectedId] : undefined} />
      </main>

      <footer className="footnote">
        <p>
          判定模型（固定口径）：甲板风阈值 {DECK_WIND_THRESHOLD_KT} 节 · 航母最大航速 {CARRIER_MAX_SPEED_KT} 节 · 可实现甲板风范围 [|W−30|, W+30]（W 为活动区域 10 米自然风速，Open-Meteo GFS 当前 UTC 小时槽）。
        </p>
        <p>
          「无弹射器辅助起飞」与「安全着舰」共用 {DECK_WIND_THRESHOLD_KT} 节阈值；矢量合成为简化模型（风速叠加航速近似），未计入弹射器状态、机型、海况等因素，结论仅供值班参考。公开情报位置存在时效滞后，判定为当前位置时刻的近似评估。
        </p>
      </footer>
    </div>
  );
}

function AppHeaderLite() {
  return (
    <header className="topbar lite">
      <div>
        <h1>美海军航母甲板风起降条件评估</h1>
        <p className="subtitle">甲板风起降条件评估指挥仪表盘</p>
      </div>
    </header>
  );
}

function HeaderSkeleton() {
  return (
    <header className="topbar lite" aria-hidden="true">
      <div>
        <h1>美海军航母甲板风起降条件评估</h1>
        <div className="skeleton-line w60" />
      </div>
    </header>
  );
}
