import React from 'react';
import type { CategoryFilter as CategoryFilterType } from '../types';
import './CategoryFilter.css';

interface CategoryFilterProps {
  filters: CategoryFilterType[];
  activeKey: string;
  onChange: (key: string) => void;
  counts?: Record<string, number>;
}

const CategoryFilter: React.FC<CategoryFilterProps> = ({
  filters,
  activeKey,
  onChange,
  counts,
}) => {
  return (
    <nav className="category-filter" aria-label="应用分类">
      {filters.map((f) => {
        const count = counts?.[f.key];
        const isActive = activeKey === f.key;
        return (
          <button
            key={f.key}
            type="button"
            className={`category-filter__btn ${isActive ? 'category-filter__btn--active' : ''}`}
            onClick={() => onChange(f.key)}
            aria-pressed={isActive}
          >
            <span className="category-filter__label">{f.label}</span>
            {typeof count === 'number' && (
              <span className="category-filter__count">{count}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
};

export default CategoryFilter;
