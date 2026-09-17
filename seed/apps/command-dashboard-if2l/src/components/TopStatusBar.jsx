// 顶部指挥状态栏：应用标识、数据源状态灯、demo/live 模式、轮询倒计时、系统时钟、演示徽标
import { DATA_SOURCE_MODES } from '../core/dataSource';
import { fmtClock, fmtClockSec, fmtCountdown } from '../core/format';

const LIGHT_LABEL = {
  ok: { cls: 'ok', text: '正常' },
  warn: { cls: 'warn', text: '警告' },
  error: { cls: 'error', text: '异常' },
  polling: { cls: 'polling', text: '抓取中' },
};

function Light({ label, state }) {
  const s = LIGHT_LABEL[state] || LIGHT_LABEL.ok;
  return (
    <span className={`src-light ${s.cls}`} title={`${label}：${s.text}`}>
      <span className="dot" />
      {label}
      <em>{s.text}</em>
    </span>
  );
}

export default function TopStatusBar({ m }) {
  const { sourceHealth, runningBatch, stale, accelerate, nowMs } = m;
  return (
    <header className="top-bar">
      <div className="tb-brand">
        <span className="tb-logo" aria-hidden="true" />
        <div className="tb-title">
          <strong>全球海域舰船目击社媒监控</strong>
          <span className="tb-sub">指挥监控大屏 · command_dashboard</span>
        </div>
        <span className="badge demo-badge">演示数据</span>
      </div>

      <div className="tb-lights">
        <Light label="X（推特）源" state={sourceHealth.x} />
        <Light label="Instagram 源" state={sourceHealth.instagram} />
        <Light label="坐标双通道（GPS/EXIF）" state={sourceHealth.dualChannel} />
      </div>

      <div className="tb-mode">
        <span className="mode-label">数据源模式</span>
        <button
          type="button"
          className={`chip-mode ${m.mode === 'demo' ? 'active' : ''}`}
          onClick={() => m.switchMode('demo')}
        >
          demo · 当前
        </button>
        <button
          type="button"
          className="chip-mode disabled"
          title={DATA_SOURCE_MODES.live.reservedNote}
          onClick={() => m.requestLiveMode()}
        >
          live · 预留禁用
        </button>
      </div>

      <div className={`tb-poll ${stale ? 'stale' : ''} ${runningBatch ? 'polling' : ''}`}>
        <span className="mono">轮询周期 {m.intervalMinutes}min</span>
        <span className="sep" />
        {runningBatch ? (
          <span className="poll-running">
            批次 {runningBatch.batchId} 抓取中<span className="running-dots" />
          </span>
        ) : (
          <span className="mono">
            上次抓取 {m.lastPollIso ? fmtClock(Date.parse(m.lastPollIso)) : '--:--'} · 下次{' '}
            {fmtClock(m.nextBatchStartMs)}（{fmtCountdown(m.countdownSec)} 后）
          </span>
        )}
        {stale && <span className="stale-tag">数据过期 · 检查轮询任务</span>}
        {accelerate && <span className="accel-tag">演示加速 ×60（15 分钟节奏以 15 秒间隔模拟）</span>}
      </div>

      <div className="tb-right">
        <button
          type="button"
          className={`accel-toggle ${accelerate ? 'on' : ''}`}
          onClick={m.toggleAccelerate}
          title="演示加速：将 15 分钟轮询节奏以 15 秒真实间隔模拟，便于值守演示"
        >
          演示加速 ×60
        </button>
        <span className="mono sys-clock">系统时间 {fmtClockSec(nowMs)}</span>
      </div>
    </header>
  );
}
