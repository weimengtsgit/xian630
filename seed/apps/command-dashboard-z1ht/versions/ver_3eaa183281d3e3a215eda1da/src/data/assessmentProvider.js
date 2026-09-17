// 评估编排：位置库 + 风场 → 逐舰甲板风起降条件快照（视图模型、指标、告警、双源健康度）
// 逐舰独立容错：单舰风场/位置失败仅影响该行（判定=无法判定），不拖垮其他舰。
// 本文件仅做取数编排与归一化，合成/分级计算在 src/utils/deckWind.js（审计约束）。
import { SOURCE_LABELS, POSITION_STALE_DAYS } from '../constants.js';
import { assessDeckWind, undeterminedAssessment } from '../utils/deckWind.js';
import { formatAge, parseTimeSafe } from '../utils/timeFormat.js';
import { fetchCarrierPositions } from './carrierPositionProvider.js';
import { fetchRegionWinds } from './windProvider.js';

// 单舰视图模型
function buildCarrierViewModel(carrier, windData, now) {
  const positionValid = carrier.position
    && Number.isFinite(carrier.position.lat)
    && Number.isFinite(carrier.position.lon);

  let wind = null;
  let windError = null;
  if (windData) {
    wind = windData;
  } else if (!positionValid) {
    windError = '位置缺失（无可评估区域代表点）';
  } else {
    windError = '该区域风场取数失败';
  }

  const deckWind = wind ? assessDeckWind(wind.speedKt) : null;
  const assessment = deckWind || undeterminedAssessment(windError);

  // 数据健康度：风场缺失=error；位置陈旧/降级/风槽超龄=stale；否则 normal
  let dataQuality = 'normal';
  if (!wind) {
    dataQuality = 'error';
  } else {
    const stalePosition = carrier.position.staleLevel !== 'normal';
    const slotStale = wind.slotAgeHours != null && wind.slotAgeHours > 2;
    if (stalePosition || slotStale) dataQuality = 'stale';
  }

  return {
    id: carrier.id,
    name: carrier.name,
    hullNumber: carrier.id,
    className: carrier.className,
    statusText: carrier.statusText,
    homeport: carrier.homeport,
    airWing: carrier.airWing,
    aircraftCarried: carrier.aircraftCarried,
    position: carrier.position,
    positionValid,
    wind,
    windError,
    deckWind: assessment,
    dataQuality,
    computedAt: now.toISOString(),
  };
}

// 全局告警条目（点击可联动矩阵筛选）
function buildAlerts(positionResult, windResult, carriers) {
  const alerts = [];

  if (!positionResult.ok && positionResult.degraded) {
    alerts.push({
      level: 'error',
      title: '航母位置库不可用',
      detail: `${positionResult.error ? positionResult.error.message : ''} — 已按内置默认活动区域代表点评估（非当前位置，结论仅代表默认区域）`,
      targetGrade: null,
    });
  }
  if (positionResult.empty) {
    alerts.push({
      level: 'error',
      title: '在册清单为空',
      detail: '位置库未返回任何美海军现役航母，无法开展评估',
      targetGrade: null,
    });
  }

  if (!windResult.ok) {
    alerts.push({
      level: 'error',
      title: '风场数据源不可用',
      detail: `${windResult.error ? windResult.error.message : ''} — 相关舰判定为「无法判定」，未展示任何估算值`,
      targetGrade: 'undetermined',
    });
  } else if (carriers.some((c) => c.dataQuality === 'error')) {
    const n = carriers.filter((c) => c.dataQuality === 'error').length;
    alerts.push({
      level: 'warn',
      title: `${n} 艘航母风场取数失败`,
      detail: '仅该部分舰判定为「无法判定」，不影响其余舰艇',
      targetGrade: 'undetermined',
    });
  }

  const staleList = carriers.filter((c) => c.position.staleLevel === 'stale');
  if (staleList.length) {
    alerts.push({
      level: 'stale',
      title: `${staleList.length} 艘航母位置时效超过 72 小时`,
      detail: `${staleList.map((c) => c.hullNumber).join('、')} 位置陈旧，判定结论仅供参考`,
      targetGrade: null,
    });
  }
  const deepList = carriers.filter((c) => c.position.staleLevel === 'deep-stale');
  if (deepList.length) {
    alerts.push({
      level: 'error',
      title: `${deepList.length} 艘航母位置时效超过 ${POSITION_STALE_DAYS} 天`,
      detail: `${deepList.map((c) => c.hullNumber).join('、')} 位置深度陈旧，判定基于旧位置，请以值班渠道核实`,
      targetGrade: null,
    });
  }
  const windStale = carriers.filter((c) => c.wind && c.wind.slotAgeHours != null && c.wind.slotAgeHours > 2);
  if (windStale.length) {
    alerts.push({
      level: 'stale',
      title: `${windStale.length} 艘航母风场槽龄超过 2 小时`,
      detail: '风场时效偏旧，结论为该小时槽近似评估',
      targetGrade: null,
    });
  }

  return alerts;
}

