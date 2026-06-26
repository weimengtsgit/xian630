// DaaS 原始字段 → UI 展示字段归一化
// 请求时用 Raw DaaS 字段，取回后映射为 UI 字段
// 严禁把 UI 字段名发给取数层（会导致 HTTP 400 Unknown column）

import {
  fetchEntity, eq, isNotNull,
  AVIATION_CARRIER_COLS, AIRCRAFT_CARRIER_COLS, PLATFORM_COLS,
  TRACK_LOG_COLS, ADSB_COLS, AIS_COLS,
} from './daasAdapter';
import {
  attachAisTracksToCarriers,
  attachAisTracksToPlatforms,
  buildCapabilityStatus,
} from './carrierDataTransforms';

// ============================================================
// 数据编排：航母 → 打击群 → 平台（三步链，不是两步）
// ============================================================

let cached = null;

/**
 * 加载全部归属推断所需数据（含归一化）。
 * 结果缓存于 session；刷新请调用 clearCache()。
 */
export async function loadAffiliationData() {
  if (cached) return cached;

  const errors = [];

  // Step 1 — AviationCarrier（航母 master）
  let carriersRaw = [];
  try {
    carriersRaw = await fetchEntity('AviationCarrier', AVIATION_CARRIER_COLS);
  } catch (e) {
    errors.push(`AviationCarrier: ${e.message}`);
  }

  // 归一化：curHeading→heading, curSpeed→speed, homeportStation→homeport
  const carriers = carriersRaw.map(normalizeCarrier);

  // Step 2 — AircraftCarrier（打击群）
  let csgsRaw = [];
  try {
    csgsRaw = await fetchEntity('AircraftCarrier', AIRCRAFT_CARRIER_COLS);
  } catch (e) {
    errors.push(`AircraftCarrier: ${e.message}`);
  }

  // 把 CSG 按 refHMId 挂到 carrier 上
  const csgByRef = {};
  csgsRaw.forEach((csg) => {
    const key = csg.refHMId;
    if (!csgByRef[key]) csgByRef[key] = [];
    csgByRef[key].push(csg);
  });

  // Step 3 — 对每个 CSG 取 MaritimeBaseCombatPlatform
  const platformPromises = csgsRaw.map(async (csg) => {
    try {
      const platforms = await fetchEntity('MaritimeBaseCombatPlatform', PLATFORM_COLS, [
        eq('AircraftCarrier.id', csg.id),
      ]);
      return { csgId: csg.id, platforms };
    } catch (e) {
      errors.push(`Platforms for ${csg.id}: ${e.message}`);
      return { csgId: csg.id, platforms: [] };
    }
  });
  const platformResults = await Promise.all(platformPromises);
  const platformsByCsg = {};
  platformResults.forEach((r) => { platformsByCsg[r.csgId] = r.platforms; });

  // Step 4 — AircraftCarrierTrackLog
  let trackLogRaw = [];
  try {
    trackLogRaw = await fetchEntity('AircraftCarrierTrackLog', TRACK_LOG_COLS);
  } catch (e) {
    errors.push(`TrackLog: ${e.message}`);
  }

  // 把 track 点按 refAviationCarrier 分组到对应 carrier
  const trackByCarrier = {};
  trackLogRaw.forEach((pt) => {
    const key = pt.refAviationCarrier;
    if (!trackByCarrier[key]) trackByCarrier[key] = [];
    trackByCarrier[key].push({
      time: pt.trackInitTime,
      lat: pt.latitude != null ? Number(pt.latitude) : null,
      lon: pt.longitude != null ? Number(pt.longitude) : null,
    });
  });

  // Step 5 — ADS-B（仅 icao 非空）
  let adsbRaw = [];
  try {
    adsbRaw = await fetchEntity('RawADSData', ADSB_COLS, [isNotNull('icao')]);
  } catch (e) {
    errors.push(`ADS-B: ${e.message}`);
  }
  const adsb = adsbRaw.map(normalizeAdsb);

  // Step 6 — AIS（按 mmsi 遍历平台中的舰船）
  let aisByMmsi = {};
  const shipPlatforms = [];
  platformResults.forEach((r) => {
    r.platforms.forEach((p) => {
      if (p.mmsi && p.typeCode && !p.typeCode.toLowerCase().includes('fa-18')
        && !p.typeCode.toLowerCase().includes('f-35') && !p.typeCode.toLowerCase().includes('e-2')
        && !p.typeCode.toLowerCase().includes('mh-60') && !p.typeCode.toLowerCase().includes('cmv')
        && !p.typeCode.toLowerCase().includes('mq-25')) {
        shipPlatforms.push(p);
      }
    });
  });
  // 去重 mmsi
  const carrierMmsi = carriers.map((c) => c.mmsi).filter(Boolean);
  const shipMmsi = shipPlatforms.map((p) => p.mmsi).filter(Boolean);
  const uniqueMmsi = [...new Set([...carrierMmsi, ...shipMmsi].map((mmsi) => String(mmsi)))];
  if (uniqueMmsi.length > 0) {
    const aisPromises = uniqueMmsi.map(async (mmsi) => {
      try {
        const result = await fetchEntity('RawAISData', AIS_COLS, [eq('mmsi', mmsi)], {
          includePageParam: true,
        });
        return { mmsi, rows: result.rows, total: result.recordTotal };
      } catch (e) {
        errors.push(`AIS ${mmsi}: ${e.message}`);
        return { mmsi, rows: [], total: 0 };
      }
    });
    const aisResults = await Promise.all(aisPromises);
    aisResults.forEach((r) => { aisByMmsi[r.mmsi] = { rows: r.rows, total: r.total }; });
  }
  const carriersWithTracks = attachAisTracksToCarriers(carriers, trackByCarrier, aisByMmsi);

  // 组装 carrier → CSG → platforms
  const strikeGroups = csgsRaw.map((csg) => {
    const carrier = carriersWithTracks.find((c) => c.id === csg.refHMId) || null;
    const platforms = platformsByCsg[csg.id] || [];
    const aircraft = platforms.filter((p) => isAircraft(p.typeCode));
    const ships = attachAisTracksToPlatforms(platforms.filter((p) => isShip(p.typeCode)), aisByMmsi);

    return {
      id: csg.id,
      name: csg.name,
      typeCode: csg.typeCode,
      curStatus: csg.curStatus,
      lat: csg.latitude != null ? Number(csg.latitude) : null,
      lon: csg.longitude != null ? Number(csg.longitude) : null,
      carrier,
      aircraft,
      ships,
      platformCount: platforms.length,
    };
  });

  // 推断模式判定
  const hasPlatformIcao = false; // MaritimeBaseCombatPlatform 无 icao 字段
  const adsbAltitudeUsable = adsb.filter((t) => t.alt_ft > 0).length > 10;
  const mode = hasPlatformIcao && adsbAltitudeUsable ? 'event_based' : 'establishment_based';
  const totalShips = strikeGroups.reduce((sum, sg) => sum + sg.ships.length, 0);
  const shipsWithAis = strikeGroups.reduce(
    (sum, sg) => sum + sg.ships.filter((ship) => ship.aisStatus === 'available').length,
    0,
  );
  const carriersWithAis = carriersWithTracks.filter((carrier) => carrier.trackSource === 'ais').length;

  cached = {
    carriers: carriersWithTracks,
    strikeGroups,
    adsb,
    aisByMmsi,
    capabilities: buildCapabilityStatus({
      carrierCount: carriers.length,
      carriersWithAis,
      shipCount: totalShips,
      shipsWithAis,
      adsbEventMode: mode === 'event_based',
    }),
    mode,
    modeNote: mode === 'establishment_based'
      ? 'CSG 编制归属（ADS-B 事件推断不可用：平台无 icao 字段，ADS-B 高度数据不足）'
      : 'ADS-B 事件推断模式',
    errors,
    fetchedAt: new Date().toISOString(),
  };

  return cached;
}

