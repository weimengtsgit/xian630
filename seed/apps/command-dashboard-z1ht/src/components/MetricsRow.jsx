import React from 'react';

// 关键指标区（原型契约四卡）
export default function MetricsRow({ metrics }) {
  const cards = [
    { label: '在册航母', value: metrics.total, hint: '美海军现役（CVN）', tone: 'neutral' },
    { label: '满足「无弹射器辅助起飞」', value: metrics.unassistedTakeoffCount, hint: 'W+30 ≥ 20 节', tone: 'good' },
    { label: '满足「安全着舰」', value: metrics.safeRecoveryCount, hint: '与起飞共用 20 节阈值', tone: 'good' },
    { label: '数据异常 / 无法判定', value: metrics.abnormalCount, hint: '风场缺失或数据不可信', tone: metrics.abnormalCount > 0 ? 'bad' : 'neutral' },
  ];
  return (
    <section className="metrics-row" aria-label="关键指标">
      {cards.map((c) => (
        <div key={c.label} className={`metric-card ${c.tone}`}>
          <span className="metric-value">{c.value}</span>
          <span className="metric-label">{c.label}</span>
          <span className="metric-hint">{c.hint}</span>
        </div>
      ))}
    </section>
  );
}
