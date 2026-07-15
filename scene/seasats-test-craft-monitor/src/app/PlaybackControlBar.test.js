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

const { PlaybackControlBar } = await import("./PlaybackControlBar.jsx");

const selectedTarget = {
  name: "海巡 630",
  mmsi: "413000630",
};

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(PlaybackControlBar, {
    mapMode: "remote",
    onMapModeChange: () => {},
    focusOnly: true,
    onFocusOnlyChange: () => {},
    playbackWindow: {
      start: 1782950400,
      end: 1782957600,
      source: "AIS 历史轨迹",
    },
    selectedTarget,
    remoteMapUrl: "https://maps.example.test/playback?id=630",
    ...props,
  }));
}

test("renders map mode switch, focus vessel toggle, playback window, and original map link", () => {
  const markup = render();

  assert.match(markup, /class="[^"]*playback-control-bar/);
  assert.match(markup, /class="[^"]*map-mode-switch/);
  assert.match(markup, /远程球面地图/);
  assert.match(markup, /本地态势地图/);
  assert.match(markup, /只看关注舰艇/);
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /checked=""/);
  assert.match(markup, /海巡 630/);
  assert.match(markup, /413000630/);
  assert.match(markup, /2026-07-02 08:00:00/);
  assert.match(markup, /2026-07-02 10:00:00/);
  assert.match(markup, /AIS 历史轨迹/);
  assert.match(markup, /<a[^>]+href="https:\/\/maps\.example\.test\/playback\?id=630"[^>]*>打开原始地图<\/a>/);
});

test("marks local map mode active and hides original map link when url is missing", () => {
  const markup = render({
    mapMode: "local",
    focusOnly: false,
    remoteMapUrl: "",
  });

  assert.match(markup, /aria-pressed="true"[^>]*>本地态势地图/);
  assert.doesNotMatch(markup, /checked=""/);
  assert.doesNotMatch(markup, /打开原始地图/);
});

test("static markup never uses forbidden wording", () => {
  const markup = render();

  assert.doesNotMatch(markup, new RegExp("\\u76ee\\u6807"));
});
