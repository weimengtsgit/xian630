// DaaS Adapter — 本体 Ontology API 取数底层
// 所有请求经 nginx 反向代理（/api/ontology/ → ceshi.projects.bingosoft.net:8081）
// 严格遵循 SKILL ontology-api.md 的字段契约与请求/响应形状

const API_BASE = '/api/ontology';

/**
 * 从 DaaS 实体取数。请求字段名必须是 ontology-api.md 列出的原始字段——
 * 不要把 UI 归一化名称塞进 columns，会触发 HTTP 400 "Unknown column"。
 */
export async function fetchEntity(entity, columns, filters = [], options = {}) {
  const url = `${API_BASE}/daasDMS/entity/${entity}/list`;
  const body = {
    columns,
    pageParam: { pageIndex: 1, limit: 500 },
    rowType: 'map',
    filters,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`fetchEntity ${entity}: 网络错误 — ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`fetchEntity ${entity}: HTTP ${res.status}`);
  }

  const json = await res.json();

  // resultCode 成功值是 200，不是 10000
  if (json.resultCode !== 200) {
    throw new Error(
      `fetchEntity ${entity}: API ${json.resultCode} — ${json.resultDesc || json.message || '未知错误'}`
    );
  }

  const details = json.details;
  if (!details) return options.includePageParam ? { rows: [], recordTotal: 0 } : [];

  const rows = normalizeRows(details);
  if (options.includePageParam) {
    return {
      rows,
      recordTotal: details.pageParam?.recordTotal ?? rows.length,
    };
  }
  return rows;
}

/** 行归一化：兼容对象行和位置数组行 */
function normalizeRows(details) {
  const names = details.columnNames || [];
  return (details.rows || []).map((row) => {
    if (!Array.isArray(row)) return row || {};
    return Object.fromEntries(names.map((name, i) => [name, row[i]]));
  });
}

// ============================================================
// 实体字段清单（VERIFIED —— 不得猜测，猜测会导致 HTTP 400）
// ============================================================

/** AviationCarrier（航母）：请求 curHeading/curSpeed/homeportStation，绝不请求 heading/speed/homeport */
export const AVIATION_CARRIER_COLS = [
  'id', 'name', 'longitude', 'latitude', 'curStatus',
  'curHeading', 'curSpeed', 'mmsi', 'airWing', 'aircraftCarried',
  'homeportStation', 'dataUpdateTime',
];

/** AircraftCarrier（打击群 / CSG） */
export const AIRCRAFT_CARRIER_COLS = [
  'id', 'name', 'refHMId', 'typeCode', 'curStatus',
  'longitude', 'latitude',
];

/** MaritimeBaseCombatPlatform（海基作战平台——舰载机/舰艇/平台） */
export const PLATFORM_COLS = [
  'id', 'name', 'typeCode', 'mmsi', 'longitude', 'latitude',
  'curStatus', 'maxSpeed', 'cruiseRange',
];

/** AircraftCarrierTrackLog（航母轨迹） */
export const TRACK_LOG_COLS = [
  'refAviationCarrier', 'trackInitTime', 'longitude', 'latitude', 'trackStatusCode',
];

/** RawADSData（ADS-B —— 请求 lat/lon/groundspeed/startTime，绝不请求 longitude/latitude/speed/recordTime） */
export const ADSB_COLS = [
  'icao', 'callsign', 'lat', 'lon', 'altitude',
  'groundspeed', 'track', 'heading', 'startTime',
];

/** RawAISData（AIS 舰船轨迹 —— 可经 mmsi 与平台 JOIN） */
export const AIS_COLS = [
  'mmsi', 'latitude', 'longitude', 'sog', 'shipName', 'startTime',
];

// filter 快捷构建
export function eq(column, condition) {
  return { column, logic: '=', condition: String(condition) };
}

export function isNotNull(column) {
  return { column, logic: 'is not null', condition: null };
}
