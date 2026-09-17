// AIS 佐证接入（可选增强，不作位置真值）：本体 DaaS RawAISData 按 mmsi 小样本
// 用途：详情面板展示该舰 AIS 历史存档最新点时间/航速，佐证位置时效。
// 契约：RawAISData 用 latitude/longitude（非 lat/lon）；mmsi 过滤；成功码 200 兼容
//   details.resultCode；startTime 常为 null，最新时间以 dataUpdateTime 优先。
// 该存档为历史归档（观测时最新点滞后约十余天），仅作佐证展示，不参与判定。
// 失败静默（返回 available:false），不阻塞主流程、不影响判定。
import { fetchEntity, numSafe } from './ontologyClient.js';

const RAW_AIS_COLUMNS = ['mmsi', 'latitude', 'longitude', 'sog', 'shipName', 'startTime', 'dataUpdateTime'];

/**
 * 拉取单舰 AIS 最新佐证（小样本）。
 * @param {string} mmsi
 * @returns {Promise<{available:boolean, latestTime:string|null, sogKt:number|null,
 *   pointCount:number, note:string}>}
 */
export async function fetchAisEvidence(mmsi) {
  if (!mmsi) {
    return { available: false, latestTime: null, sogKt: null, pointCount: 0, note: '该舰无 MMSI，AIS 佐证未启用' };
  }
  try {
    const rows = await fetchEntity('RawAISData', RAW_AIS_COLUMNS,
      [{ column: 'mmsi', logic: '=', condition: String(mmsi) }], 5);
    if (!rows.length) {
      return { available: false, latestTime: null, sogKt: null, pointCount: 0, note: 'AIS 存档中无该舰记录' };
    }
    // 最新时间：优先 dataUpdateTime，回退 startTime（常为 null）
    let best = null;
    let bestTime = null;
    for (const r of rows) {
      const t = r.dataUpdateTime || r.startTime;
      if (!t) continue;
      if (bestTime == null || String(t) > String(bestTime)) {
        bestTime = String(t);
        best = r;
      }
    }
    return {
      available: true,
      latestTime: bestTime,
      sogKt: best ? numSafe(best.sog) : null,
      pointCount: rows.length,
      note: '本体 AIS 历史存档（仅佐证，滞后明显，不作位置真值）',
    };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? '请求超时' : err && err.message ? err.message : '网络错误';
    return { available: false, latestTime: null, sogKt: null, pointCount: 0, note: `AIS 佐证不可用（${reason}）` };
  }
}
