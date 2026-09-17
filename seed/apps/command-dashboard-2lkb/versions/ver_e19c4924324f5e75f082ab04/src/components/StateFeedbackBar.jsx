// 状态反馈条：错误态（演示数据流中断 + 重试，保留上次数据）、滞后提示（独立橙色）、刷新中、常规演示口径说明
import { fmtTime } from '../utils/format.js';

export default function StateFeedbackBar({ loading, feedError, isStale, staleMs, lastUpdatedAt, onRetry }) {
  if (feedError) {
    return (
      <div className="feedback fb-error" role="alert">
        <span className="fb-icon" aria-hidden="true">✕</span>
        <span className="fb-text">
          <b>演示数据流中断</b>（游标段位确定性注入）
          {lastUpdatedAt ? <>· 已保留 <b className="num">{fmtTime(lastUpdatedAt)}</b> 时点数据，不做空白</> : '· 暂无可用数据'}
          {feedError.recoverAtMs ? <>· 预计恢复 <b className="num">{fmtTime(feedError.recoverAtMs)}</b></> : null}
        </span>
        <button type="button" className="btn btn-retry" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (isStale) {
    return (
      <div className="feedback fb-stale" role="status">
        <span className="fb-icon" aria-hidden="true">◷</span>
        <span className="fb-text">
          <b>数据滞后</b> <span className="num">{Math.floor(staleMs / 1000)}</span> 秒（超过 180 秒未成功刷新）——当前展示为最近一次成功快照
        </span>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="feedback fb-loading" role="status">
        <span className="fb-spinner" aria-hidden="true" />
        <span className="fb-text">刷新中 · 数值与曲线暂时替换为骨架屏</span>
      </div>
    );
  }
  return (
    <div className="feedback fb-info" role="status">
      <span className="fb-icon" aria-hidden="true">◈</span>
      <span className="fb-text">
        演示数据流运行中：确定性游标推进 · 每游标步全网取值可复现 · 本应用不发起任何外部网络请求。
        中断演练段每 24 小时周期注入一次（约第 8 小时节点，持续 6 分钟），用于验收错误态与重试链路。
      </span>
    </div>
  );
}
