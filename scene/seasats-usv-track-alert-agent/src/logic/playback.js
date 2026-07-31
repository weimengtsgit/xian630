export const DEFAULT_REMOTE_MAP_BASE_URL = "http://218.61.33.200:18000/";
// 远程球面地图的回放窗口与服务端轨迹基准一致：2025-01-01 起；end 由 App 用当前时间覆盖。
export const DEFAULT_REPLAY_WINDOW = { start: 1735689600, end: 1784131200 };

export function toEpochSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function targetTrackWindow(target) {
  const segmentTimes = Array.isArray(target?.segments)
    ? target.segments.flatMap((segment) => [
        segment.startTime,
        segment.endTime,
        ...(segment.points || []).map((point) => point.time),
      ])
    : [];
  const pointTimes = Array.isArray(target?.points) ? target.points.map((point) => point.time) : [];
  const times = [...segmentTimes, ...pointTimes].map(toEpochSeconds).filter((time) => time !== null);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times), source: "selected-target" };
}

export function resolveReplayWindow({ selectedTarget, metadata, fallback = DEFAULT_REPLAY_WINDOW, forceFallback = false } = {}) {
  if (forceFallback) return { start: fallback.start, end: fallback.end, source: "fallback" };

  const targetWindow = targetTrackWindow(selectedTarget);
  if (targetWindow) return targetWindow;

  const metaStart = toEpochSeconds(metadata?.dataWindow?.start);
  const metaEnd = toEpochSeconds(metadata?.dataWindow?.end);
  if (metaStart !== null && metaEnd !== null) {
    return { start: metaStart, end: metaEnd, source: "metadata" };
  }

  return { start: fallback.start, end: fallback.end, source: "fallback" };
}

export function filterPayloadByReplayWindow(payload, replayWindow = DEFAULT_REPLAY_WINDOW) {
  const start = toEpochSeconds(replayWindow?.start);
  const end = toEpochSeconds(replayWindow?.end);
  if (start === null || end === null) return payload;

  const trackPoints = (payload?.trackPoints || []).filter((point) => {
    const time = toEpochSeconds(point?.time ?? point?.timestamp);
    return time !== null && time >= start && time <= end;
  });

  return {
    ...payload,
    metadata: {
      ...(payload?.metadata || {}),
      dataWindow: {
        start: new Date(start * 1000).toISOString(),
        end: new Date(end * 1000).toISOString(),
      },
    },
    trackPoints,
  };
}

export function buildRemoteMapUrl({
  baseUrl = DEFAULT_REMOTE_MAP_BASE_URL,
  mmsi,
  startTime,
  endTime,
} = {}) {
  const url = new URL(baseUrl);
  if (mmsi !== null && mmsi !== undefined && mmsi !== "") url.searchParams.set("mmsi", String(mmsi));
  const start = toEpochSeconds(startTime);
  const end = toEpochSeconds(endTime);
  if (start !== null) url.searchParams.set("start_time", String(start));
  if (end !== null) url.searchParams.set("end_time", String(end));
  return url.toString();
}

export function filterForFocusMode({ analysis, selectedMmsi, focusOnly }) {
  if (!focusOnly || !selectedMmsi) return analysis;
  const sameVessel = (item) => item?.targetMmsi === selectedMmsi || item?.mmsi === selectedMmsi;
  return {
    ...analysis,
    targets: (analysis.targets || []).filter((target) => target.mmsi === selectedMmsi),
    alerts: (analysis.alerts || []).filter(sameVessel),
    segments: (analysis.segments || []).filter(sameVessel),
    aisGaps: (analysis.aisGaps || []).filter(sameVessel),
  };
}
