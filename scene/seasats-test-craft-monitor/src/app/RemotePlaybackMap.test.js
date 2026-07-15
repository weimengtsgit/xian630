import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".jsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: readFileSync(fileURLToPath(url), "utf8"),
      };
    }

    return nextLoad(url, context);
  },
});

const { RemotePlaybackMap } = await import("./RemotePlaybackMap.jsx");

const selectedTarget = {
  name: "海巡 630",
  mmsi: "413000630",
};

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(RemotePlaybackMap, {
    src: "https://maps.example.test/playback?id=630",
    selectedTarget,
    windowSource: "2026-07-02 08:00 至 10:00",
    ...props,
  }));
}

test("renders iframe with source, title, lazy loading, fullscreen support, and original map link", () => {
  const markup = render({ title: "远程舰艇轨迹回放" });

  assert.match(markup, /<iframe[^>]+src="https:\/\/maps\.example\.test\/playback\?id=630"/);
  assert.match(markup, /<iframe[^>]+title="远程舰艇轨迹回放"/);
  assert.match(markup, /<iframe[^>]+loading="lazy"/);
  assert.match(markup, /<iframe[^>]+allow="fullscreen; geolocation"/);
  assert.match(markup, /<iframe[^>]+sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/);
  assert.match(markup, /<iframe[^>]+referrerPolicy="no-referrer"/);
  assert.match(markup, /<iframe[^>]+allowfullscreen=""/);
  assert.match(markup, /<a[^>]+href="https:\/\/maps\.example\.test\/playback\?id=630"[^>]+target="_blank"[^>]+rel="noreferrer"[^>]*>打开原始地图<\/a>/);
  assert.doesNotMatch(markup, /clipboard/);
});

test("renders selected vessel name, MMSI, and playback time source", () => {
  const markup = render();

  assert.match(markup, /舰艇/);
  assert.match(markup, /海巡 630/);
  assert.match(markup, /413000630/);
  assert.match(markup, /2026-07-02 08:00 至 10:00/);
});

test("does not render bottom local map switch even when callback is provided", () => {
  const markup = render({ onFallback: () => {} });

  assert.doesNotMatch(markup, /<button[^>]+type="button"[^>]*>/);
});

test("renders a local fallback state when map source is missing", () => {
  const markup = render({ src: "", onFallback: () => {} });

  assert.doesNotMatch(markup, /<iframe/);
  assert.doesNotMatch(markup, /打开原始地图/);
  assert.match(markup, /地图地址未生成/);
  assert.doesNotMatch(markup, /<button[^>]+type="button"[^>]*>/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
});

test("loading overlay is announced as status", () => {
  const markup = render();

  assert.match(markup, /正在连接远程回放地图/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
});

test("static markup never uses forbidden wording", () => {
  const markup = render({ onFallback: () => {} });

  assert.doesNotMatch(markup, new RegExp("\\u76ee\\u6807"));
});
