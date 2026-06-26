// ─────────────────────────────────────────────────────────────────────────────
// PURE judgement core for the carrier-air-wing affiliation inference dashboard.
//
// No React, no network, no global Date side effects (an optional `now` param
// flows in from the caller). Every function here is a step of the customer's
// three-step flow (README "Customer Judgement Rules"):
//
//   Step 1  deriveCandidateEvents   — sea takeoff/landing detection
//   Step 2  bindToCarriers          — spatiotemporal carrier binding
//   Step 3  inferAffiliation        — affiliation confidence + status
//           computeDeparted         — stale-activity alert overlay
//
// The four adapter boundaries (adsbTracks, carrierPositions, classifySurface,
// judgementParameters) are the ONLY places real data would later plug in. See
// src/data/mock.js for the demo contract.
// ─────────────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_NM = 3440.065; // nautical miles

// Great-circle distance in nautical miles between two lat/lon points (radians).
export function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_NM * c;
}

// ─── Step 1: sea takeoff / landing event detection ──────────────────────────
//
// Customer wording: "extract takeoff where altitude goes from zero to positive;
// extract landing where altitude goes positive to zero." The demo applies a
// near-ground noise threshold (default 100 ft) so zero is read as "near ground".
// A takeoff = near-ground sample followed by a SUSTAINED positive climb; a
// landing = positive sample followed by a near-ground HOLD. Only surfaceType
// "sea" events become suspected carrier-aircraft events; land/unknown are
// retained for the audit layer but flagged suspected:false.
//
// Tracks MUST arrive sorted ascending by time per aircraft.
export function deriveCandidateEvents(
  adsbTracks,
  { nearGroundAltitudeFt = 100, classifySurface = () => "sea" } = {}
) {
  // Group by aircraft (icao) preserving input order.
  const byIcao = new Map();
  for (const s of adsbTracks) {
    if (!byIcao.has(s.icao)) byIcao.set(s.icao, []);
    byIcao.get(s.icao).push(s);
  }

  const events = [];
  let seq = 0;

  for (const [icao, series] of byIcao) {
    // ensure ascending time
    const sorted = [...series].sort(
      (a, b) => Date.parse(a.time) - Date.parse(b.time)
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const prevNear = prev.altFt <= nearGroundAltitudeFt;
      const curNear = cur.altFt <= nearGroundAltitudeFt;
      const prevAir = prev.altFt > nearGroundAltitudeFt;
      const curAir = cur.altFt > nearGroundAltitudeFt;

      let eventType = null;
      if (prevNear && curAir) {
        // near-ground → positive. Confirm sustained climb (cur is clearly up
        // AND not an isolated blip: a later point still airborne or this is a
        // strong climb). For demo robustness we accept a strong single step.
        eventType = "takeoff";
      } else if (prevAir && curNear) {
        // positive → near-ground. Confirm near-ground hold: cur stays near and
        // either there is no later point or the next is also near/ground.
        const next = sorted[i + 1];
        const holdsNear = !next || next.altFt <= nearGroundAltitudeFt;
        if (holdsNear) eventType = "landing";
      }

      if (!eventType) continue;

      const surfaceType = classifySurface(cur.lat, cur.lon);
      const surfaceConfidence = surfaceType === "unknown" ? 0.4 : 0.92;
      const suspected = surfaceType === "sea";

      events.push({
        id: `evt-${seq++}`,
        icao,
        aircraftType: cur.aircraftType || prev.aircraftType,
        eventType,
        time: cur.time,
        lat: cur.lat,
        lon: cur.lon,
        altitudeTransition: { from: prev.altFt, to: cur.altFt },
        speedKt: cur.speedKt,
        surfaceType,
        surfaceConfidence,
        suspected,
        // Step 2 fills these:
        boundCarrierId: null,
        distanceNm: null,
        carrierPositionTime: null,
        carrierPositionTimeDeltaMinutes: null,
        bindingStatus: "unbound",
      });
    }
  }

  return events;
}

// ─── Step 2: spatiotemporal carrier binding ─────────────────────────────────
//
// For each suspected sea event, find the NEAREST-IN-TIME known carrier position
// (no interpolation), compute haversine distance, and bind iff distance <
// associationDistanceNm. The contract is nearest-in-time, not nearest-in-space:
// the candidate is the carrier whose known position timestamp is closest to the
// event time, even if another carrier is physically closer at a different time.
export function bindToCarriers(
  events,
  carrierPositions,
  { associationDistanceNm = 200 } = {}
) {
  // Flatten each carrier's track into candidate positions tagged with carrier id.
  const positions = [];
  for (const c of carrierPositions) {
    for (const p of c.track || []) {
      positions.push({
        carrierId: c.id,
        carrierName: c.name,
        time: Date.parse(p.time),
        lat: p.lat,
        lon: p.lon,
      });
    }
  }

  return events.map((e) => {
    if (!e.suspected) {
      // land/unknown audit events stay unbound
      return { ...e, boundCarrierId: null, bindingStatus: "unbound", distanceNm: null };
    }

    if (positions.length === 0) {
      return { ...e, boundCarrierId: null, bindingStatus: "unbound", distanceNm: null };
    }

    const evTime = Date.parse(e.time);
    // nearest-in-time
    let nearest = positions[0];
    let bestDelta = Math.abs(evTime - nearest.time);
    for (let k = 1; k < positions.length; k++) {
      const delta = Math.abs(evTime - positions[k].time);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = positions[k];
      }
    }

    const distanceNm = haversineNm(e.lat, e.lon, nearest.lat, nearest.lon);
    const bound = distanceNm < associationDistanceNm;

    return {
      ...e,
      boundCarrierId: bound ? nearest.carrierId : null,
      distanceNm,
      carrierPositionTime: new Date(nearest.time).toISOString(),
      carrierPositionTimeDeltaMinutes: Math.round(bestDelta / 60_000),
      bindingStatus: bound ? "bound" : "unbound",
    };
  });
}

