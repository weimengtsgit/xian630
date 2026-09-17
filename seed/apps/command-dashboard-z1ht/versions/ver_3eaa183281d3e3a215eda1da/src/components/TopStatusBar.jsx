import React from 'react';
import { REFRESH_INTERVAL_MS } from '../constants.js';
import { formatDateTime } from '../utils/timeFormat.js';

// 数据源状态灯：颜色 + 文本双信号
function SourceLight({ label, state, stateText, title }) {
  return (
    <span className={`source-light ${state}`} title={title || ''}>
      <span className="light-dot" aria-hidden="true" />
      {label}：<b>{stateText}</b>
    </span>
  );
}

export default function TopStatusBar({ snapshot, refreshing, countdownText, onRefresh }) {
  const windOk = snapshot.wind.ok;
  const pos = snapshot.position;
  const posState = pos.ok ? 'ok' : pos.degraded ? 'degraded' : 'error';
  const posStateText = pos.ok ? '正常' : pos.degraded ? '降级' : '失败';

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>美海军航母甲板风起降条件评估</h1>
        <p className="subtitle">甲板风起降条件评估指挥仪表盘 · 评估对象：美海军现役航母</p>
      </div>

      <div className="topbar-lights">
        <SourceLight
          label="风场源"
          state={windOk ? 'ok' : 'error'}
          stateText={windOk ? '正常' : '失败'}
          title={windOk ? `${snapshot.wind.sourceLabel}（${snapshot.wind.validTime || '—'} UTC 槽）` : (snapshot.wind.error || '风场数据源不可用')}
        />
        <SourceLight
          label="位置库"
          state={posState}
          stateText={posStateText}
          title={pos.ok ? pos.sourceLabel : (pos.error || '位置库不可用')}
        />
      </div>

      <div className="topbar-times">
        <div className="time-cell">
          <span className="time-label">风场数据时间</span>
          <span className="time-value">
            {windOk ? `${formatDateTime(snapshot.wind.validTime, { utc: true })} UTC` : '—'}
          </span>
        </div>
        <div className="time-cell">
          <span className="time-label">航母位置时效</span>
          <span className="time-value">
            {pos.ok
              ? (pos.freshestAgeLabel ? `最新 ${pos.freshestAgeLabel}` : '时间缺失')
              : pos.degraded ? '不可用（默认区域）' : '—'}
          </span>
        </div>
      </div>

      <div className="topbar-refresh">
        <span className="refresh-period">每 {REFRESH_INTERVAL_MS / 60000} 分钟自动刷新</span>
        <span className="refresh-countdown" title="距下次自动刷新">
          下次刷新 <b className="countdown">{countdownText}</b>
        </span>
        <button
          type="button"
          className="btn-refresh"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? '刷新中…' : '立即刷新'}
        </button>
      </div>
    </header>
  );
}
