import { useMemo, useState } from "react";
import { Radar, Sliders } from "lucide-react";
import { buildPayload } from "../data/mock.js";
import { AircraftList } from "./AircraftList.jsx";
import { CarrierTree } from "./CarrierTree.jsx";
import { HeatMap } from "./HeatMap.jsx";
import { fmtDateTime } from "./statusHelpers.js";
import { revealAircraftSelection } from "../logic/interaction.js";

// Carrier-air-wing affiliation inference command dashboard.
//
// Layout: top bar (title + judgement params + mock-source state) over a main
// grid — left 疑似舰载机列表 | upper-right 航母归属关系树 | lower-right 起降热力地图.
// All three panels are visible in the first desktop viewport. Cross-panel linking
// is bidirectional: aircraft ↔ tree node ↔ map events; carrier filters the table
// and highlights its blue track; a map event expands the matching aircraft row.
export function App() {
  // Fixed "now" so the 已离舰 alert is deterministic regardless of build time.
  const NOW = useMemo(() => new Date(Date.UTC(2024, 5, 15, 0, 0, 0)).toISOString(), []);
  const payload = useMemo(() => buildPayload(NOW), [NOW]);

  const [selectedIcao, setSelectedIcao] = useState(null);
  const [selectedCarrierId, setSelectedCarrierId] = useState(null);
  const [carrierFilter, setCarrierFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("default");

  // Bidirectional cross-panel linking.
  const toggleAircraft = (icao) => {
    setSelectedIcao((cur) => (cur === icao ? null : icao));
  };
  const revealAircraft = (icao) => {
    const next = revealAircraftSelection(icao);
    setSelectedIcao(next.selectedIcao);
    setSelectedCarrierId(next.selectedCarrierId);
    setCarrierFilter(next.carrierFilter);
  };
  const selectCarrier = (id) => {
    // clicking a carrier both highlights its track and filters the table
    setSelectedCarrierId((cur) => (cur === id ? null : id));
    setCarrierFilter((cur) => (cur === id ? "ALL" : id));
  };
  // Selecting a map event expands the matching aircraft row (cross-link).
  const selectEvent = (evt) => {
    revealAircraft(evt.icao);
  };

  const params = payload.judgementParameters;
  const src = payload.sourceState;

  return (
    <div className="cai-shell">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="cai-topbar">
        <div className="cai-title">
          <Radar size={20} color="#68ddff" />
          <h1>航母舰载机归属推断工具</h1>
          <span className="cai-sub">ADS-B 海上起降 × 航母位置 归属研判</span>
        </div>

        <div className="cai-paramsbar">
          <span className="ppulse" />
          <span className="param" title="关联距离阈值">
            关联距离 <b>{params.associationDistanceNm}</b> 海里
          </span>
          <span className="param" title="高置信度阈值">
            高置信度 <b>&gt;{Math.round(params.highConfidenceThreshold * 100)}%</b>
          </span>
          <span className="param" title="已离舰判定">
            已离舰 <b>{params.departedDays}</b> 天
          </span>
          <span className="param" title="近地去噪阈值">
            近地 <b>{params.nearGroundAltitudeFt}</b> ft
          </span>
          <span className="param" title="数据不足阈值">
            数据不足 <b>&lt;{params.minimumBoundAssociations}</b> 次已绑定
          </span>
        </div>

        <div className="cai-status">
          <span className="mock-badge">mock</span>
          <span className="src">{src.adsbSource}</span>
          <span className="src">{src.carrierPositionSource}</span>
          <span className="src">{src.landSeaMaskSource}</span>
          <span>
            数据窗口 {src.dataWindowYears} 年 · 载入 {fmtDateTime(src.lastLoadedAt)}
          </span>
        </div>
      </header>

      {/* ── Main board ──────────────────────────────────────────────────── */}
      <main className="cai-main">
        <AircraftList
          aircraft={payload.aircraft}
          events={payload.events}
          carriers={payload.carriers}
          selectedIcao={selectedIcao}
          carrierFilter={carrierFilter}
          sortBy={sortBy}
          onSelectAircraft={toggleAircraft}
          onCarrierFilter={(v) => {
            setCarrierFilter(v);
            // sync carrier highlight when filtering by a carrier
            setSelectedCarrierId(v === "ALL" || v === "UNBOUND" ? null : v);
          }}
          onSort={setSortBy}
        />

        <CarrierTree
          aircraft={payload.aircraft}
          carriers={payload.carriers}
          selectedIcao={selectedIcao}
          selectedCarrierId={selectedCarrierId}
          onSelectAircraft={revealAircraft}
          onSelectCarrier={selectCarrier}
        />

        <HeatMap
          events={payload.events}
          carriers={payload.carriers}
          selectedIcao={selectedIcao}
          selectedCarrierId={selectedCarrierId}
          onSelectEvent={selectEvent}
          onSelectCarrier={selectCarrier}
        />
      </main>
    </div>
  );
}
