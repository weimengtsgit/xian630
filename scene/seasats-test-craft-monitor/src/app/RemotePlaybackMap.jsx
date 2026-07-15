import React, { useEffect, useState } from "react";

const defaultTitle = "远程轨迹回放地图";
const slowConnectionDelayMs = 8000;

function textOrFallback(value, fallback) {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function vesselName(selectedTarget) {
  return textOrFallback(
    selectedTarget?.name ?? selectedTarget?.vesselName ?? selectedTarget?.shipName,
    "未选择舰艇",
  );
}

function vesselMmsi(selectedTarget) {
  return textOrFallback(selectedTarget?.mmsi ?? selectedTarget?.MMSI, "未知 MMSI");
}

export function RemotePlaybackMap({
  src,
  title = defaultTitle,
  selectedTarget,
  windowSource,
}) {
  const [status, setStatus] = useState("loading");
  const frameTitle = textOrFallback(title, defaultTitle);
  const sourceLabel = textOrFallback(windowSource, "未提供回放时间来源");
  const hasMapSource = src !== undefined && src !== null && src !== "";
  const showOverlay = status !== "loaded";
  const overlayText = !hasMapSource
    ? "地图地址未生成，可查看本地地图"
    : status === "slow"
      ? "连接较慢，可新窗口打开原始地图"
      : "正在连接远程回放地图";

  useEffect(() => {
    if (!hasMapSource) {
      setStatus("empty");
      return undefined;
    }
    setStatus("loading");
    const timer = setTimeout(() => {
      setStatus((current) => (current === "loaded" ? current : "slow"));
    }, slowConnectionDelayMs);

    return () => clearTimeout(timer);
  }, [hasMapSource, src]);

  return React.createElement(
    "section",
    {
      className: "remote-map-panel",
      style: {
        display: "grid",
        gap: "12px",
      },
    },
    React.createElement(
      "header",
      { className: "remote-map-header" },
      React.createElement("h2", null, frameTitle),
      React.createElement(
        "div",
        { className: "remote-map-summary", "aria-label": "所选舰艇摘要" },
        React.createElement("span", null, "舰艇：", vesselName(selectedTarget)),
        React.createElement("span", null, "MMSI：", vesselMmsi(selectedTarget)),
        React.createElement("span", null, "回放时间来源：", sourceLabel),
      ),
    ),
    React.createElement(
      "div",
      {
        className: "remote-map-frame-wrap",
        style: {
          minHeight: "360px",
          position: "relative",
          border: "1px solid #cbd5e1",
        },
      },
      hasMapSource && React.createElement("iframe", {
        className: "remote-map-frame",
        src,
        title: frameTitle,
        loading: "lazy",
        allow: "fullscreen; geolocation",
        allowFullScreen: true,
        sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
        referrerPolicy: "no-referrer",
        onLoad: () => setStatus("loaded"),
        style: {
          border: 0,
          display: "block",
          height: "100%",
          minHeight: "360px",
          width: "100%",
        },
      }),
      showOverlay && React.createElement(
        "div",
        {
          className: `remote-map-overlay remote-map-overlay-${status}`,
          role: "status",
          "aria-live": "polite",
          style: {
            alignItems: "center",
            background: "rgba(248, 250, 252, 0.88)",
            display: "flex",
            inset: 0,
            justifyContent: "center",
            padding: "16px",
            position: "absolute",
            textAlign: "center",
          },
        },
        overlayText,
      ),
    ),
    hasMapSource && React.createElement(
      "div",
      { className: "remote-map-actions" },
      React.createElement(
        "a",
        {
          className: "remote-map-original-link",
          href: src,
          target: "_blank",
          rel: "noreferrer",
        },
        "打开原始地图",
      ),
    ),
  );
}

export default RemotePlaybackMap;
