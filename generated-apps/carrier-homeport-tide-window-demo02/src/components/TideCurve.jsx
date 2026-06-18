import React from "react";
import { minToClock } from "../data/mock.js";

// 72h inline SVG tide curve with the 12.8m threshold line, open segments
// highlighted green, closed segments muted, and a "now" marker.
//
// Props: port (feed), status (live status at nowOffset), epoch (Date), nowOffset (min).
export default function TideCurve({ port, status, epoch, nowOffset }) {
  const W = 100;
  const H = 100;
  const PAD_X = 2;
  const PAD_TOP = 10;
  const PAD_BOT = 14;

  const horizon = 72 * 60; // min
  const series = port.series;
  const heights = series.map((s) => s.height);
  const minH = Math.min(...heights) - 0.05;
  const maxH = Math.max(...heights) + 0.05;
  // clamp threshold inside range for y mapping
  const thr = port.threshold;

  const x = (min) => PAD_X + ((min / horizon) * (W - 2 * PAD_X));
  const y = (h) =>
    PAD_TOP + (1 - (h - minH) / (maxH - minH)) * (H - PAD_TOP - PAD_BOT);

  // Build path split into open/closed runs so we can color them.
  const openSegs = []; // { d: "M..L.." }
  const closedSegs = [];
  let cur = null;
  let curOpen = false;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const isOpen = s.height >= thr;
    if (i === 0) {
      cur = `M${x(s.t).toFixed(2)} ${y(s.height).toFixed(2)}`;
      curOpen = isOpen;
    } else {
      if (isOpen !== curOpen) {
        // close current run at this point to make segments contiguous
        (curOpen ? openSegs : closedSegs).push(cur);
        cur = `M${x(series[i - 1].t).toFixed(2)} ${y(series[i - 1].height).toFixed(2)} L${x(s.t).toFixed(2)} ${y(s.height).toFixed(2)}`;
        curOpen = isOpen;
      } else {
        cur += ` L${x(s.t).toFixed(2)} ${y(s.height).toFixed(2)}`;
      }
    }
  }
  if (cur) (curOpen ? openSegs : closedSegs).push(cur);

  // area under curve for open segments (down to threshold line) for highlight
  const thrY = y(thr);
  const openAreas = [];
  let aRun = null;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const isOpen = s.height >= thr;
    if (isOpen && !aRun) {
      aRun = { from: i, pts: [s] };
    } else if (isOpen && aRun) {
      aRun.pts.push(s);
    }
    if (!isOpen && aRun) {
      openAreas.push(aRun);
      aRun = null;
    }
  }
  if (aRun) openAreas.push(aRun);

  const areaPath = (run) => {
    const first = run.pts[0];
    const last = run.pts[run.pts.length - 1];
    let d = `M${x(first.t).toFixed(2)} ${thrY.toFixed(2)}`;
    run.pts.forEach((p) => {
      d += ` L${x(p.t).toFixed(2)} ${y(p.height).toFixed(2)}`;
    });
    d += ` L${x(last.t).toFixed(2)} ${thrY.toFixed(2)} Z`;
    return d;
  };

  const nowX = x(nowOffset);
  const curY = y(status.currentHeight);

  // x-axis ticks: now, +24h, +48h, +72h
  const ticks = [0, 24 * 60, 48 * 60, 72 * 60];

  return (
    <div className="tide-curve-wrap">
      <svg className="tide-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {/* horizontal gridlines */}
        <line className="grid" x1={PAD_X} y1={y(maxH)} x2={W - PAD_X} y2={y(maxH)} />
        <line className="grid" x1={PAD_X} y1={y(minH)} x2={W - PAD_X} y2={y(minH)} />

        {/* open-area highlight (green, above threshold) */}
        {openAreas.map((run, i) => (
          <path key={`a${i}`} className="area-open" d={areaPath(run)} />
        ))}

        {/* closed-area tint below threshold */}
        <rect
          className="area-closed"
          x={PAD_X}
          y={thrY}
          width={W - 2 * PAD_X}
          height={Math.max(0, y(minH) - thrY)}
        />

        {/* tide curve: closed (muted) then open (green) on top */}
        {closedSegs.map((d, i) => (
          <path key={`c${i}`} className="line-closed" d={d} />
        ))}
        {openSegs.map((d, i) => (
          <path key={`o${i}`} className="line-open" d={d} />
        ))}

        {/* threshold line (12.8 m) */}
        <line
          className="threshold"
          x1={PAD_X}
          y1={thrY}
          x2={W - PAD_X}
          y2={thrY}
        />
        <text className="threshold-label" x={W - PAD_X} y={Math.max(PAD_TOP + 4, thrY - 1.5)} textAnchor="end">
          阈值 {thr.toFixed(1)} m
        </text>

        {/* now marker */}
        <line className="now-line" x1={nowX} y1={PAD_TOP} x2={nowX} y2={H - PAD_BOT} />
        <circle className="now-dot" cx={nowX} cy={curY} r={1.6} />

        {/* x ticks */}
        {ticks.map((tmin, i) => (
          <g key={i}>
            <line
              className="grid"
              x1={x(tmin)}
              y1={H - PAD_BOT}
              x2={x(tmin)}
              y2={H - PAD_BOT + 1.5}
            />
            <text
              className="axis-label"
              x={x(tmin)}
              y={H - PAD_BOT + 6}
              textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
            >
              {i === 0 ? "现在" : `+${tmin / 60}h`}
            </text>
          </g>
        ))}

        {/* next/active window label marker on the curve */}
        {status.activeWindow && (
          <text
            className="win-label"
            x={x((status.activeWindow.startMin + status.activeWindow.endMin) / 2)}
            y={Math.max(PAD_TOP + 2, y(status.activeWindow.peakHeight) - 2)}
            textAnchor="middle"
          >
            可出港
          </text>
        )}
      </svg>
    </div>
  );
}