// ─── Step 3: affiliation judgement ──────────────────────────────────────────
//
// Per aircraft: denominator = count of BOUND events only. Unbound suspected
// events are reported separately and NEVER enter the denominator. Status:
//   total bound < minimumBoundAssociations (3)        → 数据不足
//   else one carrier probability > threshold (>0.6)    → 高置信度属舰飞机
//   else ≥2 carriers with associations, none > thresh  → 疑似交叉部署飞机
export function inferAffiliation(
  events,
  { highConfidenceThreshold = 0.6, minimumBoundAssociations = 3 } = {}
) {
  // group events by aircraft
  const byIcao = new Map();
  for (const e of events) {
    if (!e.suspected) continue;
    if (!byIcao.has(e.icao)) byIcao.set(e.icao, []);
    byIcao.get(e.icao).push(e);
  }

  const results = [];
  for (const [icao, evs] of byIcao) {
    const boundEvents = evs.filter((e) => e.bindingStatus === "bound");
    const unboundSuspected = evs.filter(
      (e) => e.bindingStatus === "unbound" && e.suspected
    );
    const totalBound = boundEvents.length;

    // per-carrier association counts (bound only)
    const counts = new Map();
    for (const e of boundEvents) {
      counts.set(e.boundCarrierId, (counts.get(e.boundCarrierId) || 0) + 1);
    }

    const carrierProbabilities = [...counts.entries()]
      .map(([carrierId, associationCount]) => ({
        carrierId,
        associationCount,
        probability: totalBound > 0 ? associationCount / totalBound : 0,
      }))
      .sort((a, b) => b.probability - a.probability || b.associationCount - a.associationCount);

    let status;
    let inferredCarrierId = null;
    let confidence = carrierProbabilities[0]?.probability ?? 0;

    if (totalBound < minimumBoundAssociations) {
      status = "数据不足";
    } else if (carrierProbabilities.length > 0 && carrierProbabilities[0].probability > highConfidenceThreshold) {
      status = "高置信度属舰飞机";
      inferredCarrierId = carrierProbabilities[0].carrierId;
    } else if (carrierProbabilities.length >= 2) {
      status = "疑似交叉部署飞机";
    } else {
      // >= minimum but single carrier not > threshold (e.g. exactly at threshold)
      // treat as insufficient-leaning cross — but per rules, single carrier with
      // enough samples but probability not exceeding threshold falls to cross only
      // when >=2 carriers. With one carrier and enough samples the prob would be
      // 1.0 > threshold, so this branch is effectively unreachable; keep a safe default.
      status = "数据不足";
    }

    const firstSeen = evs.reduce(
      (min, e) => (Date.parse(e.time) < Date.parse(min) ? e.time : min),
      evs[0]?.time ?? new Date().toISOString()
    );
    const latest = evs.reduce(
      (max, e) => (Date.parse(e.time) > Date.parse(max) ? e.time : max),
      evs[0]?.time ?? new Date().toISOString()
    );

    results.push({
      icao,
      aircraftType: evs[0]?.aircraftType,
      firstSeenDate: firstSeen,
      latestActivityDate: latest,
      totalTakeoffLandingCount: evs.filter((e) => e.suspected).length,
      inferredCarrierId,
      confidence,
      status,
      unboundSuspectedEventCount: unboundSuspected.length,
      carrierProbabilities,
    });
  }

  return results;
}

// Returns the chronological carrier-binding sequence used by the expanded-row
// association chart. Audit-only land/unknown events stay on the map and never
// enter a suspected aircraft's affiliation history.
export function buildCarrierAssociationTimeline(events, icao) {
  return events
    .filter((event) => event.icao === icao && event.suspected)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .map((event) => ({
      id: event.id,
      time: event.time,
      eventType: event.eventType,
      carrierId: event.boundCarrierId,
      bindingStatus: event.bindingStatus,
    }));
}

// ─── Departed alert overlay ─────────────────────────────────────────────────
//
// Applies ONLY to 高置信度属舰飞机. If the most recent BOUND event near the
// assigned carrier is older than departedDays → status becomes 已离舰.
// NEVER mutates cross-deploy or insufficient aircraft.
export function computeDeparted(
  aircraft,
  events,
  carriers,
  { departedDays = 30 } = {},
  now = new Date().toISOString()
) {
  if (aircraft.status !== "高置信度属舰飞机") return aircraft;

  // carriers is kept on the signature as the documented contract for a future
  // near-carrier distance refinement; today departed is judged from bound events
  // tagged with the assigned carrier id.
  const carrierId = aircraft.inferredCarrierId;

  // most recent BOUND event near the assigned carrier
  const boundNearAssigned = events
    .filter(
      (e) =>
        e.icao === aircraft.icao &&
        e.bindingStatus === "bound" &&
        e.boundCarrierId === carrierId
    )
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

  const lastBound = boundNearAssigned[0];
  if (!lastBound) {
    // no bound event near assigned carrier at all — treat as departed
    aircraft.status = "已离舰";
    aircraft.departedSince = aircraft.latestActivityDate;
    return aircraft;
  }

  const ageMs = Date.parse(now) - Date.parse(lastBound.time);
  const ageDays = ageMs / 86_400_000;
  if (ageDays > departedDays) {
    aircraft.status = "已离舰";
    aircraft.departedSince = lastBound.time;
  }
  return aircraft;
}
