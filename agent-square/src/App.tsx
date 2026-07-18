import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { SmartApp } from './types';
import { DEMO_APPS, CATEGORY_FILTERS } from './data/apps';
import StatusBar from './components/StatusBar';
import Header from './components/Header';
import CategoryFilter from './components/CategoryFilter';
import NewRecommendations from './components/NewRecommendations';
import AppGrid from './components/AppGrid';
import AppDetail from './components/AppDetail';
import './App.css';

type IncomingStoreApp = Partial<SmartApp> & Record<string, unknown>;

declare global {
  interface Window {
    __STORE_APPS__?: IncomingStoreApp[];
    registerStoreApp?: (app: IncomingStoreApp) => SmartApp;
    deleteStoreApp?: (idOrName: string) => number;
  }
}

const firstDisplayChar = (value: string) =>
  Array.from(value.trim().replace(/^["“”‘’「『]/, ''))[0] || '应';

const normalizeStoreApp = (input: IncomingStoreApp): SmartApp => {
  const name = String(input.name || input['名字'] || '未命名应用');
  const description = String(input.description || input['描述'] || '');
  return {
    id: String(input.id || `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name,
    description,
    longDescription: String(input.longDescription || description),
    icon: firstDisplayChar(name),
    category: (input.category || input['类别'] || '其他') as SmartApp['category'],
    status: '新品',
    version: String(input.version || input['版本'] || 'v1.0.0'),
    vendor: String(input.vendor || input['厂商'] || '国防科大，电子云'),
    publishDate: String(input.publishDate || new Date().toISOString().slice(0, 10)),
    link: String(input.link || input.url || '#'),
    favorited: false,
    features: Array.isArray(input.features)
      ? input.features.map(String)
      : ['外部接口注册', '新品自动推荐'],
  };
};

const mergeApps = (base: SmartApp[], incoming: SmartApp[]) => {
  const seen = new Set<string>();
  const result: SmartApp[] = [];
  for (const app of [...base, ...incoming]) {
    const key = app.id || app.name;
    if (seen.has(key) || seen.has(app.name)) continue;
    seen.add(key);
    seen.add(app.name);
    result.push(app);
  }
  return result;
};

const initialApps = () => {
  const runtimeApps = Array.isArray(window.__STORE_APPS__)
    ? window.__STORE_APPS__.map(normalizeStoreApp)
    : [];
  return mergeApps(DEMO_APPS, runtimeApps);
};

const App: React.FC = () => {
  const [apps, setApps] = useState<SmartApp[]>(initialApps);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [selectedApp, setSelectedApp] = useState<SmartApp | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  // 排除已隐藏的应用
  const visibleApps = useMemo(
    () => apps.filter((a) => !hiddenIds.has(a.id)),
    [apps, hiddenIds],
  );

  // 筛选后的应用列表
  const filteredApps = useMemo(() => {
    if (activeCategory === 'all') return visibleApps;
    return visibleApps.filter((a) => a.category === activeCategory);
  }, [visibleApps, activeCategory]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/apps')
      .then((response) => (response.ok ? response.json() : []))
      .then((items) => {
        if (cancelled || !Array.isArray(items)) return;
        const runtimeApps = items.map(normalizeStoreApp);
        setApps((prev) => mergeApps(prev, runtimeApps));
      })
      .catch(() => {
        // The static build can run without the Nginx njs API in local previews.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.registerStoreApp = (input) => {
      const app = normalizeStoreApp(input);
      setApps((prev) => mergeApps(prev, [app]));
      return app;
    };
    window.deleteStoreApp = (idOrName) => {
      let deleted = 0;
      setApps((prev) => {
        const next = prev.filter((app) => {
          const remove = app.id === idOrName || app.name === idOrName;
          if (remove) deleted += 1;
          return !remove;
        });
        return next;
      });
      setSelectedApp((prev) =>
        prev && (prev.id === idOrName || prev.name === idOrName) ? null : prev,
      );
      return deleted;
    };
    return () => {
      delete window.registerStoreApp;
      delete window.deleteStoreApp;
    };
  }, []);

  // 假删除 — 仅前端隐藏，不调 DELETE API
  const handleHideApp = useCallback((appId: string) => {
    setHiddenIds((prev) => new Set([...prev, appId]));
    setSelectedApp(null);
  }, []);

  // 统计数据
  const newCount = useMemo(() => visibleApps.filter((a) => a.status === '新品').length, [visibleApps]);
  const favoritedCount = useMemo(() => visibleApps.filter((a) => a.favorited).length, [visibleApps]);

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
        appCount={visibleApps.length}
        newCount={newCount}
        favoritedCount={favoritedCount}
      />

      <div className="app-body">
        <div className="app-main">
          <Header />

          {/* 新品推荐区域 — 横向滚动 */}
          <NewRecommendations apps={visibleApps} onSelect={handleSelectApp} />

          <CategoryFilter
            filters={CATEGORY_FILTERS}
            activeKey={activeCategory}
            onChange={setActiveCategory}
          />

          {/* 卡片网格 — 横向卡片 */}
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
          onHide={handleHideApp}
        />
      )}
    </div>
  );
};

export default App;
