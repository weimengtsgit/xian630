import { useEffect, useMemo, useState } from "react";
import { Radio, Ship, AlertTriangle, Activity, Clock, Layers } from "lucide-react";
import {
  initialSnapshot,
  tickSnapshot,
  computeStatus,
  SOURCE_NAME,
  REFRESH_CADENCE,
  GRID_SIZE_NM,
  YELLOW_RATIO,
  RED_RATIO,
  DEMO_TICK_MS,
} from "../data/mock.js";

const STATUS_ORDER = { red: 0, yellow: 1, green: 2 };
const STATUS_LABEL = { red: "红灯", yellow: "黄灯", green: "绿灯" };

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Inline SVG sparkline: count curve + baseline reference line.
function Sparkline({ history, baseline, statusLevel }) {
  const w = 200;
  const h = 46;
  const padX = 2;
  const padY = 4;
  const color =
    statusLevel === "red"
      ? "#ff665e"
      : statusLevel === "yellow"
        ? "#f3c761"
        : "#7feb9b";

  const data = history && history.length ? history : [0];
  const max = Math.max(baseline, ...data, 1);
  const min = 0;
  const span = max - min || 1;
  const stepX = (w - padX * 2) / Math.max(1, data.length - 1);
  const y = (v) => h - padY - ((v - min) / span) * (h - padY * 2);
  const x = (i) => padX + i * stepX;

  const linePath = data
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const areaPath =
    `M${x(0).toFixed(1)},${(h - padY).toFixed(1)} ` +
    data.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") +
    ` L${x(data.length - 1).toFixed(1)},${(h - padY).toFixed(1)} Z`;

  const baseY = y(baseline);
  const lastY = y(data[data.length - 1]);
  const lastX = x(data.length - 1);

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="近 30 个采样点商船数量曲线"
    >
      <defs>
        <linearGradient id={`fill-${statusLevel}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* 30-day baseline reference line (dashed amber) */}
      <line
        x1={padX}
        y1={baseY}
        x2={w - padX}
        y2={baseY}
        stroke="#f3c761"
        strokeWidth="1"
        strokeDasharray="3 3"
        opacity="0.85"
      />
      <path d={areaPath} fill={`url(#fill-${statusLevel})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="2.4" fill={color} />
    </svg>
  );
}

function Cell({ cell, selected, onSelect }) {
  const status = computeStatus(cell);
  const ratioPct = (status.ratio * 100).toFixed(0);
  return (
    <button
      type="button"
      className={`cell status-${status.level}${selected ? " selected" : ""}`}
      onClick={() => onSelect(cell.id)}
    >
      <div className="cell-head">
        <span className="cell-id" title={cell.id}>
          {cell.id}
        </span>
        <span className={`status-tag ${status.level}`}>
          {STATUS_LABEL[status.level]}
        </span>
      </div>
      <Sparkline
        history={cell.history}
        baseline={cell.baseline30d}
        statusLevel={status.level}
      />
      <div className="cell-foot">
        <div className="field">
          <span className="lbl">当前商船</span>
          <span className="val">{cell.currentCount}</span>
        </div>
        <div className="field">
          <span className="lbl">30天均值</span>
          <span className="val">{cell.baseline30d}</span>
        </div>
        <div className="field ratio">
          <span className="lbl">占比</span>
          <span className={`val ${status.level}`}>{ratioPct}%</span>
        </div>
      </div>
    </button>
  );
}

function DetailPanel({ cell }) {
  if (!cell) {
    return (
      <div className="detail-empty">点击任一网格或告警查看状态判定详情</div>
    );
  }
  const status = computeStatus(cell);
  const ratioPct = (status.ratio * 100).toFixed(1);
  const yellowThreshold = Math.round(cell.baseline30d * YELLOW_RATIO);
  const redThreshold = Math.round(cell.baseline30d * RED_RATIO);

  let verdict;
  if (status.level === "red") {
    verdict = `当前 ${cell.currentCount} < 基准 50%（${redThreshold}）→ 红灯：商船数量锐减，告警`;
  } else if (status.level === "yellow") {
    verdict = `当前 ${cell.currentCount} 低于基准 70%（${yellowThreshold}）→ 黄灯：密度异常偏低`;
  } else {
    verdict = `当前 ${cell.currentCount} ≥ 基准 70%（${yellowThreshold}）→ 绿灯：密度正常或略高`;
  }

  return (
    <div className="detail-body">
      <div className="detail-title">
        <strong>{cell.id}</strong>
        <span className={`status-tag ${status.level}`}>
          {STATUS_LABEL[status.level]}
        </span>
      </div>
      <div className="detail-grid">
        <div className="field">
          <div className="lbl">海域坐标</div>
          <div className="val" style={{ fontSize: 12 }}>
            {cell.lat.toFixed(2)}°, {cell.lon.toFixed(2)}°
          </div>
        </div>
        <div className="field">
          <div className="lbl">网格边长</div>
          <div className="val">{cell.sizeNm} 海里</div>
        </div>
        <div className="field">
          <div className="lbl">当前商船数量</div>
          <div className="val">{cell.currentCount}</div>
        </div>
        <div className="field">
          <div className="lbl">30 天滑动平均</div>
          <div className="val">{cell.baseline30d}</div>
        </div>
        <div className="field">
          <div className="lbl">当前占比</div>
          <div className="val">{ratioPct}%</div>
        </div>
        <div className="field">
          <div className="lbl">黄/红阈值</div>
          <div className="val" style={{ fontSize: 12 }}>
            {yellowThreshold} / {redThreshold}
          </div>
        </div>
      </div>
      <div className="detail-calc">
        <div>
          基准线 = 过去 <b>30 天</b> 同一海域平均商船数量（滑动平均）。
        </div>
        <div className="formula" style={{ margin: "6px 0" }}>
          ratio = {cell.currentCount} / {cell.baseline30d} ={" "}
          {(status.ratio).toFixed(3)}
        </div>
        <div>
          规则：ratio ≥ {YELLOW_RATIO}（绿） · {RED_RATIO} ≤ ratio &lt;{" "}
          {YELLOW_RATIO}（黄） · ratio &lt; {RED_RATIO}（红）
        </div>
        <div className={`verdict ${status.level}`} style={{ marginTop: 8 }}>
          判定：{verdict}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(() => initialSnapshot());
  const [selectedId, setSelectedId] = useState(() => {
    const firstRed = initialSnapshot().cells
      .map((c) => ({ c, s: computeStatus(c) }))
      .find(({ s }) => s.level === "red");
    return firstRed ? firstRed.c.id : null;
  });

  // local demo tick: advances mock state while the UI keeps showing the real
  // "每 3 分钟刷新一次" cadence.
  useEffect(() => {
    const id = setInterval(() => {
      setSnapshot((prev) => tickSnapshot(prev));
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const cells = snapshot.cells;
  const zones = useMemo(() => {
    const map = new Map();
    for (const c of cells) {
      if (!map.has(c.zone)) map.set(c.zone, []);
      map.get(c.zone).push(c);
    }
    return Array.from(map.entries()).map(([zone, list]) => ({
      zone,
      list: list.sort(
        (a, b) => a.row - b.row || a.col - b.col
      ),
    }));
  }, [cells]);

  const counts = useMemo(() => {
    let red = 0,
      yellow = 0,
      green = 0;
    for (const c of cells) {
      const s = computeStatus(c);
      if (s.level === "red") red++;
      else if (s.level === "yellow") yellow++;
      else green++;
    }
    return { red, yellow, green, total: cells.length };
  }, [cells]);

  const alerts = useMemo(() => {
    return cells
      .map((c) => ({ cell: c, status: computeStatus(c) }))
      .sort((a, b) => {
        const so = STATUS_ORDER[a.status.level] - STATUS_ORDER[b.status.level];
        if (so !== 0) return so;
        return a.status.ratio - b.status.ratio; // lower ratio first within same status
      });
  }, [cells]);

  const selectedCell = cells.find((c) => c.id === selectedId) || null;

  return (
    <div className="density-shell">
      {/* ---------- top bar ---------- */}
      <header className="top-bar">
        <div className="title-block">
          <Ship size={20} color="#68ddff" />
          <div>
            <h1>海域网格商船密度异常告警器</h1>
            <div className="sub">
              美在外活动航母区域 · {GRID_SIZE_NM} 海里网格 · 30 天滑动平均基准
            </div>
          </div>
        </div>
        <div className="source-block">
          <span className="mock-badge">
            <Radio size={12} /> mock / 演示数据
          </span>
          <span style={{ color: "#bcd6e1", fontSize: 12 }}>
            源：{SOURCE_NAME}
          </span>
        </div>
        <div className="meta-block">
          <span className="refresh-pill">
            <Clock size={12} />
            最近刷新：{fmtTime(snapshot.fetchedAt)}
          </span>
          <span className="refresh-pill" style={{ borderColor: "rgba(127,235,155,0.4)" }}>
            <Activity size={12} color="#7feb9b" />
            {REFRESH_CADENCE}
          </span>
        </div>
      </header>

      {/* ---------- kpi strip ---------- */}
      <div className="kpi-strip">
        <div className="kpi-card">
          <span className="k">监控网格</span>
          <span className="v">{counts.total}</span>
        </div>
        <div className="kpi-card red">
          <span className="k">红灯（&lt;50%）</span>
          <span className="v">{counts.red}</span>
        </div>
        <div className="kpi-card yellow">
          <span className="k">黄灯（&lt;70%）</span>
          <span className="v">{counts.yellow}</span>
        </div>
        <div className="kpi-card green">
          <span className="k">绿灯（≥70%）</span>
          <span className="v">{counts.green}</span>
        </div>
        <div className="rule-note">
          基准 = <b>30 天滑动平均</b> ·{" "}
          <b style={{ color: "var(--amber)" }}>低于 70% → 黄灯</b> ·{" "}
          <b style={{ color: "var(--red)" }}>低于 50% → 红灯</b> · 正常或略高保持绿灯
        </div>
      </div>

      {/* ---------- main ---------- */}
      <div className="main-grid">
        <div className="board-area">
          {zones.map(({ zone, list }) => {
            // infer cols from max col index for grid template
            const maxCol = list.reduce((m, c) => Math.max(m, c.col), 0);
            const cols = maxCol + 1;
            return (
              <section className="zone-block" key={zone}>
                <header>
                  <h2>
                    <Layers size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {zone}
                  </h2>
                  <span className="zone-meta">
                    {list.length} 个 {GRID_SIZE_NM} 海里网格
                  </span>
                </header>
                <div
                  className="grid-matrix"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  }}
                >
                  {list.map((cell) => (
                    <Cell
                      key={cell.id}
                      cell={cell}
                      selected={cell.id === selectedId}
                      onSelect={setSelectedId}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="side-panel">
          {/* alert list */}
          <div className="panel-section alerts">
            <div className="section-header">
              <h3>
                <AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                告警列表
              </h3>
              <span className="count">按 红 → 黄 → 绿 排序</span>
            </div>
            <div className="alert-list">
              {alerts.map(({ cell, status }) => (
                <button
                  type="button"
                  key={cell.id}
                  className={`alert-row ${status.level}${
                    cell.id === selectedId ? " selected" : ""
                  }`}
                  onClick={() => setSelectedId(cell.id)}
                >
                  <span className="a-id">{cell.id}</span>
                  <span className="a-body">
                    <span className="a-zone">{cell.zone}</span>
                    <span className="a-rule">
                      {cell.currentCount} / 基准 {cell.baseline30d}
                      {status.level === "red" && " · 低于 50%"}
                      {status.level === "yellow" && " · 低于 70%"}
                      {status.level === "green" && " · 正常"}
                    </span>
                  </span>
                  <span className="a-ratio">{(status.ratio * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
          </div>

          {/* detail panel */}
          <div className="panel-section detail">
            <div className="section-header">
              <h3>状态判定详情</h3>
              {selectedCell && (
                <span className="count">{selectedCell.id}</span>
              )}
            </div>
            <DetailPanel cell={selectedCell} />
          </div>
        </aside>
      </div>

      {/* ---------- legend ---------- */}
      <div className="legend">
        <span style={{ color: "#8fb0bf" }}>
          数量曲线 = 近 30 个采样点商船数量；虚线 = 30 天滑动平均基准
        </span>
        <span className="item green">
          <span className="swatch" /> 绿灯 正常（ratio ≥ {YELLOW_RATIO}）
        </span>
        <span className="item yellow">
          <span className="swatch" /> 黄灯 偏低（{RED_RATIO} ≤ ratio &lt; {YELLOW_RATIO}）
        </span>
        <span className="item red">
          <span className="swatch" /> 红灯 锐减（ratio &lt; {RED_RATIO}）
        </span>
      </div>
    </div>
  );
}
