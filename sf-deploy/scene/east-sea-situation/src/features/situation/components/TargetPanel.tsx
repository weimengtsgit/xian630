import { useState } from "react";
import { Search } from "lucide-react";
import { kindMeta, relations, targets } from "../data/mockSituation";
import { getVisibleTargets, useSituationStore } from "../useSituationStore";
import type { Coordinates, Relation, Target, TargetKind } from "../types";

type TabId = "basic" | "formation" | "people" | "history";

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "basic", label: "基本信息" },
  { id: "formation", label: "编队构成" },
  { id: "people", label: "关联人员" },
  { id: "history", label: "历史时间" },
];

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

function formatCoordinate([lng, lat]: Coordinates) {
  return `${lat.toFixed(2)}°N / ${lng.toFixed(2)}°E`;
}

function seaAreaFor(target: Target) {
  const [, lat] = target.position;

  if (lat >= 30) {
    return "东海北部";
  }

  if (lat <= 26.2) {
    return "东海南部";
  }

  return "东海中部";
}

function lastEventFor(target: Target) {
  return target.events[target.events.length - 1];
}

function relatedItemsFor(target: Target) {
  return relations
    .filter(
      (relation) =>
        relation.fromTargetId === target.id || relation.toTargetId === target.id,
    )
    .map((relation) => {
      const relatedTargetId =
        relation.fromTargetId === target.id
          ? relation.toTargetId
          : relation.fromTargetId;
      const relatedTarget = targets.find((item) => item.id === relatedTargetId);

      return {
        relation,
        target: relatedTarget,
      };
    })
    .filter((item): item is { relation: Relation; target: Target } => Boolean(item.target));
}

function BasicInfoTab({ target }: { target: Target }) {
  const rows = [
    ["目标编号", target.code],
    ["目标类型", kindMeta[target.kind].label],
    ["当前状态", <StatusBadge status={target.status} />],
    ["所在海域", seaAreaFor(target)],
    ["当前位置", formatCoordinate(target.position)],
    ["发现时间", target.discoveredAt],
    ["航向航速", `${target.heading}° / ${target.speed} km/h`],
    ["融合置信", `${target.confidence}%`],
    ["所属中心", target.owner],
  ];

  return (
    <div className="tab-content">
      <div className="detail-grid">
        {rows.map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </div>
      <div className="summary-card">
        <strong>摘要判断</strong>
        <p>{target.summary}</p>
      </div>
    </div>
  );
}

function FormationTab({ target }: { target: Target }) {
  const relatedItems = relatedItemsFor(target);

  return (
    <div className="tab-content">
      <div className="summary-card">
        <strong>编队摘要</strong>
        <p>
          以 {target.name} 为当前观察对象，结合伴随航迹、区域节点和时序事件生成编队关系。
        </p>
      </div>
      <div className="relation-list">
        {relatedItems.length > 0 ? (
          relatedItems.map(({ relation, target: relatedTarget }) => (
            <div key={relation.id} className="relation-item">
              <span>{relation.label}</span>
              <strong>{relatedTarget.name}</strong>
              <em>{Math.round(relation.strength * 100)}%</em>
            </div>
          ))
        ) : (
          <div className="empty-state">暂无稳定关联目标</div>
        )}
      </div>
    </div>
  );
}

function PeopleTab({ target }: { target: Target }) {
  const ownerIndex = target.owner.match(/\d+/)?.[0] ?? "01";
  const latestEvent = lastEventFor(target);
  const contacts = [
    {
      role: "值班分析员",
      name: `人员-A${ownerIndex}`,
      unit: target.owner,
      status: target.status === "alert" ? "处置中" : "在线",
      action: `${latestEvent?.time ?? "--:--"} ${latestEvent?.title ?? "状态更新"}`,
    },
    {
      role: "审核席位",
      name: `人员-B${ownerIndex}`,
      unit: "目标研判组",
      status: target.confidence >= 85 ? "已审核" : "待复核",
      action: `置信度 ${target.confidence}%`,
    },
    {
      role: "来源节点",
      name: `监测站-东海-${ownerIndex}`,
      unit: "多源接入网",
      status: "连接正常",
      action: `${seaAreaFor(target)} 数据回传`,
    },
  ];

  return (
    <div className="tab-content">
      <div className="contact-list">
        {contacts.map((contact) => (
          <article key={contact.role} className="contact-card">
            <header>
              <span>{contact.role}</span>
              <em>{contact.status}</em>
            </header>
            <strong>{contact.name}</strong>
            <p>{contact.unit}</p>
            <small>{contact.action}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function HistoryTab({ target }: { target: Target }) {
  const discoveredTime = target.discoveredAt.slice(11, 16);
  const events = [
    {
      id: `${target.id}-discovered`,
      time: discoveredTime,
      title: "首次发现",
      detail: `${target.owner} 在 ${seaAreaFor(target)} 建立目标记录。`,
    },
    ...target.events,
  ];

  return (
    <div className="tab-content">
      <div className="history-list">
        {events.map((event) => (
          <article key={event.id} className="history-item">
            <time>{event.time}</time>
            <div>
              <strong>{event.title}</strong>
              <p>{event.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function TabContent({ activeTab, target }: { activeTab: TabId; target: Target }) {
  if (activeTab === "basic") {
    return <BasicInfoTab target={target} />;
  }

  if (activeTab === "people") {
    return <PeopleTab target={target} />;
  }

  if (activeTab === "history") {
    return <HistoryTab target={target} />;
  }

  return <FormationTab target={target} />;
}

export function TargetPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("formation");
  const query = useSituationStore((state) => state.query);
  const activeKinds = useSituationStore((state) => state.activeKinds);
  const selectedTargetId = useSituationStore((state) => state.selectedTargetId);
  const setQuery = useSituationStore((state) => state.setQuery);
  const toggleKind = useSituationStore((state) => state.toggleKind);
  const setSelectedTargetId = useSituationStore((state) => state.setSelectedTargetId);

  const visibleTargets = getVisibleTargets(activeKinds, query);
  const selectedTarget =
    targets.find((target) => target.id === selectedTargetId) ?? targets[0];

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
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={tab.id === activeTab ? "active" : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <TabContent activeTab={activeTab} target={selectedTarget} />

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
