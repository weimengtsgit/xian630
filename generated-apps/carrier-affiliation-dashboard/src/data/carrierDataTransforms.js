function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeAisTrack(rows = [], total = rows.length) {
  const points = rows
    .map((row) => {
      const lat = toNumber(row.latitude);
      const lon = toNumber(row.longitude);
      if (lat === null || lon === null) return null;
      return {
        lat,
        lon,
        sog: toNumber(row.sog) ?? 0,
        time: row.startTime || null,
      };
    })
    .filter(Boolean);

  return {
    source: 'ais',
    total: total ?? rows.length,
    returned: points.length,
    points,
  };
}

export function attachAisTracksToCarriers(carriers, trackByCarrier, aisByMmsi) {
  return carriers.map((carrier) => {
    const mmsi = carrier.mmsi ? String(carrier.mmsi) : '';
    const ais = mmsi ? aisByMmsi[mmsi] : null;
    if (ais && Array.isArray(ais.rows) && ais.rows.length > 0) {
      const normalized = normalizeAisTrack(ais.rows, ais.total);
      if (normalized.points.length > 0) {
        return {
          ...carrier,
          track: normalized.points,
          trackSource: 'ais',
          trackTotal: normalized.total,
          trackReturned: normalized.returned,
        };
      }
    }

    const fallback = trackByCarrier[carrier.id] || [];
    return {
      ...carrier,
      track: fallback,
      trackSource: fallback.length > 0 ? 'tracklog' : (mmsi ? 'ais_empty' : 'missing_mmsi'),
      trackTotal: fallback.length,
      trackReturned: fallback.filter((point) => point.lat != null && point.lon != null).length,
    };
  });
}

export function attachAisTracksToPlatforms(platforms, aisByMmsi) {
  return platforms.map((platform) => {
    const mmsi = platform.mmsi ? String(platform.mmsi) : '';
    if (!mmsi) {
      return {
        ...platform,
        aisStatus: 'missing_mmsi',
        aisTrackTotal: 0,
        aisTrackReturned: 0,
        aisTrack: [],
      };
    }

    const ais = aisByMmsi[mmsi];
    if (!ais || !Array.isArray(ais.rows) || ais.rows.length === 0) {
      return {
        ...platform,
        aisStatus: 'empty',
        aisTrackTotal: 0,
        aisTrackReturned: 0,
        aisTrack: [],
      };
    }

    const normalized = normalizeAisTrack(ais.rows, ais.total);
    return {
      ...platform,
      aisStatus: normalized.points.length > 0 ? 'available' : 'empty',
      aisTrackTotal: normalized.total,
      aisTrackReturned: normalized.returned,
      aisTrack: normalized.points,
    };
  });
}

function capability(level, label, note) {
  return { level, label, note };
}

export function buildCapabilityStatus({
  carrierCount,
  carriersWithAis,
  shipCount,
  shipsWithAis,
  adsbEventMode,
}) {
  return {
    establishment: capability(
      'available',
      '编制归属可用',
      '航母-打击群-舰载机/平台编制关系可展示。',
    ),
    carrierAis: capability(
      carriersWithAis > 0 ? 'available' : 'unavailable',
      '航母 AIS 轨迹',
      `${carriersWithAis}/${carrierCount} 艘航母可按 MMSI 关联 RawAISData。`,
    ),
    shipAis: capability(
      shipsWithAis === 0 ? 'unavailable' : shipsWithAis === shipCount ? 'available' : 'partial',
      '舰船 AIS 轨迹',
      `${shipsWithAis}/${shipCount} 艘护航/舰船平台可按 MMSI 关联 RawAISData。`,
    ),
    adsbEventInference: capability(
      adsbEventMode ? 'available' : 'unavailable',
      'ADS-B 起降推断',
      adsbEventMode
        ? 'ICAO 与高度数据满足起降事件推断。'
        : '当前 ICAO/高度连续轨迹不足，暂不启用起降事件归属推断。',
    ),
  };
}
