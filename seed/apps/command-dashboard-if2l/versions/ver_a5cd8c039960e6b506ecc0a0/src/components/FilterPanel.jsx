// 监控任务与筛选面板：多语言关键词组启停、平台开关、坐标来源、时间窗、阈值配置入口
import { useState } from 'react';
import { KEYWORD_GROUPS } from '../data/keywords';

const TIME_WINDOWS = [
  { hours: 1, label: '近 1 小时' },
  { hours: 6, label: '近 6 小时' },
  { hours: 24, label: '近 24 小时' },
];

export default function FilterPanel({ m, onOpenThresholds }) {
  const [newTerm, setNewTerm] = useState('');
  const groups = KEYWORD_GROUPS.filter((g) =>
    m.allTasks.some((t) => t.language === g.language)
  );
  const customs = m.allTasks.filter((t) => !t.builtin);

  return (
    <section className="panel filter-panel">
      <div className="panel-title">
        监控任务与筛选
        <span className="tag">filter_panel</span>
      </div>

      <div className="filter-block">
        <div className="block-label">
          多语言关键词组<span className="hint">（演示配置 · 可启停 / 新增）</span>
        </div>
        {groups.map((g) => (
          <div key={g.language} className="kw-lang-row">
            <span className="kw-lang">{g.label}</span>
            <div className="chip-row">
              {m.allTasks
                .filter((t) => t.language === g.language)
                .map((t) => (
                  <button
                    key={t.taskId}
                    type="button"
                    className={`chip ${m.taskEnabled[t.taskId] ? 'on' : 'off'}`}
                    title={`${t.term} · 近 24h 命中 ${m.hitCount24hByTerm[t.term.toLowerCase()] || 0} 帖（演示）`}
                    onClick={() => m.toggleTerm(t.taskId)}
                  >
                    {t.term}
                    <em>{m.hitCount24hByTerm[t.term.toLowerCase()] || 0}</em>
                  </button>
                ))}
            </div>
          </div>
        ))}
        {customs.length > 0 && (
          <div className="kw-lang-row">
            <span className="kw-lang">自定义</span>
            <div className="chip-row">
              {customs.map((t) => (
                <button
                  key={t.taskId}
                  type="button"
                  className={`chip ${m.taskEnabled[t.taskId] ? 'on' : 'off'}`}
                  title={`${t.term} · 近 24h 命中 ${m.hitCount24hByTerm[t.term.toLowerCase()] || 0} 帖（演示）`}
                  onClick={() => m.toggleTerm(t.taskId)}
                >
                  {t.term}
                  <em>{m.hitCount24hByTerm[t.term.toLowerCase()] || 0}</em>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="kw-add">
          <input
            value={newTerm}
            placeholder="新增词组（任意语言）"
            maxLength={24}
            onChange={(e) => setNewTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                m.addKeywordTerm(newTerm);
                setNewTerm('');
              }
            }}
          />
          <button
            type="button"
            className="btn-mini"
            onClick={() => {
              m.addKeywordTerm(newTerm);
              setNewTerm('');
            }}
          >
            + 新增词组
          </button>
        </div>
      </div>

      <div className="filter-block">
        <div className="block-label">平台</div>
        <div className="chip-row">
          <button
            type="button"
            className={`chip ${m.platforms.x ? 'on' : 'off'}`}
            onClick={() => m.togglePlatform('x')}
          >
            X（推特）
          </button>
          <button
            type="button"
            className={`chip ${m.platforms.instagram ? 'on' : 'off'}`}
            onClick={() => m.togglePlatform('instagram')}
          >
            Instagram
          </button>
        </div>
      </div>

      <div className="filter-block">
        <div className="block-label">坐标来源（双通道）</div>
        <div className="chip-row">
          <button
            type="button"
            className={`chip ${m.coordSources.gps_tag ? 'on' : 'off'}`}
            onClick={() => m.toggleCoordSource('gps_tag')}
          >
            GPS 标签
          </button>
          <button
            type="button"
            className={`chip ${m.coordSources.exif ? 'on' : 'off'}`}
            onClick={() => m.toggleCoordSource('exif')}
          >
            图片 EXIF
          </button>
        </div>
      </div>

      <div className="filter-block">
        <div className="block-label">时间窗</div>
        <div className="chip-row">
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              className={`chip ${m.timeWindowHours === w.hours ? 'on' : 'off'}`}
              onClick={() => m.setTimeWindow(w.hours)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="hint">演示数据集覆盖近 24 小时（96 个批次）</div>
      </div>

      <div className="filter-block threshold-line">
        <button type="button" className="btn-mini" onClick={onOpenThresholds}>
          聚类阈值配置
        </button>
        <span className="mono threshold-echo">
          窗 {m.thresholds.windowMinutes}min / 半径 {m.thresholds.radiusKm}km / 账号 ≥
          {m.thresholds.minAccounts} / 相似度 ≥{m.thresholds.minSimilarity}
        </span>
      </div>

      <div className="filter-scope mono">
        当前筛选命中：{m.scopePosts.length} 帖 · 带坐标 {m.mapPosts.length} 帖
        <button type="button" className="btn-mini ghost" onClick={m.resetFilters}>
          清空筛选
        </button>
      </div>
    </section>
  );
}
