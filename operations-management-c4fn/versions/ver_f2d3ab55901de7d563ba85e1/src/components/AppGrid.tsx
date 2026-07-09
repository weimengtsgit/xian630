import React from 'react';
import type { SmartApp } from '../types';
import AppCard from './AppCard';
import './AppGrid.css';

interface AppGridProps {
  apps: SmartApp[];
  onSelectApp: (app: SmartApp) => void;
  onToggleFavorite: (appId: string) => void;
  emptyText?: string;
}

const AppGrid: React.FC<AppGridProps> = ({
  apps,
  onSelectApp,
  onToggleFavorite,
  emptyText = '暂无应用',
}) => {
  if (apps.length === 0) {
    return (
      <div className="app-grid__empty">
        <span className="app-grid__empty-icon">📭</span>
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="app-grid">
      {apps.map((app) => (
        <AppCard
          key={app.id}
          app={app}
          onSelect={onSelectApp}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
};

export default AppGrid;
