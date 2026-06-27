import Dashboard from './components/Dashboard';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>航母归属推断仪表板</h1>
        <span className="badge badge-est">编制归属模式 (B)</span>
      </header>
      <Dashboard />
    </div>
  );
}
