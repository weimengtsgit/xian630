// 值守摘要（左栏）：24 小时口径统计与数据边界说明
import { fmtPct } from '../core/format';

export default function DutySummary({ m }) {
  const { summary } = m;
  return (
    <section className="panel duty-summary">
      <div className="panel-title">
        值守摘要
        <span className="tag">supporting</span>
      </div>
      <dl className="kv">
        <dt>近 24h 新帖 / 带坐标帖</dt>
        <dd className="mono">
          {summary.newPosts24h} / {summary.withCoord24h}
          <span className="demo-note">（演示）</span>
        </dd>
        <dt>坐标双通道占比</dt>
        <dd className="mono">
          GPS 标签 {fmtPct(summary.gpsShare)}（{summary.gpsCount} 帖） · EXIF{' '}
          {fmtPct(summary.exifShare)}（{summary.exifCount} 帖）
          <span className="demo-note">（演示）</span>
        </dd>
        <dt>当前窗口目击潮检出</dt>
        <dd className="mono">
          {summary.detection24h} 起
          <span className="demo-note">（演示）</span>
        </dd>
        <dt>聚类复核状态</dt>
        <dd className="mono">
          {summary.clusterStatus.pending} 待复核 / {summary.clusterStatus.confirmed} 已确认 /{' '}
          {summary.clusterStatus.dismissed} 已排除
        </dd>
      </dl>
      <div className="duty-note">
        数据边界：全部为 mock_data 演示数据（本地确定性生成，零外网请求）；真实源切换需经
        live 预留层补充鉴权与合规设计。演示坐标为数据集内置模拟提取结果（GPS 标签 / 图片
        EXIF 双通道），非真实 EXIF 解码。
      </div>
    </section>
  );
}
