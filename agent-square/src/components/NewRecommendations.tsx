import React from 'react';
import type { SmartApp } from '../types';
import { CATEGORY_COLORS } from '../data/apps';
import './NewRecommendations.css';

interface NewRecommendationsProps {
  apps: SmartApp[];
  onSelect: (app: SmartApp) => void;
}

const NewRecommendations: React.FC<NewRecommendationsProps> = ({ apps, onSelect }) => {
  const priority: Record<string, number> = {
    '“光鱼”无人艇跟监告警智能体': -1,
    '航母舰载机挖掘分析': 0,
    '航母甲板风条件评估看板': 1,
    '华盛顿号航母打击群西太地区活动规律分析智能体': 2,
  };
  const newApps = apps
    .filter((a) => a.status === '新品')
    .sort((a, b) => (priority[a.name] ?? 99) - (priority[b.name] ?? 99));

  if (newApps.length === 0) return null;

  return (
    <div className="new-recs">
      <div className="new-recs__header">
        <span className="new-recs__title">新品推荐</span>
        <span className="new-recs__count">{Math.min(newApps.length, 3)} 款新品</span>
      </div>
      <div className="new-recs__list">
        {newApps.slice(0, 3).map((app) => (
          <div key={app.id} className="new-rec-card" onClick={() => onSelect(app)}>
            <span className="new-rec-card__badge">新品</span>
            <span className="new-rec-card__icon">{app.icon}</span>
            <div className="new-rec-card__info">
              <h4 className="new-rec-card__name">{app.name}</h4>
              <p className="new-rec-card__desc">{app.description}</p>
            </div>
            <span
              className="new-rec-card__category"
              style={{ color: CATEGORY_COLORS[app.category] }}
            >
              {app.category}
            </span>
            <div className="new-rec-card__meta">
              <span className="new-rec-card__version">{app.version}</span>
              <span className="new-rec-card__vendor">{app.vendor || '国防科大，电子云'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NewRecommendations;
