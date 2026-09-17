// 出港窗口解算（纯函数）：序列插值、阈值交点求解、连续满足段合并、状态判定。
// 输入 series: [{ t: UTC 毫秒, heightM: 米 }]（升序、与阈值同基准）。
// 本文件属于计算层，不含取数逻辑。

export function trimSeries(series, fromMs, toMs) {
  return series.filter((p) => p.t >= fromMs && p.t <= toMs);
}

// 线性插值求时刻 t 的潮高；t 超出序列覆盖范围返回 null。
export function heightAt(series, t) {
  if (!series.length) return null;
  if (t < series[0].t || t > series[series.length - 1].t) return null;
  for (let i = 0; i < series.length - 1; i += 1) {
    const a = series[i];
    const b = series[i + 1];
    if (t >= a.t && t <= b.t) {
      if (b.t === a.t) return a.heightM;
      const r = (t - a.t) / (b.t - a.t);
      return a.heightM + r * (b.heightM - a.heightM);
    }
  }
  return series[series.length - 1].heightM;
}

// 相邻两点间解 heightM(t) = threshold 的交点时刻（线性插值）。
function crossingTime(a, b, threshold) {
  const span = b.heightM - a.heightM;
  if (span === 0) return a.t;
  const r = (threshold - a.heightM) / span;
  return a.t + r * (b.t - a.t);
}

// 计算全部连续满足阈值的窗口；相邻满足段共享端点时自动合并。
// startBounded/endBounded=false 表示窗口起/止落在数据覆盖边界上（实际可能更长）。
export function computeWindows(series, threshold) {
  const windows = [];
  let cur = null;
  const push = (start, end, startBounded, endBounded) => {
    if (cur && start <= cur.endMs + 1) {
      cur.endMs = end;
      cur.endBounded = endBounded;
    } else {
      cur = { startMs: start, endMs: end, startBounded, endBounded };
      windows.push(cur);
    }
  };
  for (let i = 0; i < series.length - 1; i += 1) {
    const a = series[i];
    const b = series[i + 1];
    const aOk = a.heightM >= threshold;
    const bOk = b.heightM >= threshold;
    if (aOk && bOk) {
      push(a.t, b.t, i > 0, true);
    } else if (aOk && !bOk) {
      push(a.t, crossingTime(a, b, threshold), i > 0, true);
    } else if (!aOk && bOk) {
      push(crossingTime(a, b, threshold), b.t, true, true);
    }
  }
  if (series.length) {
    const first = series[0];
    const last = series[series.length - 1];
    if (first.heightM >= threshold && windows.length && windows[0].startMs <= first.t + 1) {
      windows[0].startBounded = false;
    }
    if (last.heightM >= threshold && windows.length
        && windows[windows.length - 1].endMs >= last.t - 1) {
      windows[windows.length - 1].endBounded = false;
    }
  }
  return windows;
}

// 综合评估一个港口：当前潮高、窗口列表、状态与倒计时目标。
// windowState: open（窗口开放，倒计时至关闭）| closed（关闭，倒计时至下一窗口开启）| no_window
export function assessPort({ series, threshold, now, horizonMs }) {
  const current = heightAt(series, now);
  const windows = computeWindows(series, threshold);
  const coverageStartMs = series.length ? series[0].t : null;
  const coverageEndMs = series.length ? series[series.length - 1].t : null;
  const currentWindow = current === null
    ? null
    : (windows.find((w) => now >= w.startMs && now <= w.endMs) || null);
  const upcoming = windows.filter((w) => w.startMs > now);
  const nextWindow = upcoming[0] || null;
  const followingWindow = upcoming[1] || null;

  let windowState = 'no_window';
  let countdownTargetMs = null;
  let countdownKind = null; // 'close' 距窗口关闭 | 'open' 距下一窗口开启
  if (currentWindow) {
    windowState = 'open';
    countdownTargetMs = currentWindow.endMs;
    countdownKind = 'close';
  } else if (nextWindow) {
    windowState = 'closed';
    countdownTargetMs = nextWindow.startMs;
    countdownKind = 'open';
  }

  return {
    currentHeightM: current,
    heightDeltaToThresholdM: current === null ? null : current - threshold,
    windows,
    currentWindow,
    nextWindow,
    followingWindow,
    windowState,
    countdownTargetMs,
    countdownKind,
    coverageStartMs,
    coverageEndMs,
    horizonEndMs: now + horizonMs,
  };
}
