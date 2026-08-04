import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");

test("map fills the viewport-bounded workspace and charts stay large", () => {
  assert.match(css, /\.map-stack\s*\{\s*grid-template-rows:\s*minmax\(360px,\s*1fr\)\s*auto;/);
  assert.match(css, /\.remote-map-panel\s*\{\s*min-height:\s*360px;/);
  assert.match(css, /\.analysis-line-chart\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
  assert.match(css, /\.analysis-bar-chart\s*\{[^}]*height:\s*280px;/);
});
