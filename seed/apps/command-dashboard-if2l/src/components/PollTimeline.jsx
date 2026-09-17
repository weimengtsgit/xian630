// 抓取轮询时间线 + 坐标双通道统计（底部）：
// 15 分钟批次轴、新帖量 / 带坐标量双色柱、批次回看、失败批次重试（演示）
import { fmtClock, fmtPct } from '../core/format';

const VISIBLE_BATCHES = 14;

export default function PollTimeline({ m }) {
  const visible = m.batches.slice(-VISIBLE_BATCHES);
  const maxCount = Math.max(
    1,
    ...visible.map((b) => Math.max(b.newPostCount || 0, b.withCoordCount || 0))
  );

  const nextSlot = m.runningBatch ? null : m.nextBatchStartMs;

  return (
    <footer className="bottom-region">
      <section className="panel timeline-panel">
        <div className="panel-title">
          抓取轮询时间线（每 {m.intervalMinutes} 分钟增量）
          <span className="tag">poll_timeline</span>
          <span className="hint">点击批次回看该批次帖子 · 演示数据驱动，不产生真实平台请求</span>
        </div>
        <div className="batch-axis">
          {visible.map((b) => {
            const h1 = Math.round(((b.newPostCount || 0) / maxCount) * 54);
            const h2 = Math.round(((b.withCoordCount || 0) / maxCount) * 54);
            const selected = m.selectedBatchId === b.batchId;
            return (
              <div
                key={b.batchId}
                className={`batch ${b.status} ${selected ? 'selected' : ''}`}
                title={`${b.batchId} · ${fmtDateTimeSafe(b.startedAt)} · 新帖 ${b.newPostCount} · 带坐标 ${b.withCoordCount}${b.errorMessage ? ` · ${b.errorMessage}` : ''}`}
                onClick={() => m.selectBatch(selected ? '' : b.batchId)}
              >
                <div className="bars">
                  <span className="bar total" style={{ height: `${Math.max(3, h1)}px` }} />
                  <span className="bar coord" style={{ height: `${Math.max(2, h2)}px` }} />
                </div>
                <div className="b-time mono">{fmtClock(Date.parse(b.startedAt))}</div>
                <div className="b-count mono">{b.newPostCount} 帖</div>
                <div className={`b-status ${b.status}`}>
                  {b.status === 'failed' && '失败'}
                  {b.status === 'success' && `${b.withCoordCount} 带坐标`}
                  {b.status === 'running' && '抓取中'}
                </div>
                {b.status === 'failed' && (
                  <button
                    type="button"
                    className="btn-mini warn b-retry"
                    onClick={(e) => {
                      e.stopPropagation();
                      m.retryBatch(b.batchId);
                    }}
                  >
                    重试
                  </button>
                )}
              </div>
            );
          })}
          {m.runningBatch && (
            <div className="batch running current">
              <div className="bars">
                <span className="bar total striped" style={{ height: '26px' }} />
              </div>
              <div className="b-time mono">{fmtClock(Date.parse(m.runningBatch.startedAt))}</div>
              <div className="b-count mono">—</div>
              <div className="b-status running">抓取中…</div>
            </div>
          )}
          {!m.runningBatch && nextSlot && (
            <div className="batch pending">
              <div className="bars" />
              <div className="b-time mono">{fmtClock(nextSlot)}</div>
              <div className="b-count mono">待轮询</div>
              <div className="b-status">—</div>
            </div>
          )}
        </div>
      </section>

      <section className="panel coord-stats">
        <div className="panel-title">
          坐标双通道统计
          <span className="tag">supporting</span>
        </div>
        <dl className="kv">
          <dt>GPS 标签通道</dt>
          <dd className="mono">
            {fmtPct(m.summary.gpsShare)}（{m.summary.gpsCount} 帖）
            <span className="demo-note">（演示）</span>
          </dd>
          <dt>图片 EXIF 通道</dt>
          <dd className="mono">
            {fmtPct(m.summary.exifShare)}（{m.summary.exifCount} 帖）
            <span className="demo-note">（演示）</span>
          </dd>
          <dt>近 24h 目击潮检出</dt>
          <dd className="mono">
            {m.summary.detection24h} 起<span className="demo-note">（演示）</span>
          </dd>
        </dl>
        <div className="hint">
          演示口径：双通道坐标为数据集内置模拟提取结果（真实平台普遍剥离 EXIF，真实覆盖率将显著低于演示值）。
        </div>
      </section>
    </footer>
  );
}

function fmtDateTimeSafe(iso) {
  return iso ? new Date(Date.parse(iso)).toLocaleString() : '';
}
