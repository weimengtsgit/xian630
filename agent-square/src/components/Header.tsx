import React from 'react';
import './Header.css';

const Header: React.FC = () => {
  return (
    <div className="app-header">
      <div className="app-header__title-row">
        <div className="app-header__icon">🛡️</div>
        <h1 className="app-header__title">航母研判智能体广场</h1>
      </div>
      <p className="app-header__subtitle">
        浏览卡片式智能体目录，查看新品推荐，点击卡片跳转访问各内置智能体
      </p>
    </div>
  );
};

export default Header;
