import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("uses application title in loading and dashboard headers without the Guangyu prefix", () => {
  assert.equal((appSource.match(/无人艇跟监告警智能体/g) || []).length, 2);
  assert.doesNotMatch(appSource, /光鱼/);
});

test("uses document title without the Guangyu prefix", () => {
  assert.match(indexSource, /<title>无人艇跟监告警智能体<\/title>/);
  assert.doesNotMatch(indexSource, /光鱼/);
});
