import React from 'react';
import { fmtBeijingShort } from '../utils/time.js';

// 单港取数失败的显式降级态：错误码 + 失败时间 + 已尝试源 + 手动重试 +
// 数据视图结构预览（只给字段骨架与「—」，严禁填充任何编造数值）+ 官方源链接 + 恢复说明。
export default function DegradedState({ port, state, onRetry }) {
  const err = state.error || { code: 'SOURCE_FAILED', message: '未知错误' };
  const lastFetch = state.lastFetchAt != null ? `${fmtBeijingShort(state.lastFetchAt)}（北京时间）` : '—';
  return (
    <article className="port-card error" id={`port-card-${port.key}`}>
      <header className="pc-head">
        <div>
          <h3>{port.portName}<span className="pc-en"> {port.portNameEn}</span></h3>
          <div className="pc-meta">{port.portCode} · 该港数据源不可用</div>
        </div>
        <span className="status-badge error"><span aria-hidden="true">⚠</span> 取数失败</span>
      </header>

      <div className="degraded-body">
        <div className="dg-row"><b>错误码</b><span className="num">{err.code}</span></div>
        <div className="dg-row"><b>失败原因</b><span>{err.message}</span></div>
        <div className="dg-row"><b>失败时间</b><span className="num">{lastFetch}</span></div>
        <div className="dg-row"><b>已尝试数据源</b><span>{port.dataSourceName}（免鉴权官方公开接口，经同源代理访问）</span></div>
        <div className="dg-actions">
          <button type="button" className="btn" onClick={onRetry} disabled={state.retrying}>
            {state.retrying ? '重试中…' : '手动重试该港'}
          </button>
          <a href={port.dataSourceUrl} target="_blank" rel="noreferrer">官方数据源</a>
        </div>

        <div className="dg-preview">
          <div className="dgp-title">数据视图结构预览（数据回来后会展示什么）</div>
          <div className="dgp-grid">
            <div className="dgp-item"><span>当前潮高</span><b>— m</b></div>
            <div className="dgp-item"><span>出港条件</span><b>—</b></div>
            <div className="dgp-item"><span>倒计时</span><b>—</b></div>
            <div className="dgp-item"><span>下一窗口</span><b>—</b></div>
          </div>
          <div className="mtl-track muted"><div className="mtl-now" /></div>
          <div className="dgp-note">数据恢复后此处将显示该港潮高、窗口状态与倒计时；其他三格不受影响。</div>
        </div>
      </div>
    </article>
  );
}
