import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chineseShipName, englishShipName, extractHullCode, vesselPreferredLabel, vesselSidebarLabel } from "./vesselLabel.js";

const appSource = readFileSync(new URL("../app/App.jsx", import.meta.url), "utf8");
const scopeSource = readFileSync(new URL("../../server/seasatsScope.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../server/app-server.js", import.meta.url), "utf8");

test("extracts the Chinese ship name from a configured display name", () => {
  assert.equal(chineseShipName("华盛顿号 (USS George Washington)"), "华盛顿号");
  assert.equal(chineseShipName("罗斯福号 (USS Theodore Roosevelt)"), "罗斯福号");
  assert.equal(chineseShipName("海猎号"), "海猎号");
  assert.equal(chineseShipName("SD3001"), null);
  assert.equal(chineseShipName(null), null);
});

test("extracts hull codes embedded in AIS ship names", () => {
  assert.equal(extractHullCode("USS Benfold DDG-65(US GOV VESSEL)"), "DDG-65");
  assert.equal(extractHullCode("USS Shoup DDG-86(US GOV VESSEL)"), "DDG-86");
  assert.equal(extractHullCode("USS Theodore Roosevelt CVN-71(US GOV VESSEL)"), "CVN-71");
  assert.equal(extractHullCode("USNS Guadalupe T-AO-200"), "T-AO-200");
  assert.equal(extractHullCode("USNS Washington Chambers T-AKE-11"), "T-AKE-11");
  assert.equal(extractHullCode("USNS Supply T-AOE-6"), "T-AOE-6");
  assert.equal(extractHullCode("USS HIGGINS DDG76"), "DDG-76");
  assert.equal(extractHullCode("SEASATS 55"), null);
  assert.equal(extractHullCode("US GOV VESSEL"), null);
  assert.equal(extractHullCode("霍珀"), null);
  assert.equal(extractHullCode(null), null);
});

test("combines code and Chinese ship name for the sidebar label", () => {
  assert.equal(vesselSidebarLabel({ code: "CVN-73", name: "华盛顿号" }), "CVN-73 华盛顿号");
  assert.equal(vesselSidebarLabel({ code: "CVN-71", name: "罗斯福号" }), "CVN-71 罗斯福号");
});

test("combines the ontology English name and the roster Chinese name into a stable bilingual label", () => {
  assert.equal(
    vesselSidebarLabel({ name: "海鹰号", fallbackName: "海鹰号", englishName: "SEAHAWK" }),
    "SEAHAWK（海鹰号）",
  );
  assert.equal(
    vesselSidebarLabel({ code: "CVN-73", name: "华盛顿号", englishName: "USS George Washington（乔治·华盛顿号）" }),
    "CVN-73 USS George Washington（华盛顿号）",
  );
  assert.equal(englishShipName("USS George Washington（乔治·华盛顿号）"), "USS George Washington");
});

test("keeps the right-side label Chinese-first when an English fallback is also available", () => {
  assert.equal(
    vesselPreferredLabel({ code: "CVN-73", name: "华盛顿号", fallbackName: "USS George Washington（乔治·华盛顿号）" }),
    "CVN-73 华盛顿号",
  );
  assert.equal(
    vesselPreferredLabel({ code: "DDG-76", name: "MMSI 111111111", fallbackName: "USS Higgins DDG-76(US GOV VESSEL)" }),
    "USS Higgins DDG-76(US GOV VESSEL)",
  );
});

test("accepts separate roster name fields so future vessels do not need per-vessel label code", () => {
  assert.equal(
    vesselSidebarLabel({ englishName: "SEA HUNTER", chineseName: "海猎号" }),
    "SEA HUNTER（海猎号）",
  );
});

test("uses the ontology-identified Chinese name when the scope only has a placeholder", () => {
  assert.equal(vesselSidebarLabel({ code: "DDG-70", name: "MMSI 367197000", fallbackName: "霍珀" }), "DDG-70 霍珀");
  assert.equal(vesselSidebarLabel({ code: "T-AO-200", name: "MMSI 367219000", fallbackName: "瓜达卢佩" }), "T-AO-200 瓜达卢佩");
  // 新增船只：名单只有 MMSI 占位时，中文名和舷号均可从本体数据自动获得。
  assert.equal(vesselSidebarLabel({ code: "DDG-76", name: "MMSI 111111111", fallbackName: "希金斯" }), "DDG-76 希金斯");
});

test("combines the ontology English name with the scope short name for curated vessels", () => {
  assert.equal(
    vesselSidebarLabel({ code: "CVN-73", name: "华盛顿号", fallbackName: "USS George Washington（乔治·华盛顿号）" }),
    "CVN-73 USS George Washington（华盛顿号）",
  );
  assert.equal(
    vesselSidebarLabel({ code: "CVN-71", name: "罗斯福号", fallbackName: "USS Theodore Roosevelt CVN-71(US GOV VESSEL)" }),
    "USS Theodore Roosevelt CVN-71(US GOV VESSEL)（罗斯福号）",
  );
});

