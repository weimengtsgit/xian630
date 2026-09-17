// 状态徽标：图标（●/▲/■）+ 中文标签，不以颜色为唯一通道
import { LEVEL_META } from '../utils/alertRule.js';

export default function StatusBadge({ level, compact = false }) {
  const meta = LEVEL_META[level] || LEVEL_META.none;
  return (
    <span className={`badge lv-${level}${compact ? ' badge-compact' : ''}`}>
      <span className="badge-icon" aria-hidden="true">{meta.icon}</span>
      <span className="badge-label">{meta.label}</span>
    </span>
  );
}
