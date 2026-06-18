// Mock / demo tide provider for 航母母港潮汐窗口计算器.
//
// Data here is MOCK / DEMO. It is deterministic and shaped to look like the
// payload a future public tide-prediction API would return, so a real adapter
// can later replace `buildPortFeed` without touching the UI contract.
//
// Contract (per port):
//   {
//     port,            // stable id, e.g. "norfolk"
//     nameZh,          // 诺福克
//     nameEn,          // Norfolk
//     tzLabel,         // human tz hint for display
//     threshold,       // 12.8 (m) — carrier draft threshold, verbatim 客户口径
//     series: [{ t, height }],  // 72h, t = minutes from now at generation, height in m
//     windows: [{ startMin, endMin, peakMin, peakHeight }], // contiguous height>=threshold
//   }
//
// The UI never calls fetch; the demo tick in App.jsx advances an effective
// "now offset" along the series so last-refresh, current height, windows and
// the countdown all visibly change while the board still shows "每 10 分钟刷新一次".

export const REFRESH_CADENCE_LABEL = "每 10 分钟刷新一次";

export const THRESHOLD = 12.8; // m — 航母吃水阈值 (verbatim)
const HORIZON_HOURS = 72;
const STEP_MIN = 10; // tide sample every 10 min -> 72h = 432 samples

// Per-port baselines so the 4 ports differ and produce a mix of OPEN/CLOSED.
// `base` = mean tide (m), `amp` = tidal amplitude (m), `period` = dominant
// tidal period in minutes (M2 ~ 745 min; we vary so curves visibly differ),
// `phase` = phase offset in minutes at the demo epoch.
const PORT_PARAMS = [
  {
    port: "norfolk",
    nameZh: "诺福克",
    nameEn: "Norfolk",
    tzLabel: "UTC-5",
    base: 12.95,
    amp: 0.55,
    period: 745,
    phase: 0,
  },
  {
    port: "sandiego",
    nameZh: "圣迭戈",
    nameEn: "San Diego",
    tzLabel: "UTC-8",
    base: 12.55,
    amp: 0.45,
    period: 780,
    phase: 210,
  },
  {
    port: "bremerton",
    nameZh: "布雷默顿",
    nameEn: "Bremerton",
    tzLabel: "UTC-8",
    base: 13.15,
    amp: 0.6,
    period: 720,
    phase: 480,
  },
  {
    port: "yokosuka",
    nameZh: "横须贺",
    nameEn: "Yokosuka",
    tzLabel: "UTC+9",
    base: 12.7,
    amp: 0.5,
    period: 760,
    phase: 340,
  },
];

// Build a single port's deterministic 72h tide series.
function buildSeries(p) {
  const series = [];
  const total = Math.round((HORIZON_HOURS * 60) / STEP_MIN);
  for (let i = 0; i <= total; i++) {
    const min = i * STEP_MIN;
    // Compound two harmonics so the curve looks tidal (not a pure sine).
    const h =
      p.base +
      p.amp * Math.cos((2 * Math.PI * (min + p.phase)) / p.period) +
      p.amp * 0.32 * Math.cos((2 * Math.PI * (min + p.phase)) / (p.period / 2));
    series.push({ t: min, height: Number(h.toFixed(2)) });
  }
  return series;
}

// Compute contiguous departure windows (可出港时间窗) where height >= threshold.
function computeWindows(series, threshold) {
  const windows = [];
  let cur = null;
  for (let i = 0; i < series.length; i++) {
    const pt = series[i];
    const open = pt.height >= threshold;
    if (open && !cur) {
      cur = { startMin: pt.t, startIdx: i, peakHeight: pt.height, peakMin: pt.t };
    }
    if (open && cur) {
      if (pt.height > cur.peakHeight) {
        cur.peakHeight = pt.height;
        cur.peakMin = pt.t;
      }
    }
    if (!open && cur) {
      // window closed at previous sample; end at previous t
      cur.endMin = series[i - 1].t;
      cur.endIdx = i - 1;
      windows.push({ startMin: cur.startMin, endMin: cur.endMin, peakMin: cur.peakMin, peakHeight: Number(cur.peakHeight.toFixed(2)) });
      cur = null;
    }
  }
  if (cur) {
    // window still open at end of horizon
    cur.endMin = series[series.length - 1].t;
    windows.push({ startMin: cur.startMin, endMin: cur.endMin, peakMin: cur.peakMin, peakHeight: Number(cur.peakHeight.toFixed(2)) });
  }
  return windows;
}