test("falls back to the actually retrieved name when no Chinese name exists", () => {
  // 本体只有英文船名且自带舷号时，直接展示实际获取的名字（已含代号，不重复拼接）。
  assert.equal(
    vesselSidebarLabel({ code: "DDG-76", name: "MMSI 111111111", fallbackName: "USS Higgins DDG-76(US GOV VESSEL)" }),
    "USS Higgins DDG-76(US GOV VESSEL)",
  );
});

test("shows only the code when no actual ship name was retrieved", () => {
  assert.equal(vesselSidebarLabel({ code: "DDG-70", name: "MMSI 367197000" }), "DDG-70");
  assert.equal(vesselSidebarLabel({ code: "DDG-70", name: "MMSI 367197000", fallbackName: "MMSI 367197000" }), "DDG-70");
  assert.equal(vesselSidebarLabel({ code: "CVN-73", name: "MMSI 368913000", fallbackName: "US GOV VESSEL" }), "CVN-73");
  assert.equal(vesselSidebarLabel({ code: "CVN-73", name: "" }), "CVN-73");
  assert.equal(vesselSidebarLabel({ code: "CVN-73", name: null }), "CVN-73");
});

test("keeps the retrieved name as-is when no code is configured", () => {
  assert.equal(vesselSidebarLabel({ code: null, name: "SEASATS 55" }), "SEASATS 55");
  assert.equal(vesselSidebarLabel({ code: "", name: "SD3001" }), "SD3001");
  assert.equal(vesselSidebarLabel({ code: null, name: "海猎号" }), "海猎号");
  assert.equal(vesselSidebarLabel({ name: "MMSI 369970641" }), "MMSI 369970641");
});

test("scope maintains public hull codes and actual retrieved names for identified vessels", () => {
  const expected = {
    "368913000": "CVN-73", "366984000": "CVN-71",
    "368926540": "DDG-118", "369970455": "SSN-750", "368776000": "CG-62", "666966000": "CG-65",
    "338816000": "DDG-65", "367197000": "DDG-70", "303852000": "DDG-83", "368006000": "DDG-86",
    "369933000": "DDG-90", "369939000": "DDG-91",
    "367219000": "T-AO-200", "367860000": "T-AO-199", "367276000": "T-AKE-11", "369914055": "T-AO-207",
  };
  for (const [mmsi, code] of Object.entries(expected)) {
    assert.match(scopeSource, new RegExp(`mmsi: "${mmsi}", code: "${code}"`), `missing code ${code} for ${mmsi}`);
  }
  // 已在本体检索到船名的舰船，名单中不得再保留 MMSI 占位名。
  const named = { "338462016": "SEASATS 33", "338526166": "SEASATS 50", "367197000": "霍珀", "369970455": "纽波特纽斯" };
  for (const [mmsi, name] of Object.entries(named)) {
    assert.match(scopeSource, new RegExp(`mmsi: "${mmsi}".*name: "${name}"`), `stale placeholder name for ${mmsi}`);
  }
  // 本体无任何 AIS 记录的舰船才保留 MMSI 占位名。
  assert.equal((scopeSource.match(/name: "MMSI \d+"/g) || []).length, 5);
});

test("server auto-extracts hull codes from AIS names and prefers scope codes", () => {
  assert.match(serverSource, /code: rows\.map\(\(item\) => extractHullCode\(item\.shipName\)\)\.find\(Boolean\) \?\? null/);
  assert.match(serverSource, /const code = vessel\.code \?\? identityCode \?\? null/);
  assert.match(serverSource, /displayName: code \? vesselPreferredLabel/);
  assert.match(serverSource, /englishName: identityEnglishName \|\| vessel\.englishName/);
  assert.match(serverSource, /chineseName: vessel\.chineseName \|\| identityChineseName/);
});

test("left sidebar renders its dedicated bilingual label and search matches it", () => {
  assert.match(appSource, /<strong>\{target\.sidebarDisplayName \|\| target\.displayName \|\| target\.name\}<\/strong>/);
  assert.match(appSource, /`\$\{target\.sidebarDisplayName \|\| ""\} \$\{target\.displayName \|\| ""\} \$\{target\.name\} \$\{target\.mmsi\}`/);
  assert.match(appSource, /placeholder="代号 \/ 船名 \/ MMSI"/);
});

test("sidebar cache version includes the manual vessel-name override registry", () => {
  assert.match(serverSource, /import \{ VESSEL_NAME_OVERRIDES, getVesselOverride, applyVesselOverride \} from "\.\/vesselNames\.js"/);
  assert.match(serverSource, /overrides: Object\.entries\(VESSEL_NAME_OVERRIDES\)/);
});

test("resize separator exposes the same dynamic maximum width used by the handler", () => {
  assert.match(appSource, /const \[leftPanelBounds, setLeftPanelBounds\] = useState\(\{ min: 240, max: 520 \}\)/);
  assert.match(appSource, /aria-valuemax=\{leftPanelBounds\.max\}/);
});
