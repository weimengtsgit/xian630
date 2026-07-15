import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("uses Guangyu branded application title in loading and dashboard headers", () => {
  assert.equal((appSource.match(/“光鱼”无人艇跟监告警智能体/g) || []).length, 2);
  assert.doesNotMatch(appSource, />无人艇跟监告警智能体</);
});

test("uses Guangyu branded document title", () => {
  assert.match(indexSource, /<title>“光鱼”无人艇跟监告警智能体<\/title>/);
});