/**
 * AviationCarrier raw 行 → UI 字段
 * 请求: curHeading/curSpeed/homeportStation  →  UI: heading/speed/homeport
 */
function normalizeCarrier(row) {
  return {
    id: row.id,
    name: row.name,
    lat: row.latitude != null ? Number(row.latitude) : null,
    lon: row.longitude != null ? Number(row.longitude) : null,
    curStatus: row.curStatus,
    heading: row.curHeading != null ? Number(row.curHeading) : 0,
    speed: row.curSpeed != null ? Number(row.curSpeed) : 0,
    mmsi: row.mmsi,
    airWing: row.airWing,
    aircraftCarried: row.aircraftCarried,
    homeport: row.homeportStation || '',
    dataUpdateTime: row.dataUpdateTime,
  };
}

/**
 * RawADSData raw 行 → UI 字段
 * 请求: lat/lon/groundspeed/startTime  →  UI: lat/lon/speed_kt/time
 */
function normalizeAdsb(row) {
  return {
    icao: row.icao,
    callsign: row.callsign,
    lat: row.lat != null ? Number(row.lat) : null,
    lon: row.lon != null ? Number(row.lon) : null,
    alt_ft: row.altitude != null ? Number(row.altitude) : 0,
    speed_kt: row.groundspeed != null ? Number(row.groundspeed) : 0,
    track_deg: row.track != null ? Number(row.track) : null,
    heading_deg: row.heading != null ? Number(row.heading) : null,
    time: row.startTime,
  };
}

function isAircraft(typeCode) {
  if (!typeCode) return false;
  const t = typeCode.toUpperCase();
  return /F\/A-?18|F-35|E-2[CD]?|MH-60|MH-53|CMV-22|MQ-25|KC-130|P-8|E-6|HH-60|SH-60|V-22|AV-8|T-45|C-2|E\/A-18/.test(t);
}

function isShip(typeCode) {
  if (!typeCode) return false;
  const t = typeCode.toUpperCase();
  return /DDG|CG-|LCS|LHA|LHD|CVN|CV-|FFG|LPD|T-AO|T-AKE|AOE|SSN|SSBN/.test(t);
}

export function clearCache() {
  cached = null;
}
