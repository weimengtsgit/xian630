import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Wind,
  Anchor,
  Gauge,
  Plane,
  PlaneLanding,
  RefreshCw,
  Compass,
  Info,
} from "lucide-react";
import {
  getSnapshot,
  REFRESH_CADENCE,
  DEMO_TICK_MS,
  DECK_WIND_MIN_KT,
  CARRIER_MAX_SPEED_KT,
  DATA_SOURCE_NAME,
  computeAchievableRange,
} from "../data/mock.js";

const STATUS_TEXT = {
  ok: "满足",
  warn: "临界",
  fail: "不满足",
};

// "worst" status of the two conditions -> map dot color
function regionDot(rec) {
  const a = rec.conditions.noCatapult.status;
  const b = rec.conditions.safeRecovery.status;
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

function fmtTime(d) {
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDir(deg) {
  return `${Math.round(deg)}°`;
}

// ---- inline SVG world/sea-area map ----
// Equirectangular projection mapped into a 720x360 viewBox (lon -180..180, lat 90..-90).
function lonToX(lon) {
  return ((lon + 180) / 360) * 720;
}
function latToY(lat) {
  return ((90 - lat) / 180) * 360;
}

// Simplified landmass blobs (decorative silhouettes) so regions read as sea areas.
const LANDMASSES = [
  // North America
  "M120,70 L150,55 L200,50 L235,70 L250,110 L225,150 L205,180 L175,175 L150,150 L130,120 Z",
  // South America
  "M205,190 L235,185 L250,220 L245,270 L225,300 L210,295 L200,260 L195,220 Z",
  // Europe
  "M355,70 L395,65 L415,80 L400,100 L370,98 L355,88 Z",
  // Africa
  "M370,110 L415,105 L430,140 L420,200 L400,235 L380,235 L365,200 L360,150 Z",
  // Asia
  "M415,55 L520,50 L580,70 L600,110 L570,140 L520,135 L470,120 L430,95 Z",
  // SE Asia / Indonesia
  "M580,150 L640,145 L660,170 L635,185 L600,178 Z",
  // Australia
  "M610,225 L680,220 L695,250 L670,270 L625,265 L605,245 Z",
];

function SeaAreaMap({ regions, selectedId, onSelect }) {
  return (
    <svg
      className="map-svg"
      viewBox="0 0 720 360"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="全球航母活动区域海区示意图"
    >
      <defs>
        <radialGradient id="seaGrad" cx="50%" cy="40%" r="75%">
          <stop offset="0%" stopColor="#0a2438" />
          <stop offset="100%" stopColor="#04101d" />
        </radialGradient>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path
            d="M20 0 L0 0 0 20"
            fill="none"
            stroke="rgba(104,221,255,0.06)"
            strokeWidth="0.5"
          />
        </pattern>
      </defs>

      <rect x="0" y="0" width="720" height="360" fill="url(#seaGrad)" />
      <rect x="0" y="0" width="720" height="360" fill="url(#grid)" />

      {/* equator + tropics */}
      <line x1="0" y1="180" x2="720" y2="180" stroke="rgba(104,221,255,0.12)" strokeWidth="0.5" />
      <line x1="0" y1="135" x2="720" y2="135" stroke="rgba(104,221,255,0.07)" strokeWidth="0.5" strokeDasharray="3 4" />
      <line x1="0" y1="225" x2="720" y2="225" stroke="rgba(104,221,255,0.07)" strokeWidth="0.5" strokeDasharray="3 4" />

      {/* landmass silhouettes */}
      {LANDMASSES.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="rgba(60,110,130,0.22)"
          stroke="rgba(104,221,255,0.22)"
          strokeWidth="0.6"
        />
      ))}

      {/* region points */}
      {regions.map((r) => {
        const cx = lonToX(r.lon);
        const cy = latToY(r.lat);
        const status = regionDot(r);
        const fill =
          status === "ok" ? "#7feb9b" : status === "warn" ? "#f3c761" : "#ff665e";
        const selected = r.id === selectedId;
        return (
          <g
            key={r.id}
            className="region-pt"
            transform={`translate(${cx} ${cy})`}
            onClick={() => onSelect(r.id)}
          >
            {selected && (
              <circle r="11" fill="none" stroke="#68ddff" strokeWidth="1.2" opacity="0.9">
                <animate attributeName="r" values="9;13;9" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
            <circle className="pt-halo" r="7" fill={fill} />
            <circle r="3.4" fill={fill} stroke="#03111d" strokeWidth="1" />
            <text
              x="7"
              y="3"
              fill={selected ? "#e6f5fb" : "#9fc2d4"}
              fontSize="9"
              fontFamily="Inter, sans-serif"
            >
              {r.region}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- detail panel ----
function DetailPanel({ record }) {
  if (!record) {
    return (
      <div className="detail-empty">
        <Info size={22} />
        <span>选择左侧任一航母活动区域，查看甲板风判定计算细节。</span>
      </div>
    );
  }

  const { lo, hi } = record.achievableRange;
  const W = record.windSpeedKt;
  const noC = record.conditions.noCatapult;
  const safe = record.conditions.safeRecovery;

  return (
    <div className="detail-body">
      <div className="detail-section">
        <h4>
          <Compass size={14} />
          {record.region} · {record.carrier}
        </h4>
        <div className="value-line">
          <span>
            <span className="vk">坐标：</span>
            <span className="vv">
              {record.lat.toFixed(1)}°N, {record.lon.toFixed(1)}°E
            </span>
          </span>
          <span>
            <span className="vk">10 米风速 W：</span>
            <span className="vv">{W.toFixed(1)} 节</span>
          </span>
          <span>
            <span className="vk">风向：</span>
            <span className="vv">
              {fmtDir(record.windFromDeg)}（{record.windFromCardinal}风）
            </span>
          </span>
        </div>
        <div className="value-line" style={{ marginTop: 6 }}>
          <span>
            <span className="vk">航母最大航速：</span>
            <span className="vv">{CARRIER_MAX_SPEED_KT} 节</span>
            <span className="tag customer">客户口径</span>
          </span>
          <span>
            <span className="vk">甲板风最小值：</span>
            <span className="vv">{DECK_WIND_MIN_KT} 节</span>
            <span className="tag customer">客户口径</span>
          </span>
        </div>
      </div>

      <div className="detail-section">
        <h4>
          <Gauge size={14} />
          可实现甲板风范围
        </h4>
        <div className="calc-block">
          <div className="rule-text">
            航母以最大航速 <b>{CARRIER_MAX_SPEED_KT} 节</b>
            <span className="tag customer">客户口径</span> 选择航向自合成甲板风：
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            <span className="formula">lo = |W − {CARRIER_MAX_SPEED_KT}|</span>
            <span style={{ margin: "0 6px" }}>→</span>
            <b>{lo.toFixed(1)}</b> 节
          </div>
          <div className="rule-text">
            <span className="formula">hi = W + {CARRIER_MAX_SPEED_KT}</span>
            <span style={{ margin: "0 6px" }}>→</span>
            <b>{hi.toFixed(1)}</b> 节
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            代入 W = <b>{W.toFixed(1)}</b> 节 → 可实现范围
            <b style={{ color: "#7feb9b" }}>
              {" "}[{lo.toFixed(1)} , {hi.toFixed(1)}] 节
            </b>
            <span className="tag customer">客户口径</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h4>
          <Plane size={14} />
          条件一：无弹射器辅助
        </h4>
        <div className="calc-block">
          <div className="cb-head">
            <span className="cb-title">判定结果</span>
            <span className={`verdict ${noC.status}`}>{STATUS_TEXT[noC.status]}</span>
            <span className="tag demo">演示分级·待客户确认</span>
          </div>
          <div className="rule-text">
            无弹射器助推时，由航母航速叠加 10 米自然风自合成甲板风，按可实现范围
            <b> [{lo.toFixed(1)} , {hi.toFixed(1)}] 节</b>
            <span className="tag customer">客户口径</span> 与最小值
            <b> {DECK_WIND_MIN_KT} 节</b>
            <span className="tag customer">客户口径</span> 的关系分级：
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            满足：lo ≥ <b>{DECK_WIND_MIN_KT}</b>（任意航向甲板风均达标）｜
            临界：lo &lt; {DECK_WIND_MIN_KT} ≤ hi（顶风航行可达 {DECK_WIND_MIN_KT}）｜
            不满足：hi &lt; {DECK_WIND_MIN_KT}（无法达到）
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            代入 lo = <b>{lo.toFixed(1)}</b>，hi = <b>{hi.toFixed(1)}</b> → {STATUS_TEXT[noC.status]}
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h4>
          <PlaneLanding size={14} />
          条件二：安全着舰
        </h4>
        <div className="calc-block">
          <div className="cb-head">
            <span className="cb-title">判定结果</span>
            <span className={`verdict ${safe.status}`}>{STATUS_TEXT[safe.status]}</span>
            <span className="tag demo">演示分级·待客户确认</span>
          </div>
          <div className="rule-text">
            着舰时同样由航母航速叠加自然风维持甲板风，按可实现范围
            <b> [{lo.toFixed(1)} , {hi.toFixed(1)}] 节</b>
            <span className="tag customer">客户口径</span> 与最小值
            <b> {DECK_WIND_MIN_KT} 节</b>
            <span className="tag customer">客户口径</span> 的关系分级（与条件一同一依据）：
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            满足：lo ≥ <b>{DECK_WIND_MIN_KT}</b>｜
            临界：lo &lt; {DECK_WIND_MIN_KT} ≤ hi｜
            不满足：hi &lt; {DECK_WIND_MIN_KT}
          </div>
          <div className="rule-text" style={{ marginTop: 6 }}>
            代入 lo = <b>{lo.toFixed(1)}</b>，hi = <b>{hi.toFixed(1)}</b> → {STATUS_TEXT[safe.status]}
          </div>
        </div>
      </div>

      <div className="rule-text" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
        说明：<span className="tag customer">客户口径</span> 标注来自客户确认的参数
        （{DECK_WIND_MIN_KT} 节最小值、{CARRIER_MAX_SPEED_KT} 节航速、可实现范围 [|W−{CARRIER_MAX_SPEED_KT}|, W+{CARRIER_MAX_SPEED_KT}]）；
        <span className="tag demo">演示分级·待客户确认</span> 标注为基于上述客户参数派生的演示状态分层，
        非客户提供的运营判定，实际部署以客户最终确认为准。
      </div>
    </div>
  );
}

// ---- main app ----
export function App() {
  const [tick, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState("western-pacific");
  const timerRef = useRef(null);

  useEffect(() => {
    timerRef.current = setInterval(() => setTick((t) => t + 1), DEMO_TICK_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const snapshot = useMemo(() => getSnapshot(tick, new Date()), [tick]);
  const selected =
    snapshot.regions.find((r) => r.id === selectedId) || snapshot.regions[0];

  // range bar scale: 0..110 kt
  const RANGE_MAX = 110;
  function pct(v) {
    return `${Math.min(100, Math.max(0, (v / RANGE_MAX) * 100))}%`;
  }

  return (
    <div className="dwc-shell">
      {/* Top bar */}
      <header className="top-bar">
        <div className="top-title">
          <span className="title-mark" />
          <Wind size={20} />
          甲板风实时计算器
        </div>
        <div className="top-source">
          <span>源：{DATA_SOURCE_NAME}</span>
          <span className="mock-badge">MOCK / 演示数据</span>
        </div>
        <div className="top-status">
          <span className="status-item">
            <RefreshCw size={13} />
            最近更新 {fmtTime(snapshot.snapshotAt)}
          </span>
          <span className="cadence-pill">
            <RefreshCw size={12} />
            {REFRESH_CADENCE}
          </span>
        </div>
      </header>

      {/* KPI strip */}
      <section className="kpi-strip">
        <div className="kpi-cell">
          <div className="kpi-label">监控活动区域</div>
          <div className="kpi-value">
            {snapshot.regionCount}
            <span className="kpi-unit">个</span>
          </div>
          <div className="kpi-sub">全球航母活动区域</div>
        </div>
        <div className="kpi-cell customer">
          <div className="kpi-label">航母最大航速</div>
          <div className="kpi-value">
            {CARRIER_MAX_SPEED_KT}
            <span className="kpi-unit">节</span>
          </div>
          <div className="kpi-sub">用于自合成甲板风</div>
        </div>
        <div className="kpi-cell customer">
          <div className="kpi-label">甲板风最小值</div>
          <div className="kpi-value">
            {DECK_WIND_MIN_KT}
            <span className="kpi-unit">节</span>
          </div>
          <div className="kpi-sub">舰载机起降要求</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-label">可“无弹射器辅助”</div>
          <div className="kpi-value" style={{ color: "var(--green)" }}>
            {snapshot.summary.noCatapultOk}
            <span className="kpi-unit">/ {snapshot.regionCount}</span>
          </div>
          <div className="kpi-sub">范围达 20 节</div>
        </div>
        <div className="kpi-cell">
          <div className="kpi-label">可“安全着舰”</div>
          <div className="kpi-value" style={{ color: "var(--green)" }}>
            {snapshot.summary.safeRecoveryOk}
            <span className="kpi-unit">/ {snapshot.regionCount}</span>
          </div>
          <div className="kpi-sub">范围达 20 节</div>
        </div>
      </section>

      {/* Body */}
      <main className="body-grid">
        {/* Region list */}
        <section className="panel">
          <div className="panel-head">
            <span className="ph-title">
              <Anchor size={14} />
              航母活动区域
            </span>
            <span className="ph-meta">10 米风场 · 可实现范围 · 双条件判定</span>
          </div>
          <div className="panel-body">
            <div className="list-header">
              <span />
              <span>区域 / 航母</span>
              <span className="lh-w">10 米风</span>
              <span className="lh-d">风向</span>
              <span>可实现范围 (节)</span>
              <span style={{ textAlign: "center" }}>无弹射器辅助</span>
              <span style={{ textAlign: "center" }}>安全着舰</span>
            </div>
            <div className="region-list">
              {snapshot.regions.map((r) => {
                const dot = regionDot(r);
                const { lo, hi } = r.achievableRange;
                return (
                  <div
                    key={r.id}
                    className={`region-row ${r.id === selectedId ? "selected" : ""}`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <span className={`dot ${dot}`} />
                    <div className="region-name">
                      <span className="rn-region">{r.region}</span>
                      <span className="rn-carrier">{r.carrier}</span>
                    </div>
                    <div className="cell-wind">
                      {r.windSpeedKt.toFixed(0)}
                      <span className="u"> 节</span>
                    </div>
                    <div className="cell-dir">
                      {r.windFromCardinal}风
                      <br />
                      {fmtDir(r.windFromDeg)}
                    </div>
                    <div className="cell-range">
                      <span style={{ minWidth: 64 }}>
                        [{lo.toFixed(0)} , {hi.toFixed(0)}]
                      </span>
                      <span className="range-bar">
                        <span
                          className="range-fill"
                          style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }}
                        />
                        <span
                          className="threshold-mark"
                          style={{ left: pct(DECK_WIND_MIN_KT) }}
                          title="甲板风最小值 20 节"
                        />
                      </span>
                    </div>
                    <span className={`verdict ${r.conditions.noCatapult.status}`}>
                      {STATUS_TEXT[r.conditions.noCatapult.status]}
                    </span>
                    <span className={`verdict ${r.conditions.safeRecovery.status}`}>
                      {STATUS_TEXT[r.conditions.safeRecovery.status]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Sea-area map */}
        <section className="panel">
          <div className="panel-head">
            <span className="ph-title">
              <Compass size={14} />
              海区点位图
            </span>
            <span className="ph-meta">点颜色 = 双条件综合状态（满足/临界/不满足）</span>
          </div>
          <div className="map-wrap">
            <SeaAreaMap
              regions={snapshot.regions}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </section>

        {/* Detail panel */}
        <section className="panel">
          <div className="panel-head">
            <span className="ph-title">
              <Info size={14} />
              甲板风判定详情
            </span>
            <span className="ph-meta">{selected ? selected.region : ""}</span>
          </div>
          <div className="panel-body">
            <DetailPanel record={selected} />
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
