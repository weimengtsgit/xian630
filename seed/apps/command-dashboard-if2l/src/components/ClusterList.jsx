// 目击潮聚类事件列表：事件卡片 + 选中下钻（成员帖子对照 / 发帖节奏 / 疑似目标 / 复核操作）
import { useMemo } from 'react';
import { fmtTime, fmtDateTime } from '../core/format';
import { SEVERITY_ORDER, REVIEW_STATUS_LABEL } from '../core/clusterEngine';

export default function ClusterList({ m }) {
  const sorted = useMemo(
    () =>
      [...m.clusters].sort((a, b) => {
        const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        return s !== 0 ? s : Date.parse(b.windowStart) - Date.parse(a.windowStart);
      }),
    [m.clusters]
  );

  return (
    <section className="panel cluster-panel">
      <div className="panel-title">
        目击潮聚类事件
        <span className="tag">cluster_list · 含下钻</span>
        <span className="mono cluster-count">
          {sorted.length} 起（阈值 {m.thresholds.windowMinutes}min / {m.thresholds.radiusKm}km / ≥
          {m.thresholds.minAccounts} 账号 / ≥{m.thresholds.minSimilarity}）
        </span>
      </div>
      <div className="cluster-list">
        {sorted.map((c) => {
          const selected = m.selectedClusterId === c.clusterId;
          return (
            <div key={c.clusterId} className="cluster-wrap">
              <article
                className={`cluster-card ${c.severity === '紧急' ? 'critical' : c.severity === '关注' ? 'warn' : 'normal'} ${selected ? 'selected' : ''}`}
                onClick={() => m.selectCluster(selected ? null : c.clusterId)}
              >
                <div className="c-head">
                  <span className="c-id">#{c.clusterId}</span>
                  <span className="c-area">{c.seaArea}</span>
                  <span className={`state-tag ${c.status}`}>{REVIEW_STATUS_LABEL[c.status]}</span>
                  <span className={`sev-tag ${c.severity === '紧急' ? 'critical' : c.severity === '关注' ? 'warn' : 'normal'}`}>
                    {c.severity}
                  </span>
                </div>
                <div className="c-meta mono">
                  <span>窗 {fmtTime(c.windowStart)}–{fmtTime(c.windowEnd)}</span>
                  <span>账号 {c.accountCount}</span>
                  <span>帖子 {c.postCount}</span>
                  <span>半径 ~{Math.round(c.radiusKm)}km</span>
                  <span>相似度 {c.similarityScore}</span>
                </div>
              </article>
              {selected && <ClusterDetail c={c} m={m} />}
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="cluster-empty">
            当前窗口与阈值下未检出目击潮聚类（判定需同时满足：同海域 · 时间窗内 · 半径内 ·
            不同账号数 ≥ 阈值 · 内容相似度 ≥ 阈值）。可在左栏放宽阈值或时间窗。
          </div>
        )}
      </div>
    </section>
  );
}

function ClusterDetail({ c, m }) {
  const rhythm = useMemo(() => {
    const start = Date.parse(c.windowStart);
    const end = Date.parse(c.windowEnd);
    const span = Math.max(60 * 1000, end - start);
    const buckets = new Array(8).fill(0);
    for (const p of c.members) {
      const i = Math.min(7, Math.floor(((Date.parse(p.postedAt) - start) / span) * 8));
      buckets[i] += 1;
    }
    const max = Math.max(1, ...buckets);
    return { buckets, max };
  }, [c]);

  return (
    <div className="cluster-detail">
      <div className="cd-row">
        <span className="cd-label">疑似目标</span>
        <span className="cd-value">{c.suspectedType}</span>
        <span className="cd-label">时间窗</span>
        <span className="cd-value mono">
          {fmtDateTime(c.windowStart)} ~ {fmtDateTime(c.windowEnd)}（{c.windowMinutes} 分钟）
        </span>
      </div>
      <div className="cd-row">
        <span className="cd-label">判定阈值</span>
        <span className="cd-value mono">
          窗 {c.appliedThresholds.windowMinutes}min / 半径 {c.appliedThresholds.radiusKm}km / 账号 ≥
          {c.appliedThresholds.minAccounts} / 相似度 ≥{c.appliedThresholds.minSimilarity}
        </span>
      </div>

      <div className="cd-block">
        <div className="block-label">发帖节奏（时间窗 8 等分）</div>
        <div className="rhythm">
          {rhythm.buckets.map((v, i) => (
            <span key={i} className="rhythm-bar" style={{ height: `${Math.max(6, (v / rhythm.max) * 100)}%` }} title={`${v} 帖`} />
          ))}
        </div>
      </div>

      <div className="cd-block">
        <div className="block-label">成员帖子对照（{c.members.length}）</div>
        <div className="member-list">
          {c.members.map((p) => (
            <div key={p.postId} className="member-row">
              <span className="mono m-time">{fmtTime(p.postedAt)}</span>
              <span className={`plat-tag ${p.platform}`}>{p.platform === 'x' ? 'X' : 'IG'}</span>
              <span className="acct">{p.accountName}</span>
              <span className={`coord-tag ${p.coordSource}`}>{p.coordSource === 'gps_tag' ? 'GPS' : 'EXIF'}</span>
              <span className="m-content">{p.content}</span>
              <button type="button" className="btn-mini ghost" onClick={() => m.focusPost(p)}>
                定位
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="cd-actions">
        {c.status !== 'confirmed' && (
          <button type="button" className="btn-mini ok" onClick={() => m.reviewCluster(c, 'confirmed')}>
            确认目击潮
          </button>
        )}
        {c.status !== 'dismissed' && (
          <button type="button" className="btn-mini warn" onClick={() => m.reviewCluster(c, 'dismissed')}>
            排除误报
          </button>
        )}
        <button type="button" className="btn-mini" onClick={() => m.focusCluster(c)}>
          在地图定位
        </button>
        <button type="button" className="btn-mini ghost" onClick={() => m.exportBriefing(c)}>
          导出值班纪要（演示）
        </button>
        <span className="demo-note">成员帖均为演示数据</span>
      </div>
    </div>
  );
}
