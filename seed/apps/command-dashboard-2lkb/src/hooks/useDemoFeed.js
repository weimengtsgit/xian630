// 演示数据流模拟层（feed simulator）：
// - 180 秒确定性游标推进（游标 = floor((now - 锚点)/180s)，刷新可复现，不依赖随机数）
// - 周期自动刷新 + 立即刷新 + 暂停自动刷新
// - 按游标段位确定性注入数据流中断（错误态：保留上次数据并标注时点）
// - 超 180 秒未成功刷新 → stale（独立橙色，不占用黄/红告警色）
// 本文件为节奏编排层：序列求值在 utils/snapshot.js，静态配置在 data/gridConfig.js。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANCHOR_EPOCH_MS, TICK_MS, STALE_AFTER_MS } from '../constants.js';
import { buildSnapshot, feedStatusAtTick, outageRecoverAtMs } from '../utils/snapshot.js';

const FETCH_DELAY_MS = 600; // 模拟一次数据拉取的短暂延迟（演示节奏，期间展示骨架屏）

function currentTick(nowMs) {
  return Math.floor((nowMs - ANCHOR_EPOCH_MS) / TICK_MS);
}

export function useDemoFeed() {
  const [snapshot, setSnapshot] = useState(null); // 最近一次成功快照
  const [loading, setLoading] = useState(true); // 首次进入即 loading
  const [feedError, setFeedError] = useState(null); // { tick, atMs, recoverAtMs }
  const [paused, setPaused] = useState(false);
  const [nextRefreshAt, setNextRefreshAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [selectedGridId, setSelectedGridId] = useState(null);
  const [activeArea, setActiveArea] = useState('all'); // 'all' | 海域 id
  const timerRef = useRef(null);
  const busyRef = useRef(false);

  // 执行一次刷新（立即刷新/重试共用同一入口）
  const performRefresh = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    const tick = currentTick(Date.now());
    setLoading(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (feedStatusAtTick(tick) === 'interrupted') {
        // 演示数据流中断：保留上一次成功数据（不清空、不空白），给出诚实错误与恢复时点；
        // 刷新点仍随游标步推进，中断段结束后自动恢复
        setFeedError({ tick, atMs: Date.now(), recoverAtMs: outageRecoverAtMs(tick) });
        setNextRefreshAt(ANCHOR_EPOCH_MS + (tick + 1) * TICK_MS);
      } else {
        const snap = buildSnapshot(tick);
        setSnapshot(snap);
        setFeedError(null);
        setNextRefreshAt(ANCHOR_EPOCH_MS + (tick + 1) * TICK_MS); // 对齐游标步
      }
      setLoading(false);
      busyRef.current = false;
    }, FETCH_DELAY_MS);
  }, []);

  // 首次进入拉取
  useEffect(() => {
    performRefresh();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      busyRef.current = false;
    };
  }, [performRefresh]);

  // 秒级本地节拍：更新值守时钟/倒计时；未暂停且到点 → 周期刷新
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!paused && nextRefreshAt !== null && t >= nextRefreshAt && !busyRef.current) {
        performRefresh();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [paused, nextRefreshAt, performRefresh]);

  // 默认选中红色告警格（无告警时选第一格）
  useEffect(() => {
    if (snapshot && selectedGridId === null) {
      const first = snapshot.alerts.length > 0 ? snapshot.alerts[0] : snapshot.cells[0];
      setSelectedGridId(first.grid.gridId);
    }
  }, [snapshot, selectedGridId]);

  const countdownMs = paused || nextRefreshAt === null ? null : Math.max(0, nextRefreshAt - now);
  const staleMs = snapshot ? now - snapshot.generatedAtMs : 0;
  const isStale = snapshot !== null && staleMs > STALE_AFTER_MS && !loading;

  return {
    // 数据
    snapshot,
    display: snapshot, // 错误态沿用上一次成功快照（保留数据并标注时点）
    loading,
    feedError,
    paused,
    now,
    countdownMs,
    isStale,
    staleMs,
    // 选择状态
    selectedGridId,
    setSelectedGridId,
    activeArea,
    setActiveArea,
    // 操作
    performRefresh,
    togglePaused: useCallback(() => setPaused((p) => !p), []),
  };
}