/**
 * 拉取完整评估快照（位置 → 风场 → 逐舰判定）。永不 throw，失败信息结构化返回。
 */
export async function fetchAssessmentSnapshot() {
  const now = new Date();
  const positionResult = await fetchCarrierPositions();

  // 对有效位置点取风场（静态降级点与本体点同口径取数）
  const points = positionResult.carriers
    .filter((c) => c.position && Number.isFinite(c.position.lat) && Number.isFinite(c.position.lon))
    .map((c) => ({ key: c.id, lat: c.position.lat, lon: c.position.lon }));
  const windResult = points.length
    ? await fetchRegionWinds(points)
    : { ok: false, source: '', sourceLabel: '', perKey: {}, tried: [], error: new Error('无有效区域代表点') };

  const carriers = positionResult.carriers.map((c) => buildCarrierViewModel(c, windResult.perKey[c.id], now));

  const metrics = {
    total: carriers.length,
    unassistedTakeoffCount: carriers.filter((c) => c.deckWind.unassistedTakeoff === true).length,
    safeRecoveryCount: carriers.filter((c) => c.deckWind.safeRecovery === true).length,
    abnormalCount: carriers.filter((c) => c.dataQuality === 'error' || c.deckWind.grade === 'undetermined').length,
    staleCount: carriers.filter((c) => c.position.staleLevel === 'stale' || c.position.staleLevel === 'deep-stale').length,
  };

  // 双源摘要（驱动顶部状态灯与数据时间展示）
  const validWinds = carriers.filter((c) => c.wind).map((c) => c.wind);
  const windValidTimes = validWinds.map((w) => w.validTime).filter(Boolean).sort();
  const positionTimes = carriers
    .filter((c) => c.position.observedAt)
    .map((c) => String(c.position.observedAt))
    .sort();

  const snapshot = {
    fetchedAt: now.toISOString(),
    position: {
      ok: positionResult.ok,
      empty: positionResult.empty,
      degraded: positionResult.degraded,
      source: positionResult.source,
      sourceLabel: positionResult.sourceLabel,
      error: positionResult.error ? positionResult.error.message : null,
      latestObservedAt: positionTimes.length ? positionTimes[positionTimes.length - 1] : null,
      freshestAgeLabel: (() => {
        if (!positionTimes.length) return null;
        const t = parseTimeSafe(positionTimes[positionTimes.length - 1]);
        return t ? formatAge((now.getTime() - t.getTime()) / 3600000) : null;
      })(),
    },
    wind: {
      ok: windResult.ok && validWinds.length > 0,
      source: windResult.source,
      sourceLabel: windResult.sourceLabel,
      tried: windResult.tried,
      error: windResult.error ? windResult.error.message : null,
      validTime: windValidTimes.length ? windValidTimes[windValidTimes.length - 1] : null,
    },
    carriers,
    metrics,
    alerts: buildAlerts(positionResult, windResult, carriers),
  };
  return snapshot;
}
