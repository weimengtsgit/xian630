// 侧栏舰艇标签统一为“代号 船名”形式。
// 代号：名单按公开舷号维护 code；未配置时由服务端从 AIS 船名中提取舷号兜底（美军舰 AIS 名常自带舷号）。
// 船名：优先取名单配置中的中文名，再取本体识别名中的中文段，最后回退实际获取的名字；
// 没有实际船名（MMSI 占位或通用占位名）时只保留代号。

// 从“华盛顿号 (USS George Washington)”一类船名中提取中文部分。
export function chineseShipName(name) {
  const matched = String(name || "").match(/[一-鿿][一-鿿·•]*/);
  return matched ? matched[0] : null;
}

// 从本体 AIS 名称中保留英文部分；若名称本身带有中文括注，则去掉括注，避免在双语标签中重复。
export function englishShipName(name) {
  const text = String(name || "").trim();
  if (!text || isPlaceholderName(text) || isGenericVesselName(text) || !/[A-Za-z]/.test(text)) return null;
  const withoutChineseNote = text.replace(/[（(]\s*[一-鿿][^）)]*[）)]/g, "").trim();
  return withoutChineseNote || null;
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

// 右侧栏沿用旧规则：中文名优先；没有中文名时才展示实际获取到的英文名。
export function vesselPreferredLabel({ code, name, fallbackName } = {}) {
  const trimmedCode = String(code || "").trim();
  const primary = String(name || "").trim();
  const fallback = String(fallbackName || "").trim();
  const chinese = chineseShipName(primary) || chineseShipName(fallback);
  const text = [primary, fallback].find((value) => value && !isPlaceholderName(value) && !isGenericVesselName(value)) || "";
  const shipName = chinese || text || null;
  if (!trimmedCode) return shipName || primary || fallback;
  if (!shipName) return trimmedCode;
  if (shipName.toUpperCase().includes(trimmedCode.toUpperCase())) return shipName;
  return `${trimmedCode} ${shipName}`;
}

// 左侧栏使用双语格式：英文（中文）。
export function vesselSidebarLabel({ code, name, fallbackName, englishName, chineseName } = {}) {
  const trimmedCode = String(code || "").trim();
  const primary = String(name || "").trim();
  const fallback = String(fallbackName || "").trim();
  const identity = String(englishName || "").trim();
  const configuredChinese = String(chineseName || "").trim();
  // 中文船名优先取使用方名单（航母等已指定短名），再取本体识别名；英文名优先取本体识别名。
  const chinese = chineseShipName(configuredChinese) || chineseShipName(primary) || chineseShipName(fallback);
  const english = [identity, fallback, primary].map(englishShipName).find(Boolean) || null;
  const fallbackText = [primary, fallback, identity].find((value) => value && !isPlaceholderName(value) && !isGenericVesselName(value)) || "";
  // 仅在存在独立中文船名时展示“英文（中文）”；代码型或仅英文船名保持英文，不重复伪造中文名。
  const shipName = english && chinese ? `${english}（${chinese}）` : english || chinese || fallbackText || null;
  if (!trimmedCode) return shipName || primary || fallback;
  // 没有实际船名时只写代号。
  if (!shipName) return trimmedCode;
  // 实际船名已包含代号（如 USS Benfold DDG-65）时不再重复拼接。
  if (shipName.toUpperCase().includes(trimmedCode.toUpperCase())) return shipName;
  return `${trimmedCode} ${shipName}`;
}
