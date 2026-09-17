// 应用主结构（原型硬约束）：顶部状态栏 → 告警滚动条 → 指标总览 → 海域分组网格矩阵（+下钻详情）→ 状态反馈 → 页脚演示口径声明
// 布局：≥1024px 双栏（右侧下钻详情栏，≥1440 约 340px）；768–1023 单栏（下钻在选中格下方展开）；<768 紧凑行卡。
import { useCallback, useMemo } from 'react';
import { useDemoFeed } from './hooks/useDemoFeed.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { DEMO_DISCLAIMER, REFRESH_INTERVAL_SEC, RATIO_RED_THRESHOLD, RATIO_YELLOW_THRESHOLD, GRID_EDGE_NM } from './constants.js';
import { SEA_AREAS } from './data/gridConfig.js';
import TopStatusBar from './components/TopStatusBar.jsx';
import AlertStrip from './components/AlertStrip.jsx';
import MetricsOverview from './components/MetricsOverview.jsx';
import SeaAreaTabs from './components/SeaAreaTabs.jsx';
import GridMatrix from './components/GridMatrix.jsx';
import DrillDown from './components/DrillDown.jsx';
import StateFeedbackBar from './components/StateFeedbackBar.jsx';

export default function App() {
  const feed = useDemoFeed();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isXL = useMediaQuery('(min-width: 1440px)');
  const cols = isXL ? 4 : isDesktop ? 3 : isMobile ? 1 : 2;

  const { snapshot, activeArea, setActiveArea, selectedGridId, setSelectedGridId } = feed;

  const visibleCells = useMemo(
    () =>
      snapshot
        ? snapshot.cells.filter((c) => activeArea === 'all' || c.grid.seaAreaId === activeArea)
        : [],
    [snapshot, activeArea]
  );
  const selectedCell = useMemo(
    () => (snapshot ? snapshot.cells.find((c) => c.grid.gridId === selectedGridId) || null : null),
    [snapshot, selectedGridId]
  );

  // 告警定位：切换海域 Tab → 选中网格 → 滚动到可见
  const locateGrid = useCallback(
    (cell) => {
      setActiveArea(cell.grid.seaAreaId);
      setSelectedGridId(cell.grid.gridId);
      requestAnimationFrame(() => {
        const el = document.getElementById(`cell-${cell.grid.gridId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    [setActiveArea, setSelectedGridId]
  );

  const scopeLabel = activeArea === 'all' ? '全部海域' : SEA_AREAS.find((a) => a.id === activeArea)?.name || '海域';

  // 指标口径随海域 Tab 联动（默认全部海域）
  const scopeTotals = useMemo(() => {
    const zero = { totalGrids: 0, greenCount: 0, yellowCount: 0, redCount: 0, alertSeaAreaCount: 0 };
    if (!snapshot) return zero;
    const list = activeArea === 'all' ? snapshot.cells : snapshot.cells.filter((c) => c.grid.seaAreaId === activeArea);
    const t = { totalGrids: list.length, greenCount: 0, yellowCount: 0, redCount: 0, alertSeaAreaCount: 0 };
    const alertAreas = new Set();
    for (const c of list) {
      if (c.level === 'green') t.greenCount += 1;
      else if (c.level === 'yellow' || c.level === 'red') {
        if (c.level === 'yellow') t.yellowCount += 1;
        else t.redCount += 1;
        alertAreas.add(c.grid.seaAreaId);
      }
    }
    t.alertSeaAreaCount = alertAreas.size;
    return t;
  }, [snapshot, activeArea]);
  const drilldownNode = selectedCell && snapshot ? (
    <DrillDown cell={selectedCell} refTick={snapshot.refTick} />
  ) : (
    <div className="dd-empty">
      <p>尚未选中网格</p>
      <p>点击任意方格查看 30 天走势、阈值标尺与状态时间线</p>
    </div>
  );

  // 首屏骨架占位（8 个占位格与单海域网格数一致，加载完成后替换为真实方格）
  const skeletonCells = useMemo(
    () => Array.from({ length: 8 }, (_, i) => ({ grid: { gridId: `loading-${i}` }, level: 'none' })),
    []
  );

  return (
    <div className="app">
      <TopStatusBar
        loading={feed.loading}
        feedError={feed.feedError}
        paused={feed.paused}
        countdownMs={feed.countdownMs}
        isStale={feed.isStale}
        staleMs={feed.staleMs}
        now={feed.now}
        onRefresh={feed.performRefresh}
        onTogglePause={feed.togglePaused}
      />

      <AlertStrip alerts={snapshot ? snapshot.alerts : []} onLocate={locateGrid} ready={!!snapshot} />

      <MetricsOverview
        totals={scopeTotals}
        lastUpdatedAt={snapshot ? snapshot.generatedAtMs : null}
        scopeLabel={scopeLabel}
        isStale={feed.isStale}
        ready={!!snapshot}
      />

      <main className="layout">
        <section className="matrix-zone" aria-label="海域分组网格矩阵">
          <SeaAreaTabs activeArea={activeArea} cells={snapshot ? snapshot.cells : []} onChange={setActiveArea} />
          {visibleCells.length === 0 && !feed.loading ? (
            <div className="matrix-empty" role="status">
              <p><b>当前海域暂无网格数据</b></p>
              <p>保留指标条与海域 Tab；请切换其他海域或等待下一次刷新（每 {REFRESH_INTERVAL_SEC} 秒）</p>
            </div>
          ) : (
            <GridMatrix
              cells={visibleCells.length > 0 ? visibleCells : (snapshot ? [] : skeletonCells)}
              selectedGridId={selectedGridId}
              onSelect={setSelectedGridId}
              cols={cols}
              compact={isMobile}
              loading={feed.loading}
              showInlineDrill={!isDesktop}
              drilldown={drilldownNode}
            />
          )}
          <StateFeedbackBar
            loading={feed.loading}
            feedError={feed.feedError}
            isStale={feed.isStale}
            staleMs={feed.staleMs}
            lastUpdatedAt={snapshot ? snapshot.generatedAtMs : null}
            onRetry={feed.performRefresh}
          />
        </section>

        {isDesktop && <aside className="rail">{drilldownNode}</aside>}
      </main>

      <footer className="footer">
        <p>
          <b>◈ 演示口径声明：</b>{DEMO_DISCLAIMER}
        </p>
        <p className="footer-rules num">
          判定规则：ratio = 当前数量 / 30 天滑动平均基线；ratio &lt; {(RATIO_RED_THRESHOLD * 100).toFixed(0)}% 净空告警（■），
          {(RATIO_RED_THRESHOLD * 100).toFixed(0)}% ≤ ratio &lt; {(RATIO_YELLOW_THRESHOLD * 100).toFixed(0)}% 净空预警（▲），
          其余正常（●）· 网格边长 {GRID_EDGE_NM} 海里 · 刷新周期 {REFRESH_INTERVAL_SEC} 秒
        </p>
      </footer>
    </div>
  );
}
