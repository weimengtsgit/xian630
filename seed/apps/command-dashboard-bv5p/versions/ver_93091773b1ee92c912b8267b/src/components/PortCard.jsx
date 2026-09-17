import React from 'react';
import { thresholdFor, FORECAST_HOURS, REFRESH_INTERVAL_MINUTES } from '../config/ports.js';
import {
  fmtCountdown,
  fmtDuration,
  fmtLocalShort,
  fmtBeijingShort,
} from '../utils/time.js';
import DegradedState from './DegradedState.jsx';

const HOUR_MS = 3600 * 1000;

function fmtCoord(lat, lng) {
  const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const ln = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${la} ${ln}`;
}

const BADGE_MAP = {
  open: { cls: 'open', icon: '●', text: '窗口开放' },
  closed: { cls: 'closed', icon: '●', text: '窗口关闭' },
  no_window: { cls: 'empty', icon: '○', text: '无可用窗口' },
  error: { cls: 'error', icon: '⚠', text: '取数失败' },
  loading: { cls: 'loading', icon: '⟳', text: '取数中' },
};

function StatusBadge({ kind, stale, attemptFailed }) {
  const s = BADGE_MAP[kind] || BADGE_MAP.loading;
  return (
    <span className={`status-badge ${s.cls}`}>
      <span aria-hidden="true">{s.icon}</span> {s.text}
      {stale && <span className="sub stale">◆ 陈旧</span>}
      {attemptFailed && <span className="sub fail">刷败</span>}
    </span>
  );
}

function MiniTimeline({ assessment, now }) {
  const spanStart = now;
  const spanEnd = now + FORECAST_HOURS * HOUR_MS;
  const pct = (t) => Math.min(100, Math.max(0, ((t - spanStart) / (spanEnd - spanStart)) * 100));
  const bands = (assessment.windows || [])
    .map((w) => ({ left: pct(Math.max(w.startMs, spanStart)), right: pct(Math.min(w.endMs, spanEnd)) }))
    .filter((b) => b.right - b.left > 0.15);
  return (
    <div className="mtl">
      <div className="mtl-caption">未来 {FORECAST_HOURS} 小时可出港窗口时间线（绿=开放时段）</div>
      <div className="mtl-track">
        {bands.map((b, i) => (
          <div key={i} className="mtl-band" style={{ left: `${b.left}%`, width: `${b.right - b.left}%` }} />
        ))}
        <div className="mtl-now" title="当前时刻" />
      </div>
      <div className="mtl-labels num">
        <span>现在</span><span>+24h</span><span>+48h</span><span>+72h</span>
      </div>
    </div>
  );
}

function WindowRange({ windowObj, timezone }) {
  if (!windowObj) return <span className="muted">—</span>;
  return (
    <span className="num">
      {fmtLocalShort(windowObj.startMs, timezone)} ~ {fmtLocalShort(windowObj.endMs, timezone)}
    </span>
  );
}

// 港口状态卡：港口名/坐标/时区、当前潮高+基准+阈值差、状态徽标、倒计时、
// 当前与下一窗口起止（当地时间）、72h 迷你时间线、数据源与刷新标注
export default function PortCard({ entry, now, onRetry }) {
  const { port, state, ok, stale } = entry;

  if (!ok) {
    if (state.status === 'loading' && !state.error) {
      return (
        <article className="port-card loading" id={`port-card-${port.key}`}>
          <header className="pc-head">
            <div>
              <h3>{port.portName}<span className="pc-en"> {port.portNameEn}</span></h3>
              <div className="pc-meta">{port.portCode} · {fmtCoord(port.lat, port.lng)} · {port.tzLabel}</div>
            </div>
            <StatusBadge kind="loading" />
          </header>
          <div className="skeleton">
            <div className="sk-line w40" />
            <div className="sk-line w80" />
            <div className="sk-line w60" />
            <div className="sk-line w90" />
          </div>
          <p className="pc-hint">正在从 {port.dataSourceName} 获取真实潮汐预测…</p>
        </article>
      );
    }
    return <DegradedState port={port} state={state} onRetry={() => onRetry(port.key)} />;
  }

  const assessment = entry.assessment;
  const threshold = thresholdFor(port);
  const cur = assessment.currentHeightM;
  const delta = assessment.heightDeltaToThresholdM;
  const kind = assessment.windowState;
  const attemptFailed = state.error != null;
  const remaining = assessment.countdownTargetMs != null ? assessment.countdownTargetMs - now : null;
  const countdownLabel = assessment.countdownKind === 'close' ? '距窗口关闭' : '距下一窗口开启';

  return (
    <article className={`port-card ${kind === 'open' ? 'open' : kind === 'closed' ? 'closed' : 'empty'}`} id={`port-card-${port.key}`}>
      <header className="pc-head">
        <div>
          <h3>{port.portName}<span className="pc-en"> {port.portNameEn}</span></h3>
          <div className="pc-meta">
            {port.portCode} · {fmtCoord(port.lat, port.lng)} · {port.tzLabel}（{port.timezone}）
          </div>
        </div>
        <StatusBadge kind={kind} stale={stale} attemptFailed={attemptFailed} />
      </header>

      {cur == null ? (
        <p className="pc-hint">当前时刻不在数据覆盖范围内（等待下次刷新修正）。</p>
      ) : (
        <>
          <div className="pc-metrics">
            <div className="pc-height">
              <span className="big-num num">{cur.toFixed(2)}</span>
              <span className="unit">m</span>
              <div className="datum">当前潮高 · {port.tideDatum}</div>
              <span className={`delta num ${delta >= 0 ? 'pos' : 'neg'}`}>
                {delta >= 0 ? '+' : ''}{delta.toFixed(2)} m 距阈值（{threshold.toFixed(2)} m）
              </span>
            </div>
            <div className="pc-countdown">
              <div className="cd-label">
                {kind === 'open' ? countdownLabel : kind === 'closed' ? countdownLabel : '倒计时'}
              </div>
              <div className="cd-value num">
                {remaining != null ? fmtCountdown(remaining) : '—'}
              </div>
              {assessment.countdownTargetMs != null && (
                <div className="cd-target num">
                  → {fmtLocalShort(assessment.countdownTargetMs, port.timezone)}（当地）
                </div>
              )}
            </div>
          </div>

          {kind === 'no_window' && (
            <p className="pc-empty-note">
              ○ 未来 {FORECAST_HOURS} 小时内潮高均未达到判定阈值 {threshold.toFixed(2)} m（{port.tideDatumShort} 基准），无可用出港窗口。
            </p>
          )}

          <div className="pc-windows">
            <div className="pw-row">
              <span className="pw-label">当前窗口</span>
              <WindowRange windowObj={assessment.currentWindow} timezone={port.timezone} />
              {assessment.currentWindow && (
                <span className="pw-dur num">（{fmtDuration(assessment.currentWindow.endMs - assessment.currentWindow.startMs)}）</span>
              )}
            </div>
            <div className="pw-row">
              <span className="pw-label">下一窗口</span>
              <WindowRange windowObj={assessment.currentWindow ? assessment.followingWindow : assessment.nextWindow} timezone={port.timezone} />
              {(assessment.currentWindow ? assessment.followingWindow : assessment.nextWindow) && (
                <span className="pw-dur num">
                  （{fmtDuration((assessment.currentWindow ? assessment.followingWindow : assessment.nextWindow).endMs
                    - (assessment.currentWindow ? assessment.followingWindow : assessment.nextWindow).startMs)}）
                </span>
              )}
            </div>
          </div>

          <MiniTimeline assessment={assessment} now={now} />

          {attemptFailed && (
            <p className="pc-attempt-fail">
              ⚠ 最近刷新失败（{state.error.code}）· 上次成功数据保留显示
            </p>
          )}
          {stale && !attemptFailed && (
            <p className="pc-stale">◆ 数据陈旧：上次成功刷新 {fmtBeijingShort(state.lastSuccessAt)}（北京时间），已超过 10 分钟</p>
          )}

          <footer className="pc-source">
            <span>{port.dataSourceName}</span>
            <span className="num">上次成功 {fmtBeijingShort(state.lastSuccessAt)}（北京时间）</span>
            <span>每 {REFRESH_INTERVAL_MINUTES} 分钟刷新</span>
          </footer>
          {port.note && <p className="pc-note">{port.note}</p>}
        </>
      )}
    </article>
  );
}
