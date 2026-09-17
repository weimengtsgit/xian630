// 顶部状态栏：应用名、演示口径徽标、数据流状态点、刷新周期与倒计时、值守时间、立即刷新/暂停自动刷新
// stale（超 180 秒未成功刷新）时整栏转独立橙色语义并显示滞后时长，与黄/红告警色区分。
import { DEMO_BADGE_TEXT, REFRESH_INTERVAL_SEC } from '../constants.js';
import { fmtDateTime, fmtDuration } from '../utils/format.js';

export default function TopStatusBar({ loading, feedError, paused, countdownMs, isStale, staleMs, now, onRefresh, onTogglePause }) {
  const feedClass = feedError ? 'is-error' : loading ? 'is-loading' : 'is-live';
  const feedText = feedError ? '数据流中断' : loading ? '刷新中' : '数据流正常';
  return (
    <header className={`topbar${isStale ? ' topbar-stale' : ''}`}>
      <div className="topbar-main">
        <span className="app-glyph" aria-hidden="true">▦</span>
        <h1 className="app-title">美航母海域商船密度网格告警</h1>
        <span className={`demo-badge${isStale ? '' : ' pulse'}`} title="本看板数据为预生成演示口径，非真实 AIS 数据">
          <span aria-hidden="true">◈</span> {DEMO_BADGE_TEXT}
        </span>
        <span className={`feed-dot ${feedClass}`}>
          <i aria-hidden="true" /> {feedText}
        </span>
        <span className="topbar-spacer" />
        <span className="duty-clock num" aria-label={`值守时间 ${fmtDateTime(now)}`}>
          值守 {fmtDateTime(now)}
        </span>
      </div>
      <div className="topbar-ops">
        <span className="ops-item">
          刷新周期 <b className="num">{REFRESH_INTERVAL_SEC}</b> 秒
          <i className="ops-sep" aria-hidden="true" />
          {paused ? (
            <b className="ops-paused">自动刷新已暂停</b>
          ) : (
            <>下次刷新 <b className="num">{countdownMs === null ? '--:--' : fmtDuration(countdownMs)}</b></>
          )}
        </span>
        <span className="duty-clock duty-clock-m num">
          值守 {fmtDateTime(now)}
        </span>
        {isStale && (
          <span className="ops-stale" role="status">
            <span aria-hidden="true">◷</span> 数据滞后 <b className="num">{fmtDuration(staleMs)}</b>（超过 {REFRESH_INTERVAL_SEC} 秒未成功刷新）
          </span>
        )}
        <span className="topbar-spacer" />
        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '立即刷新'}
        </button>
        <button
          type="button"
          className={`btn${paused ? ' btn-active' : ''}`}
          onClick={onTogglePause}
          aria-pressed={paused}
        >
          {paused ? '恢复自动刷新' : '暂停自动刷新'}
        </button>
      </div>
    </header>
  );
}
