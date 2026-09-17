// JCG（日本海上保安厅）潮汐推算页面解析器。
// 只消费页面公开字段：毎時潮高表（cm，平均海面基准，两行 × 12 值，行前有 (cm) 标记）。
// 页面结构不匹配时报 JCG_PARSE_FAILED 错误，绝不猜测数值。
// 本文件属于数据层：只做解析与 cm→m 归一化，不做窗口运算。

import { zonedWallToUtc } from '../utils/time.js';

const MAX_CM = 500;  // 潮高合理性上界（cm），超出视为解析错位
const MIN_CM = -300; // 平均海面基准下允许负值（cm）

function extractNumbers(text) {
  const out = [];
  const re = /-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(Number(m[0]));
  return out;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body ? doc.body.textContent : '';
}

function plausibleCm(v) {
  return Number.isFinite(v) && v >= MIN_CM && v <= MAX_CM;
}

// 返回按小时序的 24 个潮高（米，平均海面基准）。
export function parseJcgHourlyHeightsM(html) {
  const text = htmlToText(html);
  const headingIdx = Math.max(text.indexOf('毎時潮高'), text.indexOf('每時潮高'));
  if (headingIdx < 0) {
    throw new Error('JCG_PARSE_FAILED：页面未找到「毎時潮高」表（页面结构可能已变化）');
  }
  const after = text.slice(headingIdx);

  // 策略一：(cm) 标记锚定 —— 每个标记后紧跟 12 个整时潮高值。
  const cmRe = /\(cm\)|（cm）|単位\s*\(?\s*cm\s*\)?/g;
  const cmPositions = [];
  let mm;
  while ((mm = cmRe.exec(after)) !== null) cmPositions.push(mm.index);
  if (cmPositions.length >= 2) {
    const values = [];
    let ok = true;
    for (let k = 0; k < 2 && ok; k += 1) {
      const nums = extractNumbers(after.slice(cmPositions[k])).slice(0, 12);
      if (nums.length < 12 || nums.some((v) => !plausibleCm(v))) ok = false;
      else values.push(...nums);
    }
    if (ok && values.length === 24) return values.map((v) => v / 100);
  }

  // 策略二：整时表头锚定 —— 找 0..11 与 12..23 两段表头，各取其后 12 个值。
  const tokens = extractNumbers(after);
  const findHeader = (startHour) => {
    for (let i = 0; i + 12 <= tokens.length; i += 1) {
      let match = true;
      for (let k = 0; k < 12; k += 1) {
        if (tokens[i + k] !== startHour + k) { match = false; break; }
      }
      if (match) return i + 12;
    }
    return -1;
  };
  const v1At = findHeader(0);
  const v2At = findHeader(12);
  if (v1At >= 0 && v2At >= 0) {
    const vals = [...tokens.slice(v1At, v1At + 12), ...tokens.slice(v2At, v2At + 12)];
    if (vals.length === 24 && vals.every(plausibleCm)) {
      return vals.map((v) => v / 100);
    }
  }

  throw new Error('JCG_PARSE_FAILED：毎時潮高表结构与预期不符（未能提取 24 个整时潮高值）');
}

// 一日推算页 → 24 个逐时序列点（UTC 毫秒 + 米）。
export function jcgDaySeries(html, year, month, day) {
  const heights = parseJcgHourlyHeightsM(html);
  const series = [];
  for (let h = 0; h < 24; h += 1) {
    const pad = (n) => String(n).padStart(2, '0');
    const wall = `${year}-${pad(month)}-${pad(day)} ${pad(h)}:00`;
    const t = zonedWallToUtc(wall, 'Asia/Tokyo');
    if (!Number.isNaN(t)) series.push({ t, heightM: heights[h] });
  }
  return series;
}
