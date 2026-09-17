// 监控系统状态中枢：15 分钟轮询调度（本地演示驱动）、筛选与阈值联动、
// 目击潮聚类与人工复核流转、批次回看与重试（演示）、告警与提示。
// 演示加速（×60）仅缩短真实等待间隔，批次节奏标签始终为 15 分钟。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DemoDataSource, DATA_SOURCE_MODES } from '../core/dataSource';
import { buildKeywordTasks } from '../data/keywords';
import { detectClusters, DEFAULT_THRESHOLDS, presetReviewState } from '../core/clusterEngine';
import { BATCH_INTERVAL_MINUTES } from '../data/demoDataset';

const INTERVAL_MS = BATCH_INTERVAL_MINUTES * 60 * 1000;
const RUNNING_DURATION_MS = 2200;    // 演示：单批次抓取耗时
const ACCEL_INTERVAL_MS = 15 * 1000; // 演示加速 ×60：15 分钟节奏 → 15 秒真实间隔
const STALE_GRACE_MS = 60 * 1000;

const BUILTIN_TASKS = buildKeywordTasks();
const toMs = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

export function useMonitor() {
  const dsRef = useRef(null);
  if (!dsRef.current) dsRef.current = new DemoDataSource();

  const [initialized, setInitialized] = useState(false);
  const [batches, setBatches] = useState([]);
  const [posts, setPosts] = useState([]);
  const [mode, setMode] = useState('demo');
  const [accelerate, setAccelerate] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runningBatch, setRunningBatch] = useState(null);
  const [toasts, setToasts] = useState([]);

  // 筛选与阈值
  const [taskEnabled, setTaskEnabled] = useState(() =>
    Object.fromEntries(BUILTIN_TASKS.map((t) => [t.taskId, true]))
  );
  const [customTasks, setCustomTasks] = useState([]);
  const [platforms, setPlatforms] = useState({ x: true, instagram: true });
  const [coordSources, setCoordSources] = useState({ gps_tag: true, exif: true });
  const [timeWindowHours, setTimeWindowHours] = useState(6);
  const [thresholds, setThresholdsState] = useState({ ...DEFAULT_THRESHOLDS });

  // 复核与人工标记
  const [reviewStates, setReviewStates] = useState({});
  const [falsePositives, setFalsePositives] = useState({});

  // 选中与联动
  const [selectedClusterId, setSelectedClusterId] = useState(null);
  const [selectedPostId, setSelectedPostId] = useState(null);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [mapFocus, setMapFocus] = useState(null);

  const nextBatchIndexRef = useRef(0);
  const scheduleRef = useRef({ nextEmitRealMs: Infinity, nextBatchStartMs: 0 });
  const accelerateRef = useRef(false);
  const runningRef = useRef(false);
  const runTimerRef = useRef(null);
  const lastEmitOkRealRef = useRef(Date.now());
  const seenClusterKeysRef = useRef(null);
  const toastSeqRef = useRef(0);

  const pushToast = useCallback((text, kind = 'info') => {
    const id = `t${++toastSeqRef.current}`;
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4600);
  }, []);

  // —— 初始化演示时间线（近 24 小时 96 批次） ——
  useEffect(() => {
    const { batches: initBatches, posts: initPosts, latestIndex } = dsRef.current.buildInitial();
    const anchorMs = toMs(initBatches[initBatches.length - 1].startedAt);
    nextBatchIndexRef.current = latestIndex + 1;
    scheduleRef.current = {
      nextBatchStartMs: anchorMs + INTERVAL_MS,
      nextEmitRealMs: anchorMs + INTERVAL_MS,
    };
    lastEmitOkRealRef.current = Date.now();
    setBatches(initBatches);
    setPosts(initPosts);
    setInitialized(true);
  }, []);

  // —— 秒级时钟 ——
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const emitBatch = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    const index = nextBatchIndexRef.current;
    const startMs = scheduleRef.current.nextBatchStartMs;
    const batchId = `B-${1000 + index}`;
    setRunningBatch({
      batchId,
      startedAt: iso(startMs),
      finishedAt: null,
      intervalMinutes: BATCH_INTERVAL_MINUTES,
      status: 'running',
      platforms: { x: 'ok', instagram: 'ok' },
      demo: true,
    });
    runTimerRef.current = setTimeout(() => {
      try {
        const { batch, posts: newPosts } = dsRef.current.fetchBatch(index);
        setBatches((list) => [...list, batch]);
        setPosts((list) => [...list, ...newPosts]);
        nextBatchIndexRef.current = index + 1;
        scheduleRef.current.nextBatchStartMs = startMs + INTERVAL_MS;
        scheduleRef.current.nextEmitRealMs =
          Date.now() + (accelerateRef.current ? ACCEL_INTERVAL_MS : INTERVAL_MS);
        lastEmitOkRealRef.current = Date.now();
      } catch (err) {
        // 演示数据源故障：如实进入失败态，不静默编造成功批次
        setBatches((list) => [
          ...list,
          {
            batchId,
            index,
            startedAt: iso(startMs),
            finishedAt: iso(startMs + 25 * 1000),
            intervalMinutes: BATCH_INTERVAL_MINUTES,
            status: 'failed',
            errorMessage: `演示数据源异常：${err.message}`,
            platforms: { x: 'error', instagram: 'error' },
            demo: true,
          },
        ]);
        scheduleRef.current.nextBatchStartMs = startMs + INTERVAL_MS;
        scheduleRef.current.nextEmitRealMs =
          Date.now() + (accelerateRef.current ? ACCEL_INTERVAL_MS : INTERVAL_MS);
        pushToast(`批次 ${batchId} 抓取失败：${err.message}`, 'error');
      }
      setRunningBatch(null);
      runningRef.current = false;
    }, RUNNING_DURATION_MS);
  }, [pushToast]);

  // —— 轮询触发（含休眠后的追发） ——
  useEffect(() => {
    if (!initialized || runningRef.current) return;
    if (nowMs >= scheduleRef.current.nextEmitRealMs) emitBatch();
  }, [nowMs, initialized, emitBatch]);

  useEffect(() => () => runTimerRef.current && clearTimeout(runTimerRef.current), []);

  const toggleAccelerate = useCallback(() => {
    setAccelerate((prev) => {
      const next = !prev;
      accelerateRef.current = next;
      if (next) {
        scheduleRef.current.nextEmitRealMs = Math.min(
          scheduleRef.current.nextEmitRealMs,
          Date.now() + ACCEL_INTERVAL_MS
        );
      } else {
        scheduleRef.current.nextEmitRealMs = Math.max(
          scheduleRef.current.nextBatchStartMs,
          Date.now() + 5 * 1000
        );
      }
      return next;
    });
  }, []);

  // —— 派生：时间基准与批次视图 ——
  const latestStartMs = useMemo(
    () => (batches.length ? toMs(batches[batches.length - 1].startedAt) : 0),
    [batches]
  );
  const nextBatchStartMs = scheduleRef.current.nextBatchStartMs || latestStartMs + INTERVAL_MS;
  const countdownSec = runningBatch
    ? null
    : Math.max(0, Math.round((scheduleRef.current.nextEmitRealMs - nowMs) / 1000));
  const lastPollIso = useMemo(() => {
    const ok = [...batches].reverse().find((b) => b.status === 'success' || b.status === 'failed');
    return ok ? ok.startedAt : null;
  }, [batches]);
  const lastSuccessIso = useMemo(() => {
    const ok = [...batches].reverse().find((b) => b.status === 'success');
    return ok ? ok.finishedAt || ok.startedAt : null;
  }, [batches]);
  const stale =
    initialized &&
    !runningBatch &&
    lastSuccessIso != null &&
    nowMs - lastEmitOkRealRef.current > INTERVAL_MS + STALE_GRACE_MS;

  // —— 关键词任务 ——
  const allTasks = useMemo(() => [...BUILTIN_TASKS, ...customTasks], [customTasks]);
  const enabledTerms = useMemo(
    () =>
      new Set(
        allTasks.filter((t) => taskEnabled[t.taskId]).map((t) => t.term.toLowerCase())
      ),
    [allTasks, taskEnabled]
  );

  const hitCount24hByTerm = useMemo(() => {
    const since = latestStartMs - 24 * 3600 * 1000;
    const counts = {};
    for (const p of posts) {
      if (toMs(p.postedAt) < since) continue;
      for (const k of p.matchedKeywords) {
        const key = k.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [posts, latestStartMs]);

  // —— 筛选作用域 ——
  const scopePosts = useMemo(() => {
    if (!initialized) return [];
    const since = latestStartMs - timeWindowHours * 3600 * 1000;
    return posts.filter(
      (p) =>
        toMs(p.postedAt) >= since &&
        platforms[p.platform] &&
        p.matchedKeywords.some((k) => enabledTerms.has(k.toLowerCase()))
    );
  }, [posts, initialized, latestStartMs, timeWindowHours, platforms, enabledTerms]);

  const mapPosts = useMemo(
    () => scopePosts.filter((p) => p.latitude != null && coordSources[p.coordSource]),
    [scopePosts, coordSources]
  );
  const clusterCandidates = useMemo(
    () => mapPosts.filter((p) => !falsePositives[p.postId]),
    [mapPosts, falsePositives]
  );

  const rawClusters = useMemo(
    () => detectClusters(clusterCandidates, thresholds),
    [clusterCandidates, thresholds]
  );
  const clusters = useMemo(
    () =>
      rawClusters.map((c) => ({
        ...c,
        status: reviewStates[c.clusterKey] ?? presetReviewState(c.members) ?? 'pending',
      })),
    [rawClusters, reviewStates]
  );

  // 新聚类告警（仅对轮询后新出现且满足告警级的事件提示，初始事件只在告警条展示）
  useEffect(() => {
    if (!initialized) return;
    if (seenClusterKeysRef.current === null) {
      seenClusterKeysRef.current = new Set(clusters.map((c) => c.clusterKey));
      return;
    }
    for (const c of clusters) {
      if (seenClusterKeysRef.current.has(c.clusterKey)) continue;
      seenClusterKeysRef.current.add(c.clusterKey);
      if (c.severity === '紧急' || c.severity === '关注') {
        pushToast(
          `目击潮告警：${c.seaArea} ${c.accountCount} 个账号 ${c.postCount} 帖（相似度 ${c.similarityScore}），${c.suspectedType}（演示数据）`,
          'alert'
        );
      }
    }
  }, [clusters, initialized, pushToast]);

  // —— 数据源健康灯 ——
  const sourceHealth = useMemo(() => {
    const recent = batches.slice(-4);
    const polling = !!runningBatch;
    return {
      polling,
      x: polling ? 'polling' : recent.some((b) => b.platforms?.x === 'error') ? 'error' : 'ok',
      instagram: polling
        ? 'polling'
        : recent.some((b) => b.platforms?.instagram === 'error')
          ? 'error'
          : 'ok',
      dualChannel: (() => {
        const since = latestStartMs - 6 * 3600 * 1000;
        const recentPosts = posts.filter((p) => toMs(p.postedAt) >= since);
        const hasGps = recentPosts.some((p) => p.coordSource === 'gps_tag');
        const hasExif = recentPosts.some((p) => p.coordSource === 'exif');
        return hasGps && hasExif ? 'ok' : 'warn';
      })(),
    };
  }, [batches, runningBatch, posts, latestStartMs]);

  // —— 值守摘要 ——
  const summary = useMemo(() => {
    const since = latestStartMs - 24 * 3600 * 1000;
    const recent = posts.filter((p) => toMs(p.postedAt) >= since);
    const withCoord = recent.filter((p) => p.latitude != null);
    const gps = withCoord.filter((p) => p.coordSource === 'gps_tag').length;
    const exif = withCoord.filter((p) => p.coordSource === 'exif').length;
    const statusCount = { pending: 0, confirmed: 0, dismissed: 0 };
    for (const c of clusters) statusCount[c.status] += 1;
    return {
      newPosts24h: recent.length,
      withCoord24h: withCoord.length,
      gpsCount: gps,
      exifCount: exif,
      gpsShare: withCoord.length ? gps / withCoord.length : 0,
      exifShare: withCoord.length ? exif / withCoord.length : 0,
      detection24h: clusters.length,
      clusterStatus: statusCount,
    };
  }, [posts, latestStartMs, clusters]);

  // —— 告警条内容 ——
  const alertItems = useMemo(() => {
    const items = clusters
      .filter((c) => c.severity !== '正常' && c.status !== 'dismissed')
      .map((c) => ({
        kind: 'cluster',
        severity: c.severity,
        clusterId: c.clusterId,
        seaArea: c.seaArea,
        windowStart: c.windowStart,
        windowEnd: c.windowEnd,
        accountCount: c.accountCount,
        postCount: c.postCount,
        similarityScore: c.similarityScore,
        suspectedType: c.suspectedType,
      }));
    for (const b of batches.slice(-6)) {
      if (b.status === 'failed') {
        items.push({
          kind: 'batch_error',
          severity: '紧急',
          batchId: b.batchId,
          startedAt: b.startedAt,
          errorMessage: b.errorMessage,
        });
      }
    }
    return items;
  }, [clusters, batches]);

  // —— 交互动作 ——
  const selectCluster = useCallback((clusterId) => {
    setSelectedClusterId(clusterId);
  }, []);

  const focusCluster = useCallback((cluster) => {
    setSelectedClusterId(cluster.clusterId);
    const halfWidthDeg = Math.min(45, Math.max(15, (cluster.radiusKm / 111) * 10));
    setMapFocus({
      type: 'cluster',
      id: cluster.clusterId,
      lon: cluster.centerLongitude,
      lat: cluster.centerLatitude,
      spanDeg: halfWidthDeg,
      ts: Date.now(),
    });
  }, []);

  const focusPost = useCallback((post) => {
    if (post.latitude == null) {
      pushToast('该帖无坐标（未落点），仅保留在新帖流供人工研判', 'warn');
      return;
    }
    setSelectedPostId(post.postId);
    setMapFocus({
      type: 'post',
      id: post.postId,
      lon: post.longitude,
      lat: post.latitude,
      spanDeg: 10,
      ts: Date.now(),
    });
  }, [pushToast]);

  const selectPost = useCallback((postId) => setSelectedPostId(postId), []);

  const selectBatch = useCallback((batchId) => setSelectedBatchId(batchId), []);

  const reviewCluster = useCallback(
    (cluster, decision) => {
      setReviewStates((prev) => ({ ...prev, [cluster.clusterKey]: decision }));
      pushToast(
        decision === 'confirmed'
          ? `事件 ${cluster.clusterId} 已确认目击潮（人工复核 · 演示数据）`
          : `事件 ${cluster.clusterId} 已排除误报（人工复核 · 演示数据）`,
        decision === 'confirmed' ? 'alert' : 'warn'
      );
    },
    [pushToast]
  );

  const markFalsePositive = useCallback(
    (post) => {
      setFalsePositives((prev) => ({ ...prev, [post.postId]: true }));
      pushToast(`帖子 ${post.postId} 已标记误报，退出聚类统计（演示行为）`, 'warn');
    },
    [pushToast]
  );

  const retryBatch = useCallback(
    (batchId) => {
      const batch = batches.find((b) => b.batchId === batchId);
      if (!batch || batch.status !== 'failed' || runningRef.current) return;
      runningRef.current = true;
      setRunningBatch({ ...batch, status: 'running', finishedAt: null });
      runTimerRef.current = setTimeout(() => {
        try {
          const { batch: fixed, posts: newPosts } = dsRef.current.fetchBatch(batch.index, { retry: true });
          setBatches((list) => list.map((b) => (b.batchId === batchId ? fixed : b)));
          setPosts((list) => [...list.filter((p) => p.capturedBatchId !== batchId), ...newPosts]);
          pushToast(`批次 ${batchId} 重试成功（演示行为）：双源数据已恢复`, 'ok');
        } catch (err) {
          pushToast(`批次 ${batchId} 重试仍失败：${err.message}`, 'error');
        }
        setRunningBatch(null);
        runningRef.current = false;
      }, RUNNING_DURATION_MS);
    },
    [batches, pushToast]
  );

  const exportBriefing = useCallback(
    (cluster) => {
      const lines = [
        '值班纪要 · 目击潮聚类事件（演示数据，非真实平台数据）',
        `事件编号：${cluster.clusterId}`,
        `海域：${cluster.seaArea}`,
        `时间窗：${cluster.windowStart} ~ ${cluster.windowEnd}（${cluster.windowMinutes} 分钟）`,
        `不同账号：${cluster.accountCount}    帖子数：${cluster.postCount}`,
        `聚合半径：约 ${cluster.radiusKm} km    内容相似度：${cluster.similarityScore}`,
        `严重度：${cluster.severity}    复核状态：${cluster.status === 'pending' ? '待复核' : cluster.status === 'confirmed' ? '已确认' : '已排除'}`,
        `疑似目标类型：${cluster.suspectedType}`,
        `判定阈值：时间窗 ${cluster.appliedThresholds.windowMinutes} 分钟 / 半径 ${cluster.appliedThresholds.radiusKm} km / 最少账号 ${cluster.appliedThresholds.minAccounts} / 相似度 ≥ ${cluster.appliedThresholds.minSimilarity}`,
        '',
        '成员帖子对照：',
        ...cluster.members.map((p) =>
          `- [${p.platform}] ${p.accountName}（${p.language}） ${p.postedAt} 坐标来源 ${p.coordSource === 'gps_tag' ? 'GPS 标签' : '图片 EXIF'}：${p.content}`
        ),
        '',
        '数据边界：本纪要全部内容为 mock_data 演示口径生成，未发生对 X（推特）/ Instagram 的任何真实请求。',
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `值班纪要_${cluster.clusterId}_演示.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      pushToast('值班纪要已导出（演示数据）', 'ok');
    },
    [pushToast]
  );

  const toggleTerm = useCallback((taskId) => {
    setTaskEnabled((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  }, []);

  const addKeywordTerm = useCallback(
    (term) => {
      const t = term.trim();
      if (!t) return;
      const exists = allTasks.some((x) => x.term.toLowerCase() === t.toLowerCase());
      if (exists) {
        pushToast(`词组「${t}」已存在`, 'warn');
        return;
      }
      const taskId = `kw-custom-${customTasks.length + 1}`;
      setCustomTasks((list) => [...list, { taskId, term: t, language: 'custom', languageLabel: '自定义', enabled: true, builtin: false }]);
      setTaskEnabled((prev) => ({ ...prev, [taskId]: true }));
      pushToast(`已新增词组「${t}」（演示配置）：演示数据集不含该词，命中数为 0 属诚实表现`, 'info');
    },
    [allTasks, customTasks.length, pushToast]
  );

  const togglePlatform = useCallback((key) => {
    setPlatforms((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleCoordSource = useCallback((key) => {
    setCoordSources((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setTimeWindow = useCallback((hours) => setTimeWindowHours(hours), []);

  const resetFilters = useCallback(() => {
    setTaskEnabled(Object.fromEntries(BUILTIN_TASKS.map((t) => [t.taskId, true])));
    setPlatforms({ x: true, instagram: true });
    setCoordSources({ gps_tag: true, exif: true });
    setTimeWindowHours(6);
    pushToast('已清空筛选，恢复默认值守口径', 'ok');
  }, [pushToast]);

  const widenTimeWindow = useCallback(() => {
    setTimeWindowHours(24);
    pushToast('已放宽时间窗至近 24 小时', 'ok');
  }, [pushToast]);

  const setThresholds = useCallback((next) => setThresholdsState({ ...DEFAULT_THRESHOLDS, ...next }), []);
  const resetThresholds = useCallback(() => setThresholdsState({ ...DEFAULT_THRESHOLDS }), []);

  const requestLiveMode = useCallback(() => {
    pushToast(`live 通道未启用：${DATA_SOURCE_MODES.live.reservedNote}`, 'warn');
  }, [pushToast]);

  const switchMode = useCallback(
    (nextMode) => {
      if (nextMode === 'live') {
        requestLiveMode();
        return;
      }
      setMode(nextMode);
    },
    [requestLiveMode]
  );

  const selectedCluster = useMemo(
    () => clusters.find((c) => c.clusterId === selectedClusterId) || null,
    [clusters, selectedClusterId]
  );
  const selectedPost = useMemo(
    () => posts.find((p) => p.postId === selectedPostId) || null,
    [posts, selectedPostId]
  );
  const activeFalsePositives = falsePositives;

  return {
    // 系统
    initialized,
    mode,
    switchMode,
    accelerate,
    toggleAccelerate,
    nowMs,
    runningBatch,
    stale,
    countdownSec,
    nextBatchStartMs,
    lastPollIso,
    lastSuccessIso,
    intervalMinutes: BATCH_INTERVAL_MINUTES,
    sourceHealth,
    // 数据
    batches,
    posts,
    scopePosts,
    mapPosts,
    clusters,
    summary,
    alertItems,
    // 关键词任务与筛选
    allTasks,
    taskEnabled,
    hitCount24hByTerm,
    platforms,
    coordSources,
    timeWindowHours,
    thresholds,
    // 交互
    selectedCluster,
    selectedClusterId,
    selectCluster,
    focusCluster,
    selectedPost,
    selectedPostId,
    selectPost,
    focusPost,
    selectedBatchId,
    selectBatch,
    mapFocus,
    reviewCluster,
    markFalsePositive,
    activeFalsePositives,
    retryBatch,
    exportBriefing,
    toggleTerm,
    addKeywordTerm,
    togglePlatform,
    toggleCoordSource,
    setTimeWindow,
    setThresholds,
    resetThresholds,
    resetFilters,
    widenTimeWindow,
    requestLiveMode,
    // 提示
    toasts,
    pushToast,
  };
}
