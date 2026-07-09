import React from 'react';
import './StatusBar.css';

interface StatusBarProps {
  appCount: number;
  newCount: number;
  favoritedCount: number;
}

const StatusBar: React.FC<StatusBarProps> = ({ appCount, newCount, favoritedCount }) => {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__label">作战管理中心</span>
        <span className="status-bar__divider">|</span>
        <span className="status-bar__label">航母研判智能体广场 v1.0</span>
        <span className="status-bar__divider">|</span>
        <span className="status-bar__info">分类等级：非密</span>
      </div>
      <div className="status-bar__center">
        <span className="status-bar__metric">
          应用总数 <strong>{appCount}</strong>
        </span>
        <span className="status-bar__metric status-bar__metric--new">
          新品 <strong>{newCount}</strong>
        </span>
        <span className="status-bar__metric status-bar__metric--fav">
          已收藏 <strong>{favoritedCount}</strong>
        </span>
      </div>
      <div className="status-bar__right">
        <span className="status-bar__time">
          {new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </span>
        <span className="status-bar__divider">|</span>
        <span className="status-bar__status status-bar__status--ok">系统正常</span>
      </div>
    </div>
  );
};

export default StatusBar;
