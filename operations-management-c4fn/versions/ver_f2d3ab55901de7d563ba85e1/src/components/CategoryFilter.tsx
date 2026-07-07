import React from 'react';
import type { CategoryFilter as CategoryFilterType } from '../types';
import './CategoryFilter.css';

interface CategoryFilterProps {
  filters: CategoryFilterType[];
  activeKey: string;
  onChange: (key: string) => void;
}

const CategoryFilter: React.FC<CategoryFilterProps> = ({ filters, activeKey, onChange }) => {
  return (
    <div className="category-filter">
      {filters.map((f) => (
        <button
          key={f.key}
          className={`category-filter__btn ${activeKey === f.key ? 'category-filter__btn--active' : ''}`}
          onClick={() => onChange(f.key)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
};

export default CategoryFilter;
