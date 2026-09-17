import React from 'react';

const LEVEL_LABELS = {
  error: { text: '严重', cls: 'level-error' },
  stale: { text: '陈旧', cls: 'level-stale' },
  warn: { text: '注意', cls: 'level-warn' },
};

// 全局告警条：分级提示，点击联动矩阵筛选/高亮
export default function AlertStrip({ alerts, onAlertClick }) {
  if (!alerts || alerts.length === 0) {
    return (
      <div className="alert-strip allclear" role="status">
        <span className="light-dot ok" aria-hidden="true" /> 当前无活动告警 · 双源数据正常
      </div>
    );
  }
  return (
    <div className="alert-strip" role="alert">
      {alerts.map((a, i) => {
        const lv = LEVEL_LABELS[a.level] || LEVEL_LABELS.warn;
        return (
          <button
            type="button"
            key={`${a.title}-${i}`}
            className={`alert-item ${lv.cls}`}
            onClick={() => onAlertClick && onAlertClick(a)}
            title={a.targetGrade ? '点击后在矩阵中筛出相关舰艇' : '点击定位到态势矩阵'}
          >
            <span className="alert-level">{lv.text}</span>
            <span className="alert-title">{a.title}</span>
            <span className="alert-detail">{a.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
