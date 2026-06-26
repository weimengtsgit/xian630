import { useMemo } from "react";
import {
  LAND,
  SEA_LABELS,
  MAP_LAT_MIN,
  MAP_LAT_MAX,
  MAP_LON_MIN,
  MAP_LON_MAX,
  project,
} from "./worldGeo.js";

// Global sea-area scatter map rendered as inline SVG.
//
// Two visible layers:
//   1. scatter layer — one dot per geotagged post. Encoding:
//        - PLATFORM: hue (twitter = cyan, instagram = amber) AND shape
//          (twitter = circle, instagram = square)
//        - COORD SOURCE: gps = filled solid, exif = ringed (hollow)
//      Color is NOT the only signal: shape encodes platform, fill-style encodes
//      coord source, and the legend explains both.
//   2. cluster-highlight layer — pulsing rings + label over regions where
//      multiple distinct accounts posted similar content in a short window.
//      Tide clusters render in red, non-tide in amber.

const W = 1000;
const H = 540;

function postGlyph(post, isSelected, onSelectPost) {
  const [x, y] = project(post.lon, post.lat, W, H);
  const isTwitter = post.platform === "twitter";
  const isGps = post.coordSource === "gps";
  const hue = isTwitter ? "#68ddff" : "#f3c761";
  const hueDim = isTwitter ? "rgba(104,221,255,0.9)" : "rgba(243,199,97,0.9)";

  const common = {
    key: post.id,
    onClick: (e) => {
      e.stopPropagation();
      onSelectPost && onSelectPost(post);
    },
    style: { cursor: "pointer" },
    className: "sca-scatter-dot",
  };

  if (isTwitter && isGps) {
    // circle, filled
    return (
      <circle
        {...common}
        cx={x}
        cy={y}
        r={isSelected ? 6.5 : 5}
        fill={hue}
        stroke={isSelected ? "#edfaff" : "rgba(0,0,0,0.5)"}
        strokeWidth={isSelected ? 1.4 : 0.6}
      >
        <title>
          {post.platform} · {post.account} · {post.keyword} ({post.coordSource})
        </title>
      </circle>
    );
  }
  if (isTwitter && !isGps) {
    // circle, ringed (exif)
    return (
      <circle
        {...common}
        cx={x}
        cy={y}
        r={isSelected ? 6.5 : 5}
        fill="rgba(3,17,29,0.9)"
        stroke={hueDim}
        strokeWidth={2}
      >
        <title>
          {post.platform} · {post.account} · {post.keyword} ({post.coordSource})
        </title>
      </circle>
    );
  }
  if (!isTwitter && isGps) {
    // square, filled (instagram)
    const s = isSelected ? 13 : 10;
    return (
      <rect
        {...common}
        x={x - s / 2}
        y={y - s / 2}
        width={s}
        height={s}
        fill={hue}
        stroke={isSelected ? "#edfaff" : "rgba(0,0,0,0.5)"}
        strokeWidth={isSelected ? 1.4 : 0.6}
      >
        <title>
          {post.platform} · {post.account} · {post.keyword} ({post.coordSource})
        </title>
      </rect>
    );
  }
  // instagram + exif: square, ringed
  const s = isSelected ? 13 : 10;
  return (
    <rect
      {...common}
      x={x - s / 2}
      y={y - s / 2}
      width={s}
      height={s}
      fill="rgba(3,17,29,0.9)"
      stroke={hueDim}
      strokeWidth={2}
    >
      <title>
        {post.platform} · {post.account} · {post.keyword} ({post.coordSource})
      </title>
    </rect>
  );
}

