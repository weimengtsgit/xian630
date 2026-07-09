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

      <div className="app-body">
        <div className="app-main">
          {/* 页面标题 */}
          <Header />

          {/* 新品推荐区域 */}
          <NewRecommendations apps={apps} onSelect={handleSelectApp} />

          {/* 分类筛选 — operations-management-console 模式 */}
          <CategoryFilter
            filters={CATEGORY_FILTERS}
            activeKey={activeCategory}
            onChange={setActiveCategory}
          />

          {/* 卡片网格 */}
          <div className="app-content">
            <AppGrid
              apps={filteredApps}
              onSelectApp={handleSelectApp}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>
        </div>
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
