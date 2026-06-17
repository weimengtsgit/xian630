import { Search } from "lucide-react";
import { kindMeta, targets } from "../data/mockSituation";
import { getVisibleTargets, useSituationStore } from "../useSituationStore";
import type { Target, TargetKind } from "../types";

const tabs = ["基本信息", "编队构成", "关联人员", "历史时间"];

function TargetThumbnail({ target }: { target: Target }) {
  return (
    <div className={`target-thumb ${target.visual}`} aria-hidden="true">
      <span />
    </div>
  );
}

function StatusBadge({ status }: { status: Target["status"] }) {
  const label = {
    alert: "告警",
    identified: "识别",
    tracking: "跟踪",
  }[status];

  return <span className={`status-badge ${status}`}>{label}</span>;
}

export function TargetPanel() {
  const query = useSituationStore((state) => state.query);
  const activeKinds = useSituationStore((state) => state.activeKinds);
  const selectedTargetId = useSituationStore((state) => state.selectedTargetId);
  const setQuery = useSituationStore((state) => state.setQuery);
  const toggleKind = useSituationStore((state) => state.toggleKind);
  const setSelectedTargetId = useSituationStore((state) => state.setSelectedTargetId);

  const visibleTargets = getVisibleTargets(activeKinds, query);

  return (
    <section className="target-panel" aria-label="目标情报面板">
      <div className="search-shell">
        <Search size={14} />
        <input
          type="search"
          placeholder="搜索"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      <div className="panel-tabs" role="tablist" aria-label="情报页签">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={tab === "编队构成" ? "active" : undefined}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="panel-section">
        <button type="button" className="section-title">
          摘要描述信息
          <span>⌄</span>
        </button>
        <p>
          人工智能模型检测到，重点目标存在连续的活动和多源关联，并形成若干关键轨迹。
          已经发出了多种导弹，并练习了类似封锁和海域入侵的态势。
          此界面演示目标融合、状态识别和轨迹分析。
        </p>
      </div>

      <div className="panel-section">
        <button type="button" className="section-title">
          类型显示
          <span>⌄</span>
        </button>
        <div className="kind-controls">
          {(Object.keys(kindMeta) as TargetKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={activeKinds.includes(kind) ? "active" : undefined}
              onClick={() => toggleKind(kind)}
            >
              <span style={{ backgroundColor: kindMeta[kind].color }} />
              {kindMeta[kind].label}
            </button>
          ))}
        </div>
      </div>

      <div className="target-list" aria-label="目标列表">
        {visibleTargets.map((target) => (
          <button
            key={target.id}
            type="button"
            className={`target-row ${target.id === selectedTargetId ? "selected" : ""}`}
            onClick={() => setSelectedTargetId(target.id)}
          >
            <TargetThumbnail target={target} />
            <span className="target-main">
              <span>
                <strong>名称：</strong>
                {target.name}
              </span>
              <span>
                <strong>状态：</strong>
                {kindMeta[target.kind].shortLabel} / {target.code}
              </span>
              <span>
                <strong>所属中心：</strong>
                {target.owner}
              </span>
            </span>
            <span className="target-meta">
              <span>发现时间：{target.discoveredAt.slice(0, 10)}</span>
              <span>
                状态信息：
                <StatusBadge status={target.status} />
              </span>
              <span>快捷链接：轨迹信息</span>
            </span>
          </button>
        ))}
      </div>

      <div className="panel-footer">
        <span>目标总数 {targets.length}</span>
        <span>显示 {visibleTargets.length}</span>
      </div>
    </section>
  );
}

