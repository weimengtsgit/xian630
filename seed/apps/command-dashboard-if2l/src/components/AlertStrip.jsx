// 目击潮告警条：滚动播报最新聚类事件（按严重度着色），提供地图定位与进入复核
import { useEffect, useState } from 'react';
import { fmtClock } from '../core/format';

export default function AlertStrip({ m }) {
  const { alertItems } = m;
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (alertItems.length <= 1) return undefined;
    const t = setInterval(() => setIdx((i) => (i + 1) % alertItems.length), 5000);
    return () => clearInterval(t);
  }, [alertItems.length]);

  if (alertItems.length === 0) {
    return (
      <div className="alert-strip normal">
        <span className="lv normal">值守正常</span>
        <span className="alert-text">
          当前时间窗内无紧急 / 关注级目击潮事件 · 轮询按 15 分钟节奏正常推进
        </span>
        <span className="badge demo-badge">演示数据</span>
      </div>
    );
  }

  const item = alertItems[idx % alertItems.length];
  const cluster =
    item.kind === 'cluster' ? m.clusters.find((c) => c.clusterId === item.clusterId) : null;

  return (
    <div className={`alert-strip ${item.severity === '紧急' ? 'critical' : 'warn'}`}>
      <span className={`lv ${item.severity === '紧急' ? 'critical' : 'warn'}`}>
        目击潮告警 · {item.severity}
      </span>
      {item.kind === 'cluster' ? (
        <>
          <span className="alert-text">
            #{item.clusterId} · {item.seaArea} · 时间窗 {fmtClock(Date.parse(item.windowStart))}–
            {fmtClock(Date.parse(item.windowEnd))} · <b>{item.accountCount} 个不同账号</b> ·{' '}
            {item.postCount} 帖 · 相似度 {item.similarityScore} · {item.suspectedType}
          </span>
          {cluster && (
            <span className="alert-actions">
              <button type="button" className="btn-mini" onClick={() => m.focusCluster(cluster)}>
                在地图定位
              </button>
              <button type="button" className="btn-mini ghost" onClick={() => m.selectCluster(cluster.clusterId)}>
                进入复核
              </button>
            </span>
          )}
        </>
      ) : (
        <>
          <span className="alert-text">
            批次 {item.batchId}（{fmtClock(Date.parse(item.startedAt))}）抓取失败 ·{' '}
            {item.errorMessage}
          </span>
          <span className="alert-actions">
            <button type="button" className="btn-mini" onClick={() => m.retryBatch(item.batchId)}>
              重试（演示）
            </button>
          </span>
        </>
      )}
      <span className="alert-page mono">
        {idx + 1}/{alertItems.length}
      </span>
    </div>
  );
}
