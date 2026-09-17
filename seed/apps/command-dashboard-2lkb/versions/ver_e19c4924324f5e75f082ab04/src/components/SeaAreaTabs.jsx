// 海域分组 Tab：『全部海域』+ 4 个美航母活动海域（演示配置），各带当前告警计数徽标
// 切换联动指标总览与矩阵过滤。
import { SEA_AREAS } from '../data/gridConfig.js';

export default function SeaAreaTabs({ activeArea, cells, onChange }) {
  const countOf = (areaId) => {
    const list = areaId === 'all' ? cells : cells.filter((c) => c.grid.seaAreaId === areaId);
    const red = list.filter((c) => c.level === 'red').length;
    const yellow = list.filter((c) => c.level === 'yellow').length;
    return { red, yellow, total: list.length };
  };
  const tabs = [{ id: 'all', name: '全部海域' }, ...SEA_AREAS.map((a) => ({ id: a.id, name: a.name }))];
  return (
    <div className="area-tabs" role="tablist" aria-label="海域分组">
      {tabs.map((t) => {
        const cnt = countOf(t.id);
        const active = activeArea === t.id;
        return (
          <button
            type="button"
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`area-tab${active ? ' active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.name}
            <span className="tab-count num">{cnt.total}</span>
            {cnt.red > 0 && <span className="tab-alert tab-red"><b aria-hidden="true">■</b>{cnt.red}</span>}
            {cnt.yellow > 0 && <span className="tab-alert tab-yellow"><b aria-hidden="true">▲</b>{cnt.yellow}</span>}
          </button>
        );
      })}
    </div>
  );
}