// Build all four feeds. Memoised at module load (deterministic).
const PORTS = PORT_PARAMS.map((p) => {
  const series = buildSeries(p);
  const windows = computeWindows(series, THRESHOLD);
  return {
    port: p.port,
    nameZh: p.nameZh,
    nameEn: p.nameEn,
    tzLabel: p.tzLabel,
    threshold: THRESHOLD,
    series,
    windows,
  };
});

export function getPorts() {
  return PORTS;
}

export function getPort(id) {
  return PORTS.find((p) => p.port === id);
}

// Derive the live status of a port at a given effective "now" offset (minutes
// since the demo epoch). The demo tick advances nowOffset; the real cadence is
// still shown verbatim in the top bar.
//
// Returns:
//   {
//     currentHeight,            // m at nowOffset
//     isOpen,                   // height >= threshold
//     margin,                   // currentHeight - threshold (signed, m)
//     activeWindow | null,      // window covering nowOffset (if open)
//     nextWindow  | null,       // first window with startMin > nowOffset (if closed)
//     countdown: { kind: 'open'|'close'|'open_next', seconds },
//     windowCount,              // total departure windows in next 72h
//   }
export function getStatus(port, nowOffsetMin) {
  // find current height by interpolating the nearest samples
  const idxF = nowOffsetMin / STEP_MIN;
  const i0 = Math.max(0, Math.min(port.series.length - 1, Math.floor(idxF)));
  const i1 = Math.min(port.series.length - 1, i0 + 1);
  const frac = idxF - i0;
  const currentHeight = Number(
    (port.series[i0].height + (port.series[i1].height - port.series[i0].height) * frac).toFixed(2)
  );
  const isOpen = currentHeight >= port.threshold;

  const activeWindow = port.windows.find((w) => nowOffsetMin >= w.startMin && nowOffsetMin <= w.endMin) || null;
  const nextWindow =
    port.windows.find((w) => w.startMin > nowOffsetMin) || port.windows[0] || null;

  let countdown;
  const secPerMin = 60;
  if (activeWindow) {
    // open -> countdown to window close
    countdown = {
      kind: "close",
      seconds: Math.max(0, (activeWindow.endMin - nowOffsetMin) * secPerMin),
    };
  } else if (nextWindow) {
    const target = nextWindow.startMin > nowOffsetMin ? nextWindow.startMin : nextWindow.startMin + 0;
    countdown = {
      kind: "open_next",
      seconds: Math.max(0, (target - nowOffsetMin) * secPerMin),
    };
  } else {
    countdown = { kind: "none", seconds: 0 };
  }

  return {
    currentHeight,
    isOpen,
    margin: Number((currentHeight - port.threshold).toFixed(2)),
    activeWindow,
    nextWindow,
    countdown,
    windowCount: port.windows.length,
  };
}

// Format minutes-from-now into a clock-style HH:MM label offset from a base
// Date (the demo epoch). We render absolute wall-clock-ish times so the board
// feels real, while the underlying value is minutes-from-now.
export function minToClock(baseDate, minOffset) {
  const d = new Date(baseDate.getTime() + minOffset * 60 * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function minToClockWithDay(baseDate, minOffset) {
  const d = new Date(baseDate.getTime() + minOffset * 60 * 1000);
  const day = String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

// Format a countdown (seconds) as H:MM:SS for the live tick display.
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(sec)}`;
}
