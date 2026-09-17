import React from 'react';
import { PORTS, DRAFT_LIMIT_M, REFRESH_INTERVAL_MINUTES, thresholdFor } from '../config/ports.js';
import { fmtDuration, fmtLocalShort, fmtBeijingShort } from '../utils/time.js';
import TideChart from './TideChart.jsx';

// 未来出港窗口列表表：起止（当地时间）/时长/状态
function WindowTable({ entry, now }) {
  const { port, assessment } = entry;
  const upcoming = (assessment.windows || []).filter((w) => w.endMs > now);
  return (
    <table className="window-table">
      <thead>
        <tr>
          <th>#</th>
          <th>开始（当地）</th>
          <th>结束（当地）</th>
          <th>时长</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        {upcoming.length === 0 && (
          <tr><td colSpan={5} className="muted-cell">未来 72 小时无可用出港窗口（潮高均未达判定阈值）</td></tr>
        )}
        {upcoming.map((w, i) => {
          const active = now >= w.startMs && now <= w.endMs;
          return (
            <tr key={w.startMs} className={active ? 'active' : ''}>
              <td className="num">{i + 1}</td>
              <td className="num">{fmtLocalShort(w.startMs, port.timezone)}</td>
              <td className="num">{fmtLocalShort(w.endMs, port.timezone)}</td>
              <td className="num">{fmtDuration(w.endMs - w.startMs)}</td>
              <td>{active ? <span className="cell-open">● 进行中</span> : '未开始'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// 判定口径卡：阈值换算、窗口判定规则、数据源、刷新、时区 —— 状态判定所用源值全部可见
function MethodologyCard({ entry }) {
  const { port, assessment, state } = entry;
  const threshold = thresholdFor(port);
  return (
    <div className="method-card">
      <h3>判定口径（{port.portName}）</h3>
      <dl className="method-grid">
        <dt>吃水阈值</dt>
        <dd className="num">{DRAFT_LIMIT_M.toFixed(1)} m</dd>
        <dt>泊位基准水深</dt>
        <dd className="num">{port.chartedDepthM.toFixed(1)} m（{port.chartedDepthSource}）</dd>
        <dt>潮高判定阈值</dt>
        <dd className="num">{DRAFT_LIMIT_M.toFixed(1)} − {port.chartedDepthM.toFixed(1)} = {threshold.toFixed(2)} m（{port.tideDatum}，与潮高同基准直接比较）</dd>
        <dt>当前潮高</dt>
        <dd className="num">{assessment.currentHeightM != null ? `${assessment.currentHeightM.toFixed(2)} m` : '—'}（序列插值，{assessment.heightDeltaToThresholdM != null ? `${assessment.heightDeltaToThresholdM >= 0 ? '+' : ''}${assessment.heightDeltaToThresholdM.toFixed(2)} m 距阈值` : '—'}）</dd>
        <dt>窗口判定规则</dt>
        <dd>潮高连续 ≥ 判定阈值的时段合并为可出港窗口；窗口边界由相邻整点线性插值解出；当前时刻处于窗口内=开放（绿），否则关闭（红）并倒计时至下一窗口。</dd>
        <dt>数据源</dt>
        <dd><a href={port.dataSourceUrl} target="_blank" rel="noreferrer">{port.dataSourceName}</a>（免鉴权官方公开数据，经同源代理运行时取数）</dd>
        <dt>刷新</dt>
        <dd>每 {REFRESH_INTERVAL_MINUTES} 分钟自动刷新 + 手动刷新；倒计时由本地时钟每秒插值，取数失败不重置。上次成功：{fmtBeijingShort(state.lastSuccessAt)}（北京时间）。</dd>
        <dt>时区</dt>
        <dd>窗口起止与潮高时间轴为港口当地时间（{port.timezone}）；刷新时间统一北京时间。</dd>
      </dl>
      {port.note && <p className="method-note">{port.note}</p>}
    </div>
  );
}

// 选中港口下钻详情区：港口页签（失败港禁用）+ 72h 曲线 + 窗口表 + 判定口径卡
export default function DrillDown({ assessed, selectedKey, onSelect, now }) {
  const entry = selectedKey ? assessed[selectedKey] : null;
  return (
    <section className="drill" id="drill-down">
      <header className="drill-head">
        <h2>港口下钻详情</h2>
        <div className="tabs" role="tablist">
          {PORTS.map((p) => {
            const ok = assessed[p.key].ok;
            return (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={selectedKey === p.key}
                className={`tab ${selectedKey === p.key ? 'active' : ''}`}
                disabled={!ok}
                title={ok ? '' : '该港取数失败，暂不可下钻'}
                onClick={() => onSelect(p.key)}
              >
                {p.portName}
              </button>
            );
          })}
        </div>
      </header>

      {entry && entry.ok ? (
        <>
          <div className="drill-body">
            <div className="drill-chart">
              <h3>{entry.port.portName} · 未来 72 小时潮汐曲线与窗口带</h3>
              <TideChart entry={entry} now={now} />
            </div>
            <div className="drill-side">
              <h3>未来出港窗口</h3>
              <WindowTable entry={entry} now={now} />
            </div>
          </div>
          <MethodologyCard entry={entry} />
        </>
      ) : (
        <div className="drill-unavailable">
          <p>⚠ 暂无可下钻的港口数据（四港均处于取数失败或加载中状态）。</p>
          <p>数据恢复后，此处将显示选中港口的 72 小时潮汐曲线、未来窗口列表与判定口径明细。</p>
        </div>
      )}
    </section>
  );
}
