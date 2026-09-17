// 聚类阈值配置（task_config 能力入口）：时间窗 / 海域半径 / 最少账号数 / 相似度，应用后即时重算聚类
import { useState } from 'react';
import { DEFAULT_THRESHOLDS } from '../core/clusterEngine';

const FIELDS = [
  { key: 'windowMinutes', label: '时间窗（分钟）', min: 15, max: 180, step: 15, hint: '同一海域内帖子时间跨度上限' },
  { key: 'radiusKm', label: '海域半径（km）', min: 20, max: 200, step: 10, hint: '聚类种子帖为中心的聚合半径' },
  { key: 'minAccounts', label: '最少不同账号数', min: 2, max: 8, step: 1, hint: '低于该账号数不判目击潮（同账号多发帖不触发）' },
  { key: 'minSimilarity', label: '最低内容相似度', min: 0.3, max: 0.9, step: 0.05, hint: '组内平均两两相似度阈值' },
];

export default function ThresholdConfigModal({ m, onClose }) {
  const [draft, setDraft] = useState({ ...m.thresholds });
  const dirty =
    JSON.stringify(draft) !== JSON.stringify({ ...DEFAULT_THRESHOLDS, ...m.thresholds });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal threshold-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>聚类阈值配置 · 目击潮判定</span>
          <button type="button" className="pp-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            目击潮判定要素：同海域 + 时间窗内 + 半径内 + 不同账号数 + 内容相似度。阈值应用后聚类即时重算；
            严重度规则：紧急 = 账号 ≥6 或（账号 ≥4 且相似度 ≥0.88）；关注 = 账号 ≥4 或相似度 ≥0.75；其余为正常。
          </p>
          {FIELDS.map((f) => (
            <div key={f.key} className="th-field">
              <div className="th-label">
                <span>{f.label}</span>
                <span className="mono">
                  {draft[f.key]}
                  {m.thresholds[f.key] !== draft[f.key] && (
                    <em>（当前 {m.thresholds[f.key]}）</em>
                  )}
                </span>
              </div>
              <input
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }))}
              />
              <div className="th-hint hint">
                {f.hint}（默认 {DEFAULT_THRESHOLDS[f.key]}）
              </div>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-mini ghost" onClick={() => setDraft({ ...DEFAULT_THRESHOLDS })}>
            恢复默认
          </button>
          <button
            type="button"
            className="btn-mini"
            disabled={!dirty}
            onClick={() => {
              m.setThresholds(draft);
              m.pushToast('聚类阈值已应用，事件列表已重算（演示数据）', 'ok');
              onClose();
            }}
          >
            应用并重算
          </button>
        </div>
      </div>
    </div>
  );
}
