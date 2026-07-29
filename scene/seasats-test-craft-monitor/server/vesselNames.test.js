import assert from "node:assert/strict";
import test from "node:test";
import { VESSEL_NAME_OVERRIDES, resolveOverride, getVesselOverride, applyVesselOverride } from "./vesselNames.js";

test("resolveOverride returns null for missing or empty-only entries", () => {
  assert.equal(resolveOverride("999999999", {}), null);
  assert.equal(resolveOverride("999999999"), null);
  // name/code 均空的占位条目不生效。
  assert.equal(resolveOverride("123", { "123": { code: null, name: null, shortName: null } }), null);
  assert.equal(resolveOverride("123", { "123": { code: "  ", name: "  ", shortName: "  " } }), null);
});

test("resolveOverride returns trimmed values for a filled entry", () => {
  assert.deepEqual(
    resolveOverride("123", { "123": { code: "DDG-1", name: "测试号", shortName: "测试" } }),
    { name: "测试号", code: "DDG-1", shortName: "测试" },
  );
  // 仅登记船名（无舷号）也生效。
  assert.deepEqual(
    resolveOverride("123", { "123": { code: null, name: "海猎号", shortName: null } }),
    { name: "海猎号", code: null, shortName: null },
  );
  // 去除首尾空白。
  assert.deepEqual(
    resolveOverride("123", { "123": { code: "  CVN-1  ", name: "  华盛顿号  ", shortName: null } }),
    { name: "华盛顿号", code: "CVN-1", shortName: null },
  );
});

test("getVesselOverride returns null for the current empty placeholder MMSIs", () => {
  for (const mmsi of Object.keys(VESSEL_NAME_OVERRIDES)) {
    assert.equal(getVesselOverride(mmsi), null, `expected no override for ${mmsi} until filled in`);
  }
});

test("applyVesselOverride leaves unregistered vessels unchanged by reference", () => {
  const vessel = { mmsi: "999999999", code: "DDG-99", name: "测试", shortName: null, role: "候选舰船" };
  assert.equal(applyVesselOverride(vessel), vessel);
});

test("applyVesselOverride merges a filled override over the roster entry", () => {
  const registry = { "123": { code: "DDG-1", name: "真实号", shortName: "真" } };
  const vessel = { mmsi: "123", code: null, name: "MMSI 123", shortName: null, role: "候选舰船" };
  const merged = applyVesselOverride(vessel, registry);
  assert.deepEqual(merged, { mmsi: "123", code: "DDG-1", name: "真实号", shortName: "真", role: "候选舰船" });
  // 保留登记表缺失字段时回退到原名单值。
  const partial = applyVesselOverride({ mmsi: "123", code: "OLD", name: "旧名", shortName: "旧短", role: "候选舰船" }, { "123": { code: null, name: "新名", shortName: null } });
  assert.deepEqual(partial, { mmsi: "123", code: "OLD", name: "新名", shortName: "旧短", role: "候选舰船" });
});
