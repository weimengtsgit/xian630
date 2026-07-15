import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");

test("keeps map area compact and chart drawing area large", () => {
  assert.match(css, /\.map-stack\s*\{\s*grid-template-rows:\s*minmax\(600px,\s*66vh\)\s*auto;/);
  assert.match(css, /\.remote-map-panel\s*\{\s*min-height:\s*600px;/);
  assert.match(css, /\.analysis-line-chart\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
  assert.match(css, /\.analysis-bar-chart\s*\{[^}]*height:\s*260px;/);
});
