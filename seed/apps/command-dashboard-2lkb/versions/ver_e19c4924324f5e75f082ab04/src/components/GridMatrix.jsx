// 海域分组网格矩阵：列数随断点（≥1440 四列 / 1024–1439 三列 / 768–1023 两列 / <768 单列紧凑卡）
// 非桌面断点时，下钻详情在选中格下方展开（span 全列）。
import { Fragment } from 'react';
import GridCell from './GridCell.jsx';

export default function GridMatrix({ cells, selectedGridId, onSelect, cols, compact, loading, showInlineDrill, drilldown }) {
  return (
    <div className={`matrix cols-${cols}${compact ? ' matrix-compact' : ''}`} role="grid" aria-label="50 海里监控网格矩阵">
      {cells.map((cell) => (
        <Fragment key={cell.grid.gridId}>
          <GridCell cell={cell} selected={cell.grid.gridId === selectedGridId} onSelect={onSelect} compact={compact} loading={loading} />
          {showInlineDrill && cell.grid.gridId === selectedGridId && (
            <div className="cell-drilldown">{drilldown}</div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
