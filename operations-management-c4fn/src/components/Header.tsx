import React from 'react';
import './Header.css';

const Header: React.FC = () => {
  return (
    <div className="app-header">
      <div className="app-header__title-row">
        <div className="app-header__icon">🛡️</div>
        <h1 className="app-header__title">智能应用商店</h1>
        <span className="app-header__badge">演示数据</span>
      </div>
      <p className="app-header__subtitle">
        浏览卡片式智能软件目录，查看新品推荐，点击卡片跳转访问各内置应用
      </p>
    </div>
  );
};

export default Header;
