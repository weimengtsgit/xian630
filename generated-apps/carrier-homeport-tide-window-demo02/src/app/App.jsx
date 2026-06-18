import React, { useEffect, useMemo, useRef, useState } from "react";
import { Ship, Waves, Clock, RefreshCw, Anchor, Gauge } from "lucide-react";
import {
  getPorts,
  getStatus,
  formatCountdown,
  minToClock,
  minToClockWithDay,
  REFRESH_CADENCE_LABEL,
  THRESHOLD,
} from "../data/mock.js";
import TideCurve from "../components/TideCurve.jsx";

// Local demo tick advances the effective "now" along the 72h series so the
// board visibly changes (current height, countdowns, open/closed transitions,
// last-refresh). The customer cadence string "每 10 分钟刷新一次" is still shown
// verbatim in the top bar — this tick is a demo accelerator, not the real feed.
const DEMO_TICK_MS = 6000; // every 6s
const DEMO_MIN_PER_TICK = 20; // advance 20 min of tide per tick for visible motion

export default function App() {
  const ports = useMemo(() => getPorts(), []);
  const [selectedPort, setSelectedPort] = useState(ports[0].port);
  const epochRef = useRef(new Date());
  const [nowOffsetMin, setNowOffsetMin] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(() => new Date());
  // a stateful counter to force re-render of the live countdown each second
  const [, setTick] = useState(0);

  // demo tick: advance nowOffset and lastRefresh
  useEffect(() => {
    const id = setInterval(() => {
      setNowOffsetMin((prev) => {
        const next = prev + DEMO_MIN_PER_TICK;
        // wrap before we fall off the 72h horizon
        return next >= 72 * 60 - 60 ? 0 : next;
      });
      setLastRefresh(new Date());
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // 1s ticker so countdowns tick smoothly between demo ticks
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const epoch = epochRef.current;

  const statuses = useMemo(
    () => ports.map((p) => ({ port: p, status: getStatus(p, nowOffsetMin) })),
    [ports, nowOffsetMin]
  );

  const openCount = statuses.filter((s) => s.status.isOpen).length;
  const closedCount = statuses.length - openCount;

  const selected = ports.find((p) => p.port === selectedPort);
  const selectedStatus = getStatus(selected, nowOffsetMin);

  const fmtClock = (d) => {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  return (
    <div className="tide-shell">
      {/* ---------- Top bar ---------- */}
      <header className="tide-topbar">
        <div className="tide-title">
          <span className="crest">
            <Ship size={18} />
          </span>
          <div>
            <h1>航母母港潮汐窗口计算器</h1>
            <div className="sub">Carrier Homeport Tide-Window Calculator · 四大母港未来 72 小时可出港窗口</div>
          </div>
        </div>

        <div className="tide-cadence" title="客户配置的刷新频率">
          <RefreshCw size={13} />
          {REFRESH_CADENCE_LABEL}
        </div>

        <div className="tide-source">
          <span className="badge" title="当前为演示数据，结构与未来潮汐 API 适配">
            <Waves size={12} /> 演示潮汐序列 / mock
          </span>
          <span className="item">
            <span className="k">源：</span>
            <span className="v">公开潮汐预测（mock）</span>
          </span>
          <span className="item">
            <Clock size={12} />
            <span className="k">最近刷新：</span>
            <span className="v">{fmtClock(lastRefresh)}</span>
          </span>
        </div>
      </header>

      {/* ---------- KPI strip ---------- */}
      <section className="tide-kpis">
        <div className="tide-kpi">
          <Gauge size={20} color="#68ddff" />
          <div>
            <div className="lbl">监控母港</div>
            <div className="val">{ports.length}</div>
          </div>
        </div>
        <div className="tide-kpi">
          <Anchor size={20} color="#7feb9b" />
          <div>
            <div className="lbl">当前可出港</div>
            <div className="val ok">{openCount}</div>
          </div>
        </div>
        <div className="tide-kpi">
          <Anchor size={20} color="#ff665e" />
          <div>
            <div className="lbl">当前窗口关闭</div>
            <div className="val bad">{closedCount}</div>
          </div>
        </div>
        <div className="tide-kpi">
          <Waves size={20} color="#f3c761" />
          <div>
            <div className="lbl">吃水阈值</div>
            <div className="val">{THRESHOLD.toFixed(1)} m</div>
            <div className="hint">航母出港潮高门槛</div>
          </div>
        </div>
      </section>

      {/* ---------- Main: 2x2 grid + detail ---------- */}
      <main className="tide-main">
        <div className="tide-grid">
          {statuses.map(({ port, status }) => (
            <PortCard
              key={port.port}
              port={port}
              status={status}
              epoch={epoch}
              nowOffset={nowOffsetMin}
              selected={port.port === selectedPort}
              onSelect={() => setSelectedPort(port.port)}
            />
          ))}
        </div>

        <DetailPanel
          port={selected}
          status={selectedStatus}
          epoch={epoch}
          nowOffset={nowOffsetMin}
          onPick={setSelectedPort}
          ports={ports}
        />
      </main>

      <footer className="tide-foot">
        <span>
          口径：抓取诺福克 / 圣迭戈 / 布雷默顿 / 横须贺未来 72h 潮汐 · 吃水阈值 12.8 m · 自动标出可出港时间窗 · {REFRESH_CADENCE_LABEL}
        </span>
        <span>演示 tick 每 {DEMO_TICK_MS / 1000}s 推进 {DEMO_MIN_PER_TICK} 分钟潮汐，便于观察窗口开闭与倒计时变化</span>
      </footer>
    </div>
  );
}

function PortCard({ port, status, epoch, nowOffset, selected, onSelect }) {
  const { isOpen, currentHeight, margin, activeWindow, nextWindow, countdown, windowCount } = status;

  const nextLabel = (() => {
    if (activeWindow) {
      return {
        span: `${minToClock(epoch, activeWindow.startMin)} – ${minToClock(epoch, activeWindow.endMin)}`,
        meta: "当前窗口开放中",
      };
    }
    if (nextWindow) {
      const wrap = nextWindow.startMin <= nowOffset ? "(下一周期)" : "";
      return {
        span: `${minToClockWithDay(epoch, nextWindow.startMin)} – ${minToClock(epoch, nextWindow.endMin)}`,
        meta: `下一个可出港窗口 ${wrap}`,
      };
    }
    return { span: "—", meta: "未来 72h 无满足条件窗口" };
  })();

  const cd = countdown.kind;
  const cdLabel =
    cd === "close"
      ? "距窗口关闭"
      : cd === "open_next"
      ? "距下一窗口开放"
      : "无窗口";

  return (
    <article
      className={`port-card ${isOpen ? "open" : "closed"} ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <div className="port-head">
        <div className="name">
          <span className="zh">{port.nameZh}</span>
          <span className="en">{port.nameEn} · {port.tzLabel}</span>
        </div>
        <span className={`port-status ${isOpen ? "open" : "closed"}`}>
          <span className="dot" />
          {isOpen ? "可出港 · OPEN" : "关闭 · CLOSED"}
        </span>
      </div>

      <div className="port-height">
        <span className="big">{currentHeight.toFixed(2)}</span>
        <span className="unit">m 当前潮高</span>
        <span className="thr">/ 阈值 {port.threshold.toFixed(1)} m</span>
        <span className={margin >= 0 ? "margin-up" : "margin-dn"}>
          ({margin >= 0 ? "+" : ""}{margin.toFixed(2)} m)
        </span>
      </div>

      <TideCurve port={port} status={status} epoch={epoch} nowOffset={nowOffset} />

      <div className="tide-legend">
        <span><i className="open" /> 可出港段 (潮高 ≥ {port.threshold.toFixed(1)} m)</span>
        <span><i className="closed" /> 关闭段</span>
        <span><i className="thr" /> 12.8 m 阈值</span>
      </div>

      <div className="port-countdown">
        <span className="k">{cdLabel}：</span>
        <span className={`v ${isOpen ? "open" : "close"}`}>
          {cd === "none" ? "—" : formatCountdown(countdown.seconds)}
        </span>
      </div>

      <div className="port-nextwin">
        <span className="k">下一窗口起止：</span>
        <span className="v">{nextLabel.span}</span>
        <span className="k">状态：</span>
        <span className="v">{nextLabel.meta}</span>
        <span className="k">未来 72h 窗口数：</span>
        <span className="v">{windowCount}</span>
      </div>
    </article>
  );
}

function DetailPanel({ port, status, epoch, nowOffset, onPick, ports }) {
  const { isOpen, currentHeight, margin, activeWindow, nextWindow, countdown, windowCount } = status;
  const durMin = (w) => (w ? w.endMin - w.startMin : 0);

  return (
    <aside className="tide-detail">
      <div className="ph">
        <span className="t">出港条件研判 · {port.nameZh}</span>
        <div className="pick">
          {ports.map((p) => (
            <button
              key={p.port}
              className={p.port === port.port ? "active" : ""}
              onClick={() => onPick(p.port)}
            >
              {p.nameZh}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="cell">
          <div className="k">当前潮高</div>
          <div className="v">{currentHeight.toFixed(2)} m</div>
        </div>
        <div className="cell">
          <div className="k">吃水阈值</div>
          <div className="v">{port.threshold.toFixed(1)} m</div>
        </div>
        <div className="cell">
          <div className="k">裕量 (当前 − 阈值)</div>
          <div className={`v ${margin >= 0 ? "ok" : "bad"}`}>
            {margin >= 0 ? "+" : ""}{margin.toFixed(2)} m
          </div>
        </div>
        <div className="cell">
          <div className="k">当前窗口</div>
          <div className={`v ${isOpen ? "ok" : "bad"}`}>
            {isOpen ? "开放 (满足)" : "关闭 (不满足)"}
          </div>
        </div>
      </div>

      <div className="calc">
        <div>
          判定规则：<code>当前潮高 ≥ 吃水阈值({port.threshold.toFixed(1)} m)</code> → 可出港。
        </div>
        <div style={{ marginTop: 4 }}>
          代入：<code>{currentHeight.toFixed(2)} m {isOpen ? "≥" : "<"} {port.threshold.toFixed(1)} m</code>
          {" "}→ 当前 <strong>{port.nameZh}</strong>
          {" "}<span className={`verdict ${isOpen ? "ok" : "bad"}`}>{isOpen ? "可出港" : "不可出港"}</span>
        </div>
        <div style={{ marginTop: 6 }}>
          {isOpen
            ? `窗口已于 ${minToClock(epoch, activeWindow.startMin)} 开放，将于 ${minToClock(epoch, activeWindow.endMin)} 关闭，剩余可出港时长 ${formatCountdown(countdown.seconds)}。`
            : nextWindow
            ? `下一个可出港窗口：${minToClockWithDay(epoch, nextWindow.startMin)} – ${minToClock(epoch, nextWindow.endMin)}（持续约 ${durMin(nextWindow)} 分钟），距开放 ${formatCountdown(countdown.seconds)}。`
            : "未来 72 小时内无满足 12.8 m 阈值的可出港窗口。"}
        </div>
      </div>

      <div>
        <div style={{ color: "#7ea4b5", fontSize: 11, marginBottom: 5 }}>
          未来 72h 可出港时间窗（共 {windowCount} 个）
        </div>
        <div className="winlist">
          {port.windows.length === 0 && (
            <div style={{ color: "#8ca7b4", fontSize: 11, padding: "6px 0" }}>无满足条件的窗口</div>
          )}
          {port.windows.map((w, i) => {
            const isCurrent = activeWindow && w.startMin === activeWindow.startMin;
            return (
              <div key={i} className={`winitem ${isCurrent ? "current" : ""}`}>
                <div>
                  <div className="span">
                    {minToClockWithDay(epoch, w.startMin)} – {minToClock(epoch, w.endMin)}
                  </div>
                  <div className="meta">
                    峰值 {w.peakHeight.toFixed(2)} m · 持续 {durMin(w)} min
                  </div>
                </div>
                <div className="dur">{isCurrent ? "进行中" : `+${Math.round((w.startMin - nowOffset) / 60)}h`}</div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
