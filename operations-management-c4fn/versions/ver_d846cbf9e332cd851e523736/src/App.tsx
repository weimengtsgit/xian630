import React, { useState, useMemo, useCallback } from 'react';
import type { SmartApp } from './types';
import { DEMO_APPS, CATEGORY_FILTERS } from './data/apps';
import StatusBar from './components/StatusBar';
import Header from './components/Header';
import CategoryFilter from './components/CategoryFilter';
import NewRecommendations from './components/NewRecommendations';
import AppGrid from './components/AppGrid';
import AppDetail from './components/AppDetail';
import './App.css';

const App: React.FC = () => {
  const [apps, setApps] = useState<SmartApp[]>(DEMO_APPS);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [selectedApp, setSelectedApp] = useState<SmartApp | null>(null);

  // 筛选后的应用列表
  const filteredApps = useMemo(() => {
    if (activeCategory === 'all') return apps;
    return apps.filter((a) => a.category === activeCategory);
  }, [apps, activeCategory]);

  // 各分类应用数量，用于侧栏导航计数
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    for (const a of apps) {
      counts[a.category] = (counts[a.category] || 0) + 1;
    }
    return counts;
  }, [apps]);

  // 统计数据
  const newCount = useMemo(() => apps.filter((a) => a.status === '新品').length, [apps]);
  const favoritedCount = useMemo(() => apps.filter((a) => a.favorited).length, [apps]);

  // 选择应用 — 状态切换：选中/取消选中
  const handleSelectApp = useCallback((app: SmartApp) => {
    setSelectedApp((prev) => (prev?.id === app.id ? null : app));
  }, []);

  // 切换收藏 — 状态切换控件（operations-management-console 要求的状态转换）
  const handleToggleFavorite = useCallback((appId: string) => {
    setApps((prev) =>
      prev.map((a) =>
        a.id === appId ? { ...a, favorited: !a.favorited } : a,
      ),
    );
    // 如果详情面板打开且正在操作当前应用，同步更新
    setSelectedApp((prev) => {
      if (prev && prev.id === appId) {
        return { ...prev, favorited: !prev.favorited };
      }
      return prev;
    });
  }, []);

  return (
    <div className="app-layout">
      {/* 顶部状态栏 — defense-operations-ui 模式 */}
      <StatusBar
        appCount={apps.length}
        newCount={newCount}
        favoritedCount={favoritedCount}
      />

      {/* 横向排版：左侧导航栏 + 右侧主内容区 */}
      <div className="app-body">
        {/* 左侧栏：标题 + 分类导航 */}
        <aside className="app-sidebar">
          <Header />

          <div className="app-sidebar__section">
            <span className="app-sidebar__section-title">应用分类</span>
            <CategoryFilter
              filters={CATEGORY_FILTERS}
              activeKey={activeCategory}
              onChange={setActiveCategory}
              counts={categoryCounts}
            />
          </div>
        </aside>

        {/* 右侧主区：新品推荐横向条 + 应用网格 */}
        <main className="app-main">
          <div className="app-main__head">
            <h2 className="app-main__title">
              {activeCategory === 'all' ? '全部应用' : activeCategory}
            </h2>
            <span className="app-main__count">共 {filteredApps.length} 款</span>
          </div>

          {/* 新品推荐区域 — 横向滚动 */}
          <NewRecommendations apps={apps} onSelect={handleSelectApp} />

          {/* 卡片网格 — 横向卡片 */}
          <div className="app-content">
            <AppGrid
              apps={filteredApps}
              onSelectApp={handleSelectApp}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>
        </main>
      </div>

      {/* 详情面板 — 模态弹窗 */}
      {selectedApp && (
        <AppDetail
          app={selectedApp}
          onClose={() => setSelectedApp(null)}
          onToggleFavorite={handleToggleFavorite}
        />
      )}

      {/* 演示数据水印 — 遵循 Honest Data 规则 */}
      <div className="demo-watermark">演示数据 · DEMO</div>
    </div>
  );
};

export default App;
