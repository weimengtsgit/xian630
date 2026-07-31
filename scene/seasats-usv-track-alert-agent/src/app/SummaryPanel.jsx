import { AlertTriangle, Gauge, Radio, Shield, ShieldAlert, Ship, MapPin } from "lucide-react";

const LEVEL_META = {
  critical: { label: "紧急", cls: "critical", Icon: ShieldAlert },
  high: { label: "高危", cls: "high", Icon: AlertTriangle },
  medium: { label: "中危", cls: "medium", Icon: AlertTriangle },
  low: { label: "低危", cls: "low", Icon: Shield },
  none: { label: "平稳", cls: "none", Icon: Shield },
};

const FINDING_ICON = { shore: MapPin, gauge: Gauge, ship: Ship, radio: Radio };

export function SummaryPanel({ summary }) {
  if (!summary) return null;
  const meta = LEVEL_META[summary.threatLevel] || LEVEL_META.none;
  const { Icon } = meta;
  return (
    <section className="summary-panel">
      <div className={`threat-badge ${meta.cls}`}>
        <Icon size={20} />
        <div>
          <small>智能体研判</small>
          <strong>{meta.label}</strong>
        </div>
      </div>
      <div className="summary-findings">
        {summary.findings.map((f, i) => {
          const FIcon = FINDING_ICON[f.icon] || MapPin;
          return (
            <div className="finding" key={i}>
              <FIcon size={14} />
              <small>{f.label}</small>
              <strong>{f.value}</strong>
            </div>
          );
        })}
      </div>
      <ul className="summary-advice">
        {summary.advice.map((a, i) => (
          <li key={i} className={`advice-${a.level || "low"}`}>{a.text}</li>
        ))}
      </ul>
    </section>
  );
}
