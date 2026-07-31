// 侧栏舰艇标签统一为“代号 船名”形式。
// 代号：名单按公开舷号维护 code；未配置时由服务端从 AIS 船名中提取舷号兜底（美军舰 AIS 名常自带舷号）。
// 船名：优先取名单配置中的中文名，再取本体识别名中的中文段，最后回退实际获取的名字；
// 没有实际船名（MMSI 占位或通用占位名）时只保留代号。

// 从“华盛顿号 (USS George Washington)”一类船名中提取中文部分。
export function chineseShipName(name) {
  const matched = String(name || "").match(/[一-鿿][一-鿿·•]*/);
  return matched ? matched[0] : null;
}

// 从 AIS 船名中提取舷号（如 USS Benfold DDG-65、CVN-71、USNS Guadalupe T-AO-200）。
const HULL_CODE_PATTERN = /\b((?:T-AOE|T-AKE|T-AO|T-AE|T-ARS|T-ATF|T-AGOS|T-EPF|T-ESD|T-ESB|CVN|DDG|SSBN|SSGN|LHA|LHD|LPD|LSD|LCS|SSN|FFG|AOE|CG|AO|AE|AKE)-?\d{1,4}[A-Z]?)\b/i;

export function extractHullCode(name) {
  const matched = String(name || "").toUpperCase().match(HULL_CODE_PATTERN);
  // 统一为带连字符形式（DDG65 → DDG-65）。
  return matched ? matched[1].replace(/^((?:T-)?[A-Z]+)-?(\d.*)$/, "$1-$2") : null;
}

function isPlaceholderName(name) {
  return /^MMSI\s*\d+$/i.test(String(name || "").trim());
}

function isGenericVesselName(name) {
  return /^(?:US\s+GOV(?:ERNMENT)?(?:\s+VESSEL)?|US\s+WARSHIP|WARSHIP|美国政府船只)$/i.test(String(name || "").trim());
}

export function vesselSidebarLabel({ code, name, fallbackName } = {}) {
  const trimmedCode = String(code || "").trim();
  const primary = String(name || "").trim();
  const fallback = String(fallbackName || "").trim();
  // 中文船名优先取使用方名单（航母等已指定短名），再取本体识别名。
  const chinese = chineseShipName(primary) || chineseShipName(fallback);
  const text = [primary, fallback].find((value) => value && !isPlaceholderName(value) && !isGenericVesselName(value)) || "";
  const shipName = chinese || text || null;
  if (!trimmedCode) return shipName || primary || fallback;
  // 没有实际船名时只写代号。
  if (!shipName) return trimmedCode;
  // 实际船名已包含代号（如 USS Benfold DDG-65）时不再重复拼接。
  if (shipName.toUpperCase().includes(trimmedCode.toUpperCase())) return shipName;
  return `${trimmedCode} ${shipName}`;
}
