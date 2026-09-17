import React from 'react';
import { PORTS } from '../config/ports.js';

// 数据源告警条：四港取数状态摘要、失败港定位入口、时区口径提示。
// 四港全部失败时展开全局降级横幅（失败原因 + 已尝试源 + 手动重试 + 官方源链接 + 恢复说明）。
export default function AlertStrip({ assessed, onSelectPort, onRefreshAll, refreshing }) {
  const total = PORTS.length;
  const okCount = PORTS.filter((p) => assessed[p.key].ok).length;
  const staleCount = PORTS.filter((p) => assessed[p.key].ok && assessed[p.key].stale).length;
  const failedPorts = PORTS.filter((p) => !assessed[p.key].ok);
  const allFailed = failedPorts.length === total;

  return (
    <section className={`alert-strip ${allFailed ? 'down' : okCount === total ? 'ok' : 'part'}`}>
      <div className="as-row">
        <span className="as-icon" aria-hidden="true">◉</span>
        <span className="as-summary">
          数据源状态：<b className="num">{okCount}/{total}</b> 正常
          {staleCount > 0 && <span className="as-stale"> · {staleCount} 数据陈旧</span>}
          {failedPorts.length > 0 && <span className="as-fail"> · {failedPorts.length} 取数失败</span>}
        </span>
        {failedPorts.map((p) => (
          <button key={p.key} type="button" className="chip fail" onClick={() => onSelectPort(p.key)}>
            ⚠ {p.portName} · 定位
          </button>
        ))}
        <span className="as-note">口径：窗口起止为港口当地时间；刷新时间与倒计时统一北京时间基准</span>
      </div>

      {allFailed && (
        <div className="degraded-banner">
          <h3>⚠ 数据源不可用 — 四港取数全部失败</h3>
          <ul className="db-reasons">
            {PORTS.map((p) => {
              const err = assessed[p.key].state.error;
              return (
                <li key={p.key}>
                  <b>{p.portName}</b>：{err ? `${err.code} — ${err.message}` : '待重试'}
                </li>
              );
            })}
          </ul>
          <p>
            已尝试数据源（均为免鉴权官方公开接口，经本站 nginx 同源代理访问）：
            NOAA CO-OPS 预测 API（站 8638610 / 9410170 / 9447130，MLLW 基准逐时预测）；
            JCG 日本海上保安厅潮汐推算（area=1407，毎時潮高表，平均海面基准）。
          </p>
          <div className="db-actions">
            <button type="button" className="btn primary" onClick={onRefreshAll} disabled={refreshing}>
              {refreshing ? '重试中…' : '手动重试全部'}
            </button>
            <a href="https://tidesandcurrents.noaa.gov/stations.html" target="_blank" rel="noreferrer">官方源：NOAA CO-OPS</a>
            <a href="https://www1.kaiho.mlit.go.jp/TIDE/pred2/" target="_blank" rel="noreferrer">官方源：JCG 潮汐推算</a>
          </div>
          <p>数据恢复后，四格看板将显示各港当前潮高、出港条件状态、窗口倒计时与下一窗口起止时间。</p>
        </div>
      )}
    </section>
  );
}
