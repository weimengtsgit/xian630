// 新帖流面板：按抓取批次增量分组的帖子卡片（账号 / 平台 / 语言 / 命中词 / 坐标徽标 / 内容摘要）
import { useMemo } from 'react';
import { fmtDateTime } from '../core/format';

const FEED_LIMIT = 30;

export default function PostFeed({ m }) {
  // 批次切换：默认最新一个有帖子的批次，支持时间线回看
  const batchesWithPosts = useMemo(() => {
    const map = new Map();
    for (const p of m.scopePosts) map.set(p.capturedBatchId, (map.get(p.capturedBatchId) || 0) + 1);
    return m.batches
      .filter((b) => map.has(b.batchId))
      .map((b) => ({ batch: b, count: map.get(b.batchId) }))
      .slice(-5)
      .reverse();
  }, [m.scopePosts, m.batches]);

  const activeBatchId =
    m.selectedBatchId && m.scopePosts.some((p) => p.capturedBatchId === m.selectedBatchId)
      ? m.selectedBatchId
      : batchesWithPosts[0]?.batch.batchId || '';

  const feedPosts = useMemo(
    () =>
      m.scopePosts
        .filter((p) => p.capturedBatchId === activeBatchId)
        .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
        .slice(0, FEED_LIMIT),
    [m.scopePosts, activeBatchId]
  );

  return (
    <section className="panel feed-panel">
      <div className="panel-title">
        新帖流（按抓取批次增量）
        <span className="tag">post_feed</span>
      </div>
      <div className="chip-row batch-chips">
        {batchesWithPosts.map(({ batch, count }) => (
          <button
            key={batch.batchId}
            type="button"
            className={`chip ${activeBatchId === batch.batchId ? 'on' : ''}`}
            onClick={() => m.selectBatch(batch.batchId)}
          >
            批次 {fmtDateTime(batch.startedAt)} · {count} 帖
          </button>
        ))}
        {activeBatchId === '' && <span className="hint">当前筛选窗口内无帖子</span>}
      </div>
      <div className="feed-list">
        {feedPosts.map((p) => (
          <article key={p.postId} className={`post-card ${m.activeFalsePositives[p.postId] ? 'fp' : ''}`}>
            <div className="p-head">
              <span className="acct">{p.accountName}</span>
              <span className={`plat-tag ${p.platform}`}>{p.platform === 'x' ? 'X' : 'Instagram'}</span>
              <span className="mono">{p.language}</span>
              {p.latitude != null ? (
                <span className={`coord-tag ${p.coordSource}`}>
                  {p.coordSource === 'gps_tag' ? 'GPS' : 'EXIF'}{' '}
                  {Math.abs(p.latitude).toFixed(1)}°{p.latitude >= 0 ? 'N' : 'S'}{' '}
                  {Math.abs(p.longitude).toFixed(1)}°{p.longitude >= 0 ? 'E' : 'W'}
                </span>
              ) : (
                <span className="coord-tag none">无坐标</span>
              )}
              <span className="mono p-time">{fmtDateTime(p.postedAt)}</span>
            </div>
            <div className="p-body">{p.content}</div>
            <div className="p-foot">
              <span className="kw-row">
                {p.matchedKeywords.map((k) => (
                  <span key={k} className="kw-chip">{k}</span>
                ))}
                {p.hasImage && <span className="kw-chip img">图</span>}
              </span>
              <span className="p-actions">
                <button type="button" className="btn-mini ghost" onClick={() => m.focusPost(p)}>
                  定位
                </button>
                {!m.activeFalsePositives[p.postId] && (
                  <button type="button" className="btn-mini ghost" onClick={() => m.markFalsePositive(p)}>
                    标记误报
                  </button>
                )}
                {m.activeFalsePositives[p.postId] && <span className="fp-tag">已标误报</span>}
                <span className="demo-note">演示</span>
              </span>
            </div>
          </article>
        ))}
        {feedPosts.length === 0 && (
          <div className="feed-empty">该批次在当前筛选下无帖子；可点击左下角时间线批次回看，或清空筛选。</div>
        )}
        {feedPosts.length >= FEED_LIMIT && (
          <div className="feed-more hint">仅显示最近 {FEED_LIMIT} 条（共{' '}
            {m.scopePosts.filter((p) => p.capturedBatchId === activeBatchId).length} 条）</div>
        )}
      </div>
    </section>
  );
}
