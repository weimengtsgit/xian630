import { Network } from "lucide-react";
import {
  statusBadgeClass,
  fmtDate,
  carrierName,
} from "./statusHelpers.js";

// Upper-right panel — 航母归属关系树.
// Carrier nodes with child aircraft; per-aircraft confidence + latest activity +
// status badge. Clicking an aircraft selects it (jump to left detail). Clicking a
// carrier filters the table + highlights that carrier's track.
export function CarrierTree({
  aircraft,
  carriers,
  selectedIcao,
  selectedCarrierId,
  onSelectAircraft,
  onSelectCarrier,
}) {
  // group aircraft by inferred/associated carriers
  const byCarrier = new Map();
  const unbound = [];
  for (const a of aircraft) {
    const ids = a.carrierProbabilities.length
      ? a.carrierProbabilities.map((c) => c.carrierId)
      : [];
    if (ids.length === 0) {
      unbound.push(a);
      continue;
    }
    for (const id of ids) {
      if (!byCarrier.has(id)) byCarrier.set(id, []);
      byCarrier.get(id).push(a);
    }
  }

  return (
    <section className="cai-tree">
      <div className="cai-panel-head">
        <h2>
          <Network size={14} style={{ verticalAlign: "-2px" }} /> 航母归属关系树
        </h2>
        <span className="meta">{carriers.length} 艘航母 · {aircraft.length} 架飞机</span>
      </div>
      <div className="cai-treelist">
        {carriers.map((c) => {
          const children = byCarrier.get(c.id) || [];
          const isSel = selectedCarrierId === c.id;
          return (
            <div key={c.id} className={`cai-carrier-node ${isSel ? "selected" : ""}`}>
              <div className="cai-carrier-head" onClick={() => onSelectCarrier(c.id)}>
                <span style={{ color: "#68ddff" }}>▾</span>
                <span className="cname">{c.name}</span>
                <span className="ccount">{children.length} 架</span>
              </div>
              <div className="cai-carrier-children">
                {children.length === 0 && (
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>无关联飞机</span>
                )}
                {children.map((a) => {
                  const prob = a.carrierProbabilities.find((p) => p.carrierId === c.id);
                  return (
                    <div
                      key={a.icao + c.id}
                      className={`cai-aircraft-node ${a.icao === selectedIcao ? "selected" : ""}`}
                      onClick={() => onSelectAircraft(a.icao)}
                    >
                      <span className="icao">{a.icao}</span>
                      <span className="atype">{a.aircraftType}</span>
                      <span className="latest">
                        {fmtDate(a.latestActivityDate)} ·{" "}
                        {prob ? `${Math.round(prob.probability * 100)}%` : "—"}
                      </span>
                      <span className={`cai-badge ${statusBadgeClass(a.status)}`}>{a.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {unbound.length > 0 && (
          <div className="cai-unbound-group">
            <div className="ughead">未绑定 / 数据不足（{unbound.length}）</div>
            {unbound.map((a) => (
              <div
                key={a.icao}
                className={`cai-aircraft-node ${a.icao === selectedIcao ? "selected" : ""}`}
                onClick={() => onSelectAircraft(a.icao)}
              >
                <span className="icao">{a.icao}</span>
                <span className="atype">{a.aircraftType}</span>
                <span className="latest">{fmtDate(a.latestActivityDate)}</span>
                <span className={`cai-badge ${statusBadgeClass(a.status)}`}>{a.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
