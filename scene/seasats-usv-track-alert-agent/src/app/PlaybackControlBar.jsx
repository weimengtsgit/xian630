import React from "react";

const mapModes = [
  { value: "remote", label: "远程球面地图" },
  { value: "local", label: "本地态势地图" },
];

function formatTimestamp(seconds) {
  if (seconds === undefined || seconds === null || seconds === "") return "--";
  const timestamp = Number(seconds);
  if (!Number.isFinite(timestamp)) return "--";

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp * 1000));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
}

export function PlaybackControlBar({
  mapMode = "remote",
  onMapModeChange,
  focusOnly = false,
  onFocusOnlyChange,
  playbackWindow,
  remoteMapUrl,
}) {
  const currentMode = mapMode === "local" ? "local" : "remote";
  const startLabel = formatTimestamp(playbackWindow?.start);
  const endLabel = formatTimestamp(playbackWindow?.end);
  const hasRemoteMapUrl = remoteMapUrl !== undefined && remoteMapUrl !== null && remoteMapUrl !== "";

  return React.createElement(
    "section",
    { className: "playback-control-bar", "aria-label": "回放控制条" },
    React.createElement(
      "div",
      { className: "map-mode-switch", role: "group", "aria-label": "地图模式" },
      mapModes.map((mode) => React.createElement(
        "button",
        {
          key: mode.value,
          type: "button",
          className: `map-mode-option ${currentMode === mode.value ? "is-active" : ""}`,
          "aria-pressed": currentMode === mode.value,
          onClick: () => onMapModeChange?.(mode.value),
        },
        mode.label,
      )),
    ),
    React.createElement(
      "label",
      { className: "focus-only-toggle" },
      React.createElement("input", {
        type: "checkbox",
        checked: Boolean(focusOnly),
        onChange: (event) => onFocusOnlyChange?.(event.currentTarget.checked),
      }),
      React.createElement("span", null, "只看关注舰艇"),
    ),
    React.createElement(
      "div",
      { className: "playback-window", "aria-label": "回放时间范围" },
      React.createElement("span", null, "回放时间：", startLabel, " 至 ", endLabel),
    ),
    hasRemoteMapUrl && React.createElement(
      "a",
      {
        className: "original-map-link",
        href: remoteMapUrl,
        target: "_blank",
        rel: "noreferrer",
      },
      "打开原始地图",
    ),
  );
}

export default PlaybackControlBar;
