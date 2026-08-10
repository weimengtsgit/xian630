// 舰艇名称登记表（MMSI -> 公开舷号 / 船名）。
//
// 用途：当本体接口与受监测名单均无法解析出真实船名（侧栏仍显示 "MMSI xxxxxxx"）时，
//   在此登记后，服务端解析会优先采用，侧栏即显示真实舷号与船名。
// 通用性：后续新增舰艇数据时，只需在此追加一行即可，无需改动其它代码；
//   未登记或留空的 MMSI 仍沿用本体/名单解析，不影响既有舰船。
// 查询入口：https://www.marinetraffic.com/en/ais/details/ships/mmsi:<MMSI>
//   （marinetraffic 等外部站点有 Cloudflare/JS 校验，无法在服务端自动抓取，需在浏览器中查询后回填。）
export const VESSEL_NAME_OVERRIDES = {
  // 已登记示例：直接显示真实舷号与船名。
  // "368926540": { code: "DDG-118", name: "丹尼尔·井上号", shortName: "井上号" },

  // SEAHAWK 有中文名“海鹰号”：关联结论与界面统一显示中文，覆盖本体可能返回的英文 shipName。
  "368926574": { code: null, name: "海鹰号", shortName: null },

  // 以下 5 艘暂无公开船名，待在 marinetraffic 查询后补全 code/name/shortName（留空则仍显示 MMSI）：
  "369970641": { code: null, name: null, shortName: null },
  "369970176": { code: null, name: null, shortName: null },
  "338962000": { code: null, name: null, shortName: null },
  "369970407": { code: null, name: null, shortName: null },
  "368011000": { code: null, name: null, shortName: null },
};

// 解析单条覆盖信息；未登记或仅占位（name/code 均空）时返回 null，不影响既有解析。
// 拆出 registry 参数便于测试，默认使用上方登记表。
export function resolveOverride(mmsi, registry = VESSEL_NAME_OVERRIDES) {
  const entry = registry[String(mmsi)];
  if (!entry) return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const code = typeof entry.code === "string" ? entry.code.trim() : "";
  const shortName = typeof entry.shortName === "string" ? entry.shortName.trim() : "";
  if (!name && !code) return null;
  return { name: name || null, code: code || null, shortName: shortName || null };
}

export function getVesselOverride(mmsi, registry = VESSEL_NAME_OVERRIDES) {
  return resolveOverride(mmsi, registry);
}

// 将登记表覆盖合并到名单条目上，返回新对象；未登记时原样返回（保持引用相等）。
// 供服务端在构建侧栏标签前调用：code/name/shortName 优先取登记值，其余字段不变。
export function applyVesselOverride(vessel, registry = VESSEL_NAME_OVERRIDES) {
  const override = resolveOverride(vessel?.mmsi, registry);
  if (!override) return vessel;
  return {
    ...vessel,
    code: override.code ?? vessel.code ?? null,
    name: override.name ?? vessel.name ?? null,
    shortName: override.shortName ?? vessel.shortName ?? null,
  };
}
