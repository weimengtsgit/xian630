import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PORTS,
  REFRESH_INTERVAL_MINUTES,
  STALE_AFTER_MINUTES,
  FORECAST_HOURS,
  thresholdFor,
} from './config/ports.js';
import { fetchAllPorts } from './data/tideProvider.js';
import { assessPort } from './utils/windowCalc.js';
import TopBar from './components/TopBar.jsx';
import AlertStrip from './components/AlertStrip.jsx';
import PortGrid from './components/PortGrid.jsx';
import DrillDown from './components/DrillDown.jsx';
import StatusFooter from './components/StatusFooter.jsx';

const REFRESH_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;
const STALE_MS = STALE_AFTER_MINUTES * 60 * 1000;
const HORIZON_MS = FORECAST_HOURS * 3600 * 1000;

function initialPortStates() {
  return Object.fromEntries(PORTS.map((p) => [p.key, {
    key: p.key,
    status: 'loading',     // loading | ok | error
    data: null,            // { key, series, dataSourceName, fetchedAt }
    lastSuccessAt: null,   // 最近一次成功取数时间（UTC 毫秒）
    lastFetchAt: null,     // 最近一次取数尝试时间
    error: null,           // { code, message }
    retrying: false,
  }]));
}

export default function App() {
  const [portStates, setPortStates] = useState(initialPortStates);
  const [selectedKey, setSelectedKey] = useState(PORTS[0].key);
  const [now, setNow] = useState(() => Date.now());
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [nextRefreshAt, setNextRefreshAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimerRef = useRef(null);

  // 取数结果并入状态机：成功 → 覆盖数据；失败 → 有旧值保留旧值打失败标记，无旧值该格错误态。
  const applyResults = useCallback((results) => {
    setPortStates((prev) => {
      const next = { ...prev };
      for (const r of results) {
        const cur = next[r.key];
        if (r.ok) {
          next[r.key] = {
            ...cur,
            status: 'ok',
            data: r.data,
            lastSuccessAt: r.data.fetchedAt,
            lastFetchAt: r.data.fetchedAt,
            error: null,
            retrying: false,
          };
        } else {
          const hasOld = cur.data != null;
          next[r.key] = {
            ...cur,
            status: hasOld ? cur.status : 'error',
            lastFetchAt: Date.now(),
            error: {
              code: (r.error && r.error.code) || 'SOURCE_FAILED',
              message: (r.error && r.error.message) || String(r.error),
            },
            retrying: false,
          };
        }
      }
      return next;
    });
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const startAt = Date.now();
    setLastRefreshAt(startAt);
    setNextRefreshAt(startAt + REFRESH_MS);
    const results = await fetchAllPorts(PORTS.map((p) => p.key), startAt);
    applyResults(results);
    setRefreshing(false);
  }, [applyResults]);

  // 首次加载 + 每 10 分钟自动刷新
  useEffect(() => {
    refreshAll();
    refreshTimerRef.current = setInterval(() => { refreshAll(); }, REFRESH_MS);
    return () => clearInterval(refreshTimerRef.current);
  }, [refreshAll]);

  // 手动刷新后重排周期，避免与自动周期叠加
  const handleManualRefresh = useCallback(() => {
    if (refreshing) return;
    clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(() => { refreshAll(); }, REFRESH_MS);
    refreshAll();
  }, [refreshAll, refreshing]);

  // 单港手动重试（不影响其他港）
  const retryPort = useCallback(async (key) => {
    setPortStates((prev) => {
      if (prev[key].retrying) return prev;
      return { ...prev, [key]: { ...prev[key], retrying: true } };
    });
    const results = await fetchAllPorts([key], Date.now());
    applyResults(results);
  }, [applyResults]);

  // 本地时钟每秒插值：倒计时随秒更新，与取数周期解耦
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 派生：每港评估（当前潮高/窗口/状态/倒计时）+ 陈旧标记
  const assessed = useMemo(() => {
    const out = {};
    for (const p of PORTS) {
      const state = portStates[p.key];
      const ok = state.status === 'ok' && state.data != null;
      out[p.key] = {
        port: p,
        state,
        ok,
        stale: ok && now - (state.lastSuccessAt || 0) > STALE_MS,
        assessment: ok
          ? assessPort({ series: state.data.series, threshold: thresholdFor(p), now, horizonMs: HORIZON_MS })
          : null,
      };
    }
    return out;
  }, [portStates, now]);

  const focusPort = useCallback((key) => {
    setSelectedKey(key);
    const el = document.getElementById(`port-card-${key}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // 下钻区选中港：取数失败的港不可下钻（原型硬约束：失败港禁用），自动切到首个可用港
  const drillKey = assessed[selectedKey] && assessed[selectedKey].ok
    ? selectedKey
    : (PORTS.find((p) => assessed[p.key].ok) || {}).key || null;

  return (
    <div className="app">
      <TopBar
        now={now}
        lastRefreshAt={lastRefreshAt}
        nextRefreshAt={nextRefreshAt}
        refreshing={refreshing}
        onRefresh={handleManualRefresh}
      />
      <AlertStrip
        assessed={assessed}
        onSelectPort={focusPort}
        onRefreshAll={handleManualRefresh}
        refreshing={refreshing}
      />
      <PortGrid assessed={assessed} now={now} onRetry={retryPort} />
      <DrillDown
        assessed={assessed}
        selectedKey={drillKey}
        onSelect={setSelectedKey}
        now={now}
      />
      <StatusFooter />
    </div>
  );
}
