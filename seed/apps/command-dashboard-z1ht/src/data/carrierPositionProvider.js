// 航母位置数据接入：本体 DaaS AviationCarrier（公开情报位置库）+ 静态降级兜底
// 路径：浏览器 → 同源 /api/ontology/（nginx 反代注入鉴权头）→ 本体 DaaS
// 契约：请求列名必须用原始 DaaS 列名（curHeading/curSpeed/homeportStation 等），
//   UI 归一化在取数后进行；过滤仅保留美海军现役（id 形如 CVN-xx）。
// 降级：任一失败（网络/401/非 200）→ 静态默认活动区域代表点（公开常识，非当前位置）；
//   本体成功但过滤后 0 行 → 空态（empty）。绝不伪造位置。
// 本文件仅做取数与归一化，不含任何几何/随机运算。
import { STATIC_US_CARRIER_REGISTRY, SOURCE_LABELS } from '../constants.js';
import { resolveSeaArea } from '../utils/seaArea.js';
import { positionAgeInfo } from '../utils/timeFormat.js';
import { fetchEntity, numSafe } from './ontologyClient.js';

// 原始 DaaS 列名（Swagger 已文档化字段；禁止 UI 归一化名）
const AVIATION_CARRIER_COLUMNS = [
  'id', 'name', 'longitude', 'latitude', 'curStatus', 'curHeading', 'curSpeed',
  'mmsi', 'airWing', 'aircraftCarried', 'homeportStation', 'dataUpdateTime',
];

// 公开常识：舷号 → 舰级（CVN-68..77 尼米兹级；CVN-78 及以后福特级）
function hullClassFromId(id) {
  const m = /^CVN-(\d+)$/i.exec(String(id || '').trim());
  if (!m) return '';
  const n = Number(m[1]);
  if (n >= 68 && n <= 77) return '尼米兹级';
  if (n >= 78) return '福特级';
  return '';
}

function normalizeOntologyCarrier(row) {
  const id = String(row.id || '').trim();
  const lat = numSafe(row.latitude);
  const lon = numSafe(row.longitude);
  const age = positionAgeInfo(row.dataUpdateTime);
  return {
    id,
    name: String(row.name || id || '—'),
    className: hullClassFromId(id),
    homeport: String(row.homeportStation || '—'),
    airWing: String(row.airWing || ''),
    aircraftCarried: String(row.aircraftCarried || ''),
    statusText: String(row.curStatus || '—'),
    position: {
      lat,
      lon,
      seaArea: lat != null && lon != null ? resolveSeaArea(lat, lon) : null,
      observedAt: row.dataUpdateTime != null && String(row.dataUpdateTime) !== '' ? String(row.dataUpdateTime) : null,
      ageHours: age.ageHours,
      ageLabel: age.ageLabel,
      staleLevel: age.staleLevel,
      heading: numSafe(row.curHeading), // 仅展示参考，不参与合成计算
      speedKt: numSafe(row.curSpeed), // 仅展示参考，不参与合成计算（合成上限固定 30 节）
      mmsi: row.mmsi != null && String(row.mmsi) !== '' ? String(row.mmsi) : '',
      source: 'ontology-daas',
      sourceLabel: SOURCE_LABELS['ontology-daas'],
    },
  };
}

// 静态降级视图（公开常识在册清单 + 默认活动区域代表点；界面显著标注非当前位置）
function toStaticCarrier(entry) {
  return {
    id: entry.id,
    name: entry.name,
    className: entry.className,
    homeport: entry.homeport,
    airWing: '',
    aircraftCarried: '',
    statusText: '在册（公开常识）',
    position: {
      lat: entry.defaultRegion.lat,
      lon: entry.defaultRegion.lon,
      seaArea: entry.defaultRegion.area,
      observedAt: null,
      ageHours: null,
      ageLabel: '不可用',
      staleLevel: 'unavailable',
      heading: null,
      speedKt: null,
      mmsi: '',
      source: 'static-default-region',
      sourceLabel: SOURCE_LABELS['static-default-region'],
    },
  };
}

/**
 * 拉取美海军现役航母清单与当前位置（含时效）。
 * @returns {Promise<{ok:boolean, empty:boolean, degraded:boolean, source:string,
 *   sourceLabel:string, carriers:Array, error:Error|null}>}
 *   - ok=true：本体真实数据（已过滤 CVN 美舰）
 *   - empty=true：本体成功但过滤后 0 行（调用方呈现空态页）
 *   - degraded=true：本体不可用，返回静态默认区域降级清单（显著标注）
 */
export async function fetchCarrierPositions() {
  try {
    const rows = await fetchEntity('AviationCarrier', AVIATION_CARRIER_COLUMNS, [], 100);
    const usRows = rows.filter((r) => /^CVN-\d+$/i.test(String(r.id || '').trim()));
    if (usRows.length === 0) {
      return {
        ok: false, empty: true, degraded: false,
        source: 'ontology-daas', sourceLabel: SOURCE_LABELS['ontology-daas'],
        carriers: [],
        error: new Error('位置库请求成功，但未返回任何美海军现役航母（在册清单为空）'),
      };
    }
    return {
      ok: true, empty: false, degraded: false,
      source: 'ontology-daas', sourceLabel: SOURCE_LABELS['ontology-daas'],
      carriers: usRows.map(normalizeOntologyCarrier),
      error: null,
    };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? '请求超时' : err && err.message ? err.message : '网络错误';
    return {
      ok: false, empty: false, degraded: true,
      source: 'static-default-region', sourceLabel: SOURCE_LABELS['static-default-region'],
      carriers: STATIC_US_CARRIER_REGISTRY.map(toStaticCarrier),
      error: new Error(`位置库不可用（${reason}），已按静态默认活动区域代表点降级评估`),
    };
  }
}
