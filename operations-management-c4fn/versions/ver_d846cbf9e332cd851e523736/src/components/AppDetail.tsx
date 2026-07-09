import React from 'react';
import type { SmartApp } from '../types';
import { CATEGORY_COLORS } from '../data/apps';
import './AppDetail.css';

interface AppDetailProps {
  app: SmartApp | null;
  onClose: () => void;
  onToggleFavorite: (appId: string) => void;
}

const AppDetail: React.FC<AppDetailProps> = ({ app, onClose, onToggleFavorite }) => {
  if (!app) return null;

  const categoryColor = CATEGORY_COLORS[app.category] || '#64748b';

  return (
    <div className="app-detail-overlay" onClick={onClose}>
      <div className="app-detail" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="app-detail__header">
          <button className="app-detail__close" onClick={onClose} aria-label="关闭详情">
            ✕
          </button>
          <div className="app-detail__icon-wrap">
            <span className="app-detail__icon">{app.icon}</span>
          </div>
          <div className="app-detail__title-area">
            <h2 className="app-detail__name">{app.name}</h2>
            <div className="app-detail__meta-row">
              <span className="app-detail__category" style={{ color: categoryColor, borderColor: categoryColor }}>
                {app.category}
              </span>
              {app.status === '新品' && <span className="app-detail__status app-detail__status--new">新品</span>}
              {app.status === '热门' && <span className="app-detail__status app-detail__status--hot">热门</span>}
              <span className="app-detail__version">{app.version}</span>
            </div>
          </div>
        </div>

        {/* 描述 */}
        <div className="app-detail__section">
          <h3 className="app-detail__section-title">应用简介</h3>
          <p className="app-detail__desc">{app.longDescription}</p>
        </div>

        {/* 功能特性 */}
        <div className="app-detail__section">
          <h3 className="app-detail__section-title">功能特性</h3>
          <ul className="app-detail__features">
            {app.features.map((feat, i) => (
              <li key={i} className="app-detail__feature-item">
                <span className="app-detail__feature-dot" style={{ background: categoryColor }} />
                {feat}
              </li>
            ))}
          </ul>
        </div>

        {/* 信息 */}
        <div className="app-detail__section">
          <h3 className="app-detail__section-title">应用信息</h3>
          <div className="app-detail__info-grid">
            <div className="app-detail__info-item">
              <span className="app-detail__info-label">上架日期</span>
              <span className="app-detail__info-value">{app.publishDate}</span>
            </div>
            <div className="app-detail__info-item">
              <span className="app-detail__info-label">版本号</span>
              <span className="app-detail__info-value">{app.version}</span>
            </div>
            <div className="app-detail__info-item">
              <span className="app-detail__info-label">状态</span>
              <span className="app-detail__info-value">{app.status}</span>
            </div>
            <div className="app-detail__info-item">
              <span className="app-detail__info-label">数据来源</span>
              <span className="app-detail__info-value app-detail__info-value--mock">演示数据</span>
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="app-detail__actions">
          <button
            className={`app-detail__fav-btn ${app.favorited ? 'app-detail__fav-btn--active' : ''}`}
            onClick={() => onToggleFavorite(app.id)}
          >
            {app.favorited ? '★ 已收藏' : '☆ 收藏应用'}
          </button>
          <a
            className="app-detail__visit-btn"
            href={app.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            访问应用 →
          </a>
        </div>
      </div>
    </div>
  );
};

export default AppDetail;
