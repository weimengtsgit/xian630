import React from 'react';
import { DRAFT_LIMIT_M, FORECAST_HOURS, REFRESH_INTERVAL_MINUTES } from '../config/ports.js';
import { fmtBeijingShort, fmtCountdown } from '../utils/time.js';

// 顶部状态栏：应用名、live_api 徽标、阈值口径、刷新时间与倒计时、手动刷新
export default function TopBar({ now, lastRefreshAt, nextRefreshAt, refreshing, onRefresh }) {
  return (
    <header className="topbar">
      <div className="tb-title">
        <h1>航母母港潮汐出港窗口监测看板</h1>
        <div className="tb-badges">
          <span className="badge live">● LIVE · 真实公开数据（live_api）</span>
          <span className="badge">吃水阈值 {DRAFT_LIMIT_M.toFixed(1)} m</span>
          <span className="badge">预测覆盖 {FORECAST_HOURS} h</span>
          <span className="badge">每 {REFRESH_INTERVAL_MINUTES} 分钟自动刷新</span>
        </div>
      </div>
      <div className="tb-refresh">
        <div className="tb-times num">
          <div>最近刷新：{lastRefreshAt != null ? `${fmtBeijingShort(lastRefreshAt)}（北京时间）` : '—'}</div>
          <div>下次刷新：{nextRefreshAt != null ? fmtCountdown(nextRefreshAt - now) : '—'}</div>
        </div>
        <button type="button" className="btn primary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? '刷新中…' : '立即刷新'}
        </button>
      </div>
    </header>
  );
}
