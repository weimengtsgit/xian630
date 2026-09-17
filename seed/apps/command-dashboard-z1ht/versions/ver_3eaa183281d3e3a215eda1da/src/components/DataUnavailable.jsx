import React from 'react';
import { OFFICIAL_SOURCE_LINKS } from '../constants.js';

// 降级态 / 数据不可用组件（诚实数据契约）：
// (1) 顶部说明：失败原因 + 已尝试数据源 + 手动重试
// (2) 结构预览：数据回来后会展示什么的骨架（严禁填充编造数值，用「—」与占位线）
// (3) 官方数据源链接
// (4) 数据恢复后的说明
export function DataUnavailable({
  title, reason, triedSources = [], onRetry, retrying = false, note, compact = false,
}) {
  const links = OFFICIAL_SOURCE_LINKS;
  return (
    <section className={`data-unavailable ${compact ? 'compact' : ''}`} role="alert">
      <div className="du-head">
        <span className="du-icon" aria-hidden="true">⚠</span>
        <div className="du-title">{title}</div>
      </div>
      <p className="du-reason">失败原因：{reason || '未知错误'}</p>
      {triedSources.length > 0 && (
        <p className="du-tried">已尝试的数据源：{triedSources.filter(Boolean).join('、')}</p>
      )}
      {onRetry && (
        <button type="button" className="btn-refresh" onClick={onRetry} disabled={refreshing}>
          {refreshing ? '重试中…' : '手动重试'}
        </button>
      )}
      {!compact && (
        <div className="du-preview" aria-label="数据结构预览">
          <p className="du-preview-title">数据视图结构预览（数据恢复后此处将显示）：</p>
          <table className="matrix-table du-table">
            <thead>
              <tr>
                <th>舰名 / 舷号</th>
                <th>位置海域</th>
                <th>位置时效</th>
                <th>10 米风速</th>
                <th>风向</th>
                <th>甲板风范围</th>
                <th>起降判定</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i} aria-hidden="true">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j}><span className="skeleton-line short" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="du-note">{note}</p>}
      <p className="du-links">
        官方数据源：
        {links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">{l.label}</a>
        ))}
      </p>
    </section>
  );
}

// 空态：在册清单为空（本体成功但 0 艘美舰）
export function AppEmptyState({ onRefresh, refreshing, detail }) {
  return (
    <section className="data-unavailable empty-state" role="status">
      <div className="du-head">
        <span className="du-icon" aria-hidden="true">∅</span>
        <div className="du-title">在册清单为空</div>
      </div>
      <p className="du-reason">
        位置库请求成功，但未返回任何美海军现役航母（CVN）记录，评估无法开展。
      </p>
      {detail && <p className="du-tried">接口说明：{detail}</p>}
      <p className="du-note">数据恢复后此处将显示航母甲板风起降条件评估矩阵与单舰明细。</p>
      <button type="button" className="btn-refresh" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? '刷新中…' : '立即刷新'}
      </button>
      <p className="du-links">
        官方数据源：
        {OFFICIAL_SOURCE_LINKS.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">{l.label}</a>
        ))}
      </p>
    </section>
  );
}
