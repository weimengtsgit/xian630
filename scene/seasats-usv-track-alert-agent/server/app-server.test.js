import assert from "node:assert/strict";
import test from "node:test";
// app-server 仅作为主模块运行时才 listen（见文件尾的 import.meta 守卫），import 时不启动服务，
// 因此可在单测中直接引入 sidebarFields，验证登记表覆盖优先级这条 wiring。
import * as appServer from "./app-server.js";
import { getVesselOverride, applyVesselOverride } from "./vesselNames.js";

const { sidebarFields } = appServer;

// 镜像 app-server.js 中 buildFastSummary / buildSummaryFromTracks 的船名解析优先级：
// 登记表覆盖 > 本体名 > (非通用)最新点名 > 名单名 > 最新点名 > MMSI 占位。
function resolveName(vessel, identityName, latestName, registry) {
  const overrideName = getVesselOverride(vessel.mmsi, registry)?.name || null;
  const isGeneric = (n) => /^(?:US\s+GOV(?:ERNMENT)?(?:\s+VESSEL)?|US\s+WARSHIP|WARSHIP|美国政府船只)$/i.test(String(n || "").trim());
  return overrideName || identityName || (latestName && !isGeneric(latestName) ? latestName : vessel.name || latestName || `MMSI ${vessel.mmsi}`);
}

// 复刻服务端构建 target 时的 name / code / displayName 组装（登记表覆盖优先）。
function resolveTarget(vessel, { identityName = null, identityCode = null, latestName = null, registry = {} } = {}) {
  const resolvedName = resolveName(vessel, identityName, latestName, registry);
  const { code, displayName } = sidebarFields(applyVesselOverride(vessel, registry), resolvedName, identityCode);
  return { name: resolvedName, code, displayName };
}

const placeholderVessel = (mmsi) => ({ mmsi, code: null, name: `MMSI ${mmsi}`, shortName: null, role: "候选舰船" });

test("normalizes true heading and course orientation without collapsing the fields", () => {
  const point = appServer.normalizePoint?.({
    mmsi: "123",
    startTime: "2026-08-04T09:00:00",
    longitude: 120,
    latitude: 30,
    sog: 5,
    trueHeading: 511,
    courseOverGround: 148,
  });

  assert.deepEqual(
    { heading: point?.heading, orientation: point?.orientation, courseDeg: point?.courseDeg },
    { heading: 511, orientation: 148, courseDeg: 148 },
  );
});

test("keeps a non-511 true heading even when it is greater than 359", () => {
  const point = appServer.normalizePoint?.({
    mmsi: "456",
    startTime: "2026-08-04T09:00:00",
    trueHeading: 456,
    courseOverGround: 148,
  });

  assert.equal(point?.heading, 456);
  assert.equal(point?.orientation, 148);
});

test("rejects legacy summary snapshots that collapsed heading and orientation", () => {
  const snapshot = {
    metadata: {
      source: "ontology-daas",
      trackWindowStart: "2025-01-01T00:00:00.000Z",
    },
    targets: [{ mmsi: "123" }],
  };

  assert.equal(appServer.summarySnapshotUsable?.(snapshot), false);
  assert.equal(appServer.summarySnapshotUsable?.({
    ...snapshot,
    metadata: { ...snapshot.metadata, headingFieldVersion: "independent-heading-orientation-v1" },
  }), true);
});

test("override supplies code + short name and yields a code-prefixed sidebar label", () => {
  const vessel = placeholderVessel("123");
  const registry = { "123": { code: "DDG-1", name: "真实号", shortName: "真" } };
  assert.deepEqual(resolveTarget(vessel, { registry }), { name: "真实号", code: "DDG-1", displayName: "DDG-1 真" });
});

test("override with name only (no code) keeps name and leaves displayName null", () => {
  const vessel = placeholderVessel("456");
  const registry = { "456": { code: null, name: "US NAVY SUBMARINE", shortName: null } };
  assert.deepEqual(resolveTarget(vessel, { registry }), { name: "US NAVY SUBMARINE", code: null, displayName: null });
});

test("override takes priority over ontology identity name and code", () => {
  const vessel = placeholderVessel("789");
  const registry = { "789": { code: "DDG-2", name: "真实号2", shortName: null } };
  // 本体返回通用占位名 "US GOV VESSEL" 与舷号 "XX"；登记表应优先于两者。
  const out = resolveTarget(vessel, { identityName: "US GOV VESSEL", identityCode: "XX", registry });
  assert.equal(out.name, "真实号2");
  assert.equal(out.code, "DDG-2");
});

test("without an override the resolution is unchanged (keeps MMSI placeholder, ontology name still wins)", () => {
  const vessel = placeholderVessel("123");
  assert.deepEqual(resolveTarget(vessel), { name: "MMSI 123", code: null, displayName: null });
  assert.equal(resolveTarget(vessel, { identityName: "霍珀", identityCode: "DDG-70" }).name, "霍珀");
});