function clusterGlyph(cluster, onSelectCluster) {
  const [x, y] = project(cluster.lon, cluster.lat, W, H);
  const isTide = cluster.suspectedSightingTide;
  const color = isTide ? "#ff665e" : "#f3c761";
  // radius in degrees -> approximate pixels (avg of lon/lat scale)
  const rPx = cluster.radiusDeg * 36;

  return (
    <g
      key={cluster.id}
      className="sca-cluster"
      style={{ cursor: "pointer" }}
      onClick={(e) => {
        e.stopPropagation();
        onSelectCluster(cluster);
      }}
    >
      {/* pulsing outer ring */}
      <circle
        className="sca-cluster-pulse"
        cx={x}
        cy={y}
        r={rPx}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        opacity={0.55}
      />
      {/* steady dashed boundary */}
      <circle
        cx={x}
        cy={y}
        r={rPx}
        fill={isTide ? "rgba(255,102,94,0.10)" : "rgba(243,199,97,0.08)"}
        stroke={color}
        strokeWidth={1.2}
        strokeDasharray="4 3"
      />
      {/* center marker */}
      <circle cx={x} cy={y} r={3} fill={color} />
      {/* label */}
      <g className="sca-cluster-label">
        <rect
          x={x + rPx + 4}
          y={y - 22}
          width={isTide ? 132 : 116}
          height={isTide ? 34 : 28}
          fill="rgba(9,24,38,0.92)"
          stroke={color}
          strokeWidth={0.8}
        />
        <text
          x={x + rPx + 9}
          y={y - 9}
          fill={color}
          fontSize={11}
          fontWeight={700}
        >
          {isTide ? "⚠ 疑似目击潮" : "聚合高亮"} {cluster.id}
        </text>
        <text
          x={x + rPx + 9}
          y={y + 4}
          fill="#cfe6f0"
          fontSize={10}
        >
          {cluster.accountCount} 账号 · {cluster.windowMinutes}min
        </text>
        {isTide && (
          <text x={x + rPx + 9} y={y + 16} fill="#ffd0c9" fontSize={10}>
            目击潮
          </text>
        )}
      </g>
    </g>
  );
}

export function WorldMap({
  posts,
  clusters,
  selectedClusterId,
  selectedPostId,
  showScatter,
  showClusters,
  onSelectCluster,
  onSelectPost,
}) {
  const landPaths = useMemo(
    () =>
      LAND.map((land) => {
        const d = land.pts
          .map(([lon, lat], i) => {
            const [x, y] = project(lon, lat, W, H);
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ") + " Z";
        return { name: land.name, d };
      }),
    []
  );

  const seaLabels = useMemo(
    () =>
      SEA_LABELS.map((s) => {
        const [x, y] = project(s.lon, s.lat, W, H);
        return { ...s, x, y };
      }),
    []
  );

  // graticule lines every 30deg
  const grat = useMemo(() => {
    const lines = [];
    for (let lon = MAP_LON_MIN; lon <= MAP_LON_MAX; lon += 30) {
      const [x] = project(lon, 0, W, H);
      lines.push({ key: `v${lon}`, x1: x, y1: 0, x2: x, y2: H });
    }
    for (let lat = MAP_LAT_MIN; lat <= MAP_LAT_MAX; lat += 30) {
      const [, y] = project(0, lat, W, H);
      lines.push({ key: `h${lat}`, x1: 0, y1: y, x2: W, y2: y });
    }
    return lines;
  }, []);

  return (
    <svg
      className="sca-map-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="sca-sea-grad" cx="50%" cy="42%" r="70%">
          <stop offset="0%" stopColor="#0a2438" />
          <stop offset="100%" stopColor="#031020" />
        </radialGradient>
      </defs>

      {/* sea background */}
      <rect x={0} y={0} width={W} height={H} fill="url(#sca-sea-grad)" />

      {/* graticule */}
      <g stroke="rgba(104,221,255,0.08)" strokeWidth={0.5}>
        {grat.map((l) => (
          <line
            key={l.key}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
          />
        ))}
      </g>

      {/* land silhouettes */}
      <g
        fill="rgba(40,82,104,0.62)"
        stroke="rgba(104,221,255,0.34)"
        strokeWidth={0.7}
      >
        {landPaths.map((l) => (
          <path key={l.name} d={l.d} />
        ))}
      </g>

      {/* sea labels */}
      <g
        fill="rgba(143,176,191,0.5)"
        fontSize={10}
        fontStyle="italic"
        textAnchor="middle"
      >
        {seaLabels.map((s) => (
          <text key={s.name} x={s.x} y={s.y}>
            {s.name}
          </text>
        ))}
      </g>

      {/* cluster-highlight layer (rendered UNDER scatter so dots sit on top) */}
      {showClusters &&
        clusters.map((c) => clusterGlyph(c, onSelectCluster))}

      {/* scatter layer */}
      {showScatter &&
        posts.map((p) =>
          postGlyph(p, p.id === selectedPostId, onSelectPost)
        )}
    </svg>
  );
}
