import React, { useMemo } from 'react';
import { GRADE_LABELS } from '../constants.js';

const GRADE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'satisfied', label: GRADE_LABELS.satisfied },
  { id: 'conditional', label: GRADE_LABELS.conditional },
  { id: 'unsatisfied', label: GRADE_LABELS.unsatisfied },
  { id: 'undetermined', label: GRADE_LABELS.undetermined },
];

function GradeBadge({ grade }) {
  return <span className={`badge grade-${grade}`}>{GRADE_LABELS[grade] || '—'}</span>;
}

function ConditionCell({ value }) {
  if (value === true) return <span className="cond ok">✓ 可行</span>;
  if (value === false) return <span className="cond bad">✗ 不满足</span>;
  return <span className="cond na">— 无法判定</span>;
}

// 主任务区 · 航母态势矩阵（逐艘判定，行选中 + 筛选/搜索）
export default function CarrierMatrix({
  carriers, selectedId, onSelect, query, onQuery, gradeFilter, onGradeFilter, highlightIds,
}) {
  const highlightSet = useMemo(() => new Set(highlightIds || []), [highlightIds]);

  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    return carriers.filter((c) => {
      if (gradeFilter !== 'all' && c.deckWind.grade !== gradeFilter) return false;
      if (!q) return true;
      return [c.name, c.hullNumber, c.position.seaArea || '', c.className || '']
        .some((s) => String(s).toLowerCase().includes(q));
    });
  }, [carriers, query, gradeFilter]);

  return (
    <section className="panel matrix-panel" aria-label="航母态势矩阵">
      <div className="panel-head">
        <h2>航母态势矩阵</h2>
        <div className="matrix-tools">
          <input
            type="search"
            className="search-input"
            placeholder="搜索舰名 / 舷号 / 海域"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="搜索舰艇"
          />
          <div className="grade-filters" role="group" aria-label="按判定分级筛选">
            {GRADE_FILTERS.map((f) => (
              <button
                type="button"
                key={f.id}
                className={`chip ${gradeFilter === f.id ? 'active' : ''}`}
                onClick={() => onGradeFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="matrix-table">
          <thead>
            <tr>
              <th>舰名 / 舷号</th>
              <th className="col-md">位置海域</th>
              <th className="col-sm">位置时效</th>
              <th>10 米风速</th>
              <th className="col-md">风向</th>
              <th className="col-sm">甲板风范围 [|W−30|, W+30]</th>
              <th>无弹射器辅助起飞</th>
              <th>安全着舰</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr className="empty-row">
                <td colSpan={8}>当前筛选条件下无舰艇（共 {carriers.length} 艘在册）</td>
              </tr>
            )}
            {filtered.map((c) => (
              <tr
                key={c.id}
                className={`${selectedId === c.id ? 'selected' : ''} ${highlightSet.has(c.id) ? 'highlight' : ''} quality-${c.dataQuality}`}
                onClick={() => onSelect(c.id)}
              >
                <td>
                  <div className="ship-name">
                    {c.name}
                    {c.dataQuality === 'error' && <span className="row-flag error" title={c.windError || '数据异常'}>异常</span>}
                    {c.dataQuality === 'stale' && <span className="row-flag stale" title="数据陈旧，结论仅供参考">陈旧</span>}
                  </div>
                  <div className="ship-hull">{c.hullNumber}{c.className ? ` · ${c.className}` : ''}</div>
                </td>
                <td className="col-md">
                  {c.position.source === 'static-default-region'
                    ? <span className="pos-static" title="位置库不可用，按默认活动区域代表点评估（非当前位置）">{c.position.seaArea || '—'} · 默认区域</span>
                    : (c.position.seaArea || '—')}
                </td>
                <td className="col-sm">
                  <span className={`age stale-${c.position.staleLevel}`}>
                    {c.position.observedAt ? c.position.ageLabel : '不可用'}
                  </span>
                </td>
                <td className="num">{c.wind ? `${c.wind.speedKt.toFixed(1)} kn` : '—'}</td>
                <td className="col-md">{c.wind ? `${c.wind.directionText} ${Math.round(c.wind.directionDeg)}°` : '—'}</td>
                <td className="col-sm num range-cell">
                  {c.deckWind.minDeckWindKt != null
                    ? `[${c.deckWind.minDeckWindKt.toFixed(1)}, ${c.deckWind.maxDeckWindKt.toFixed(1)}] kn`
                    : '—'}
                </td>
                <td><ConditionCell value={c.deckWind.unassistedTakeoff} /></td>
                <td>
                  <div className="cond-wrap">
                    <ConditionCell value={c.deckWind.safeRecovery} />
                    <GradeBadge grade={c.deckWind.grade} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="matrix-note">
        范围列即合成结果：|W−30| 与 W+30（单位节）；点击行查看单舰矢量合成明细与判定依据。
      </p>
    </section>
  );
}
