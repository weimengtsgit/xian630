// 应用组装：指挥大屏三栏布局（左筛选 264px / 中地图自适应 / 右信息流 340px）+ 底部时间线
// 响应式：≥1280 完整三栏；1024–1279 右栏收窄；768–1023 双栏 + 抽屉；<768 单列堆叠
import { useState } from 'react';
import { useMonitor } from './hooks/useMonitor';
import TopStatusBar from './components/TopStatusBar';
import AlertStrip from './components/AlertStrip';
import FilterPanel from './components/FilterPanel';
import DutySummary from './components/DutySummary';
import WorldMap from './components/WorldMap';
import PostFeed from './components/PostFeed';
import ClusterList from './components/ClusterList';
import PollTimeline from './components/PollTimeline';
import ThresholdConfigModal from './components/ThresholdConfigModal';
import Toast from './components/Toast';

export default function App() {
  const m = useMonitor();
  const [showThresholds, setShowThresholds] = useState(false);
  const [drawer, setDrawer] = useState(null); // null | 'filter' | 'stream'

  if (!m.initialized) {
    return (
      <div className="app boot">
        <div className="boot-box">
          <span className="boot-spinner" />
          正在加载演示数据集（本地内置，零外网请求）…
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopStatusBar m={m} />
      <AlertStrip m={m} />

      <div className="drawer-buttons">
        <button
          type="button"
          className={`drawer-btn ${drawer === 'filter' ? 'on' : ''}`}
          onClick={() => setDrawer((d) => (d === 'filter' ? null : 'filter'))}
        >
          筛选
        </button>
        <button
          type="button"
          className={`drawer-btn ${drawer === 'stream' ? 'on' : ''}`}
          onClick={() => setDrawer((d) => (d === 'stream' ? null : 'stream'))}
        >
          信息流
        </button>
      </div>

      <main className={`main ${drawer ? `drawer-${drawer}` : ''}`}>
        <aside className="col left-col">
          <FilterPanel m={m} onOpenThresholds={() => setShowThresholds(true)} />
          <DutySummary m={m} />
        </aside>
        <section className="col mid-col">
          <WorldMap m={m} />
        </section>
        <aside className="col right-col">
          <PostFeed m={m} />
          <ClusterList m={m} />
        </aside>
      </main>

      <PollTimeline m={m} />

      {showThresholds && <ThresholdConfigModal m={m} onClose={() => setShowThresholds(false)} />}
      <Toast toasts={m.toasts} />
    </div>
  );
}
