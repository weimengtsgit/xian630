import React from 'react';
import type { SmartApp } from '../types';
import { CATEGORY_COLORS } from '../data/apps';
import './AppCard.css';

interface AppCardProps {
  app: SmartApp;
  onSelect: (app: SmartApp) => void;
  onToggleFavorite: (appId: string) => void;
}

const AppCard: React.FC<AppCardProps> = ({ app, onSelect, onToggleFavorite }) => {
  const categoryColor = CATEGORY_COLORS[app.category] || '#64748b';

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(app.id);
  };

  return (
    <div className="app-card" onClick={() => onSelect(app)}>
      {/* 状态角标 */}
      {app.status === '新品' && <span className="app-card__badge app-card__badge--new">新品</span>}
      {app.status === '热门' && <span className="app-card__badge app-card__badge--hot">热门</span>}

      {/* 图标（左侧） */}
      <div className="app-card__icon-wrap">
        <span className="app-card__icon">{app.icon}</span>
      </div>

      {/* 主体（中部） */}
      <div className="app-card__body">
        <h3 className="app-card__name">{app.name}</h3>
        <p className="app-card__desc">{app.description}</p>
        <div className="app-card__footer">
          <span
            className="app-card__category"
            style={{ color: categoryColor, borderColor: categoryColor }}
          >
            {app.category}
          </span>
          <span className="app-card__version">{app.version}</span>
          <span className="app-card__date">{app.publishDate}</span>
        </div>
      </div>

      {/* 右侧操作区 */}
      <div className="app-card__actions">
        <button
          type="button"
          className={`app-card__fav ${app.favorited ? 'app-card__fav--active' : ''}`}
          onClick={handleFavoriteClick}
          title={app.favorited ? '取消收藏' : '收藏应用'}
          aria-label={app.favorited ? '取消收藏' : '收藏应用'}
          aria-pressed={app.favorited}
        >
          {app.favorited ? '★' : '☆'}
        </button>
        <span className="app-card__visit-hint" aria-hidden="true">访问 ›</span>
      </div>
    </div>
  );
};

export default AppCard;
