import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Ship, MapPin, Camera, Clock, Layers, Waves } from "lucide-react";
import { WorldMap } from "./WorldMap.jsx";
import {
  buildPayload,
  computeClusters,
  makeNewPost,
  LANGUAGES,
} from "../data/mock.js";

const DEMO_TICK_MS = 7000; // local demo tick (mock crawl cadence is 15 min)
const CADENCE_MIN = 15;

function fmtTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function platformLabel(p) {
  return p === "twitter" ? "Twitter" : "Instagram";
}

function coordSourceMeta(s) {
  if (s === "gps") {
    return { cls: "gps", label: "GPS 标签", Icon: MapPin };
  }
  return { cls: "exif", label: "图片 EXIF", Icon: Camera };
}

function langLabel(code) {
  const f = LANGUAGES.find((l) => l.code === code);
  return f ? f.label : code;
}

function PostRow({ post, isNew }) {
  const src = coordSourceMeta(post.coordSource);
  return (
    <div className={`sca-post ${isNew ? "new" : ""}`}>
      <span className={`pf ${post.platform}`}>
        <Radio size={12} />
        {platformLabel(post.platform)}
      </span>
      <span className="acct" title={post.account}>
        {post.account}
      </span>
      <span className="lang">{langLabel(post.language)}</span>
      <span className="kw">命中：{post.keyword}</span>
      <span className={`src ${src.cls}`}>
        <src.Icon size={12} />
        {src.label}
      </span>
      <time>{fmtTime(post.time)}</time>
      <span className="txt" title={post.text}>
        {post.text} · <em style={{ color: "#7ea4b5" }}>{post.similarSummary}</em>
      </span>
    </div>
  );
}

function ClusterCard({ cluster, selected, onSelect }) {
  const tide = cluster.suspectedSightingTide;
  return (
    <article
      className={`sca-cluster-card ${tide ? "tide" : ""} ${
        selected ? "selected" : ""
      }`}
      onClick={() => onSelect(cluster)}
    >
      <header>
        <span className="name">{cluster.regionName}</span>
        <span className="cid">{cluster.id}</span>
      </header>
      <span className={`tide-tag ${tide ? "" : "no"}`}>
        {tide ? "⚠ 疑似目击潮" : "聚合高亮（未达目击潮阈值）"}
      </span>
      <dl className="metrics">
        <div className="metric">
          <dt>不同账号数</dt>
          <dd>{cluster.accountCount}</dd>
        </div>
        <div className="metric">
          <dt>帖子数</dt>
          <dd>{cluster.postCount}</dd>
        </div>
        <div className="metric">
          <dt>时间窗口</dt>
          <dd>
            {fmtTime(cluster.timeWindowStart)} → {fmtTime(cluster.timeWindowEnd)}
            <br />
            （{cluster.windowMinutes} 分钟）
          </dd>
        </div>
        <div className="metric">
          <dt>涉及语言</dt>
          <dd>{cluster.languages.map(langLabel).join(" / ")}</dd>
        </div>
      </dl>
      <div className="kw">
        {cluster.keywords.map((k) => (
          <span key={k}>{k}</span>
        ))}
      </div>
      <p className={`hint ${tide ? "tide" : ""}`}>{cluster.hint}</p>
    </article>
  );
}

export function App() {
  const initial = useMemo(() => buildPayload(), []);
  const [posts, setPosts] = useState(initial.posts);
  // Clusters are a DERIVED view of the current posts — recomputed on every
  // posts change (incl. each demo tick). This restores the "抓取新帖 → 自动聚合
  // → 高亮" loop: a new post landing in a cluster's sea-area/time window
  // visibly grows that cluster (accountCount/postCount/timeWindow/highlight).
  const clusters = useMemo(() => computeClusters(posts), [posts]);
  // Selection is by cluster index, not id — cluster ids are regenerated each
  // tick, so a stale id would silently deselect. Default to the 目击潮 cluster
  // (index 0, since computeClusters sorts tide-first) if the index is gone.
  const [selectedClusterIdx, setSelectedClusterIdx] = useState(0);
  const safeSelectedIdx =
    selectedClusterIdx < clusters.length ? selectedClusterIdx : 0;
  const selectedClusterId = clusters[safeSelectedIdx]?.id;
  const [selectedPostId, setSelectedPostId] = useState(null);
  const [lastFetchAt, setLastFetchAt] = useState(initial.lastFetchAt);
  const [newPostIds, setNewPostIds] = useState(() => new Set());
  const [showScatter, setShowScatter] = useState(true);
  const [showClusters, setShowClusters] = useState(true);
  const [now, setNow] = useState(() => new Date().toISOString());

  const streamRef = useRef(null);

  // Local demo tick: every DEMO_TICK_MS the mock crawl "fires", prepends a new
  // post to the stream and advances the last-fetch clock. The UI keeps showing
  // the customer cadence "每 15 分钟抓取一次新帖" verbatim.
  useEffect(() => {
    const id = setInterval(() => {
      const fetchedAt = new Date(
        Math.max(Date.now(), new Date(lastFetchAt).getTime() + 1000)
      ).toISOString();
      const post = makeNewPost(fetchedAt);
      setPosts((prev) => [post, ...prev].slice(0, 120));
      setLastFetchAt(fetchedAt);
      setNewPostIds((prev) => {
        const next = new Set(prev);
        next.add(post.id);
        // keep only recent "new" markers bounded
        if (next.size > 6) {
          const arr = Array.from(next);
          arr.slice(0, arr.length - 6).forEach((k) => next.delete(k));
        }
        return next;
      });
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // wall clock for countdown display
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(id);
  }, []);

  // countdown to next fetch (display-only; real cadence is 15 min)
  const secondsLeft = useMemo(() => {
    const elapsed = (Date.parse(now) - Date.parse(lastFetchAt)) / 1000;
    const left = Math.max(0, CADENCE_MIN * 60 - elapsed);
    return Math.ceil(left);
  }, [now, lastFetchAt]);

  const selectedCluster = useMemo(
    () => clusters[safeSelectedIdx],
    [clusters, safeSelectedIdx]
  );

  const platformCounts = useMemo(() => {
    const c = { twitter: 0, instagram: 0 };
    posts.forEach((p) => {
      c[p.platform] = (c[p.platform] || 0) + 1;
    });
    return c;
  }, [posts]);

  const coordCounts = useMemo(() => {
    const c = { gps: 0, exif: 0 };
    posts.forEach((p) => {
      c[p.coordSource] = (c[p.coordSource] || 0) + 1;
    });
    return c;
  }, [posts]);

  const langInUse = useMemo(() => {
    const codes = new Set(posts.map((p) => p.language));
    return LANGUAGES.filter((l) => codes.has(l.code)).map((l) => l.label);
  }, [posts]);

  const tideCount = clusters.filter((c) => c.suspectedSightingTide).length;

  return (
    <div className="sca-shell">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sca-topbar">
        <div className="sca-title">
          <Ship size={20} color="#68ddff" />
          <h1>开源社区异常监测</h1>
          <span className="sca-sub">社媒海上目击聚合告警地图</span>
        </div>

        <div className="sca-cadence">
          <span className="pulse" />
          <span>每 15 分钟抓取一次新帖</span>
          <span style={{ color: "#7893a2", fontWeight: 400 }}>
            下次抓取倒计时 {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, "0")}
          </span>
        </div>

        <div className="sca-status">
          <span className="mock-badge">mock</span>
          <span className="src">
            源：{initial.source} · Twitter + Instagram
          </span>
          <span className="status-item">
            <Clock size={12} />
            最近抓取 <time>{fmtTime(lastFetchAt)}</time>
          </span>
        </div>
      </header>

      {/* ── Main board ──────────────────────────────────────────────── */}
      <main className="sca-main">
        {/* Map */}
        <section className="sca-map-wrap">
          <WorldMap
            posts={posts}
            clusters={clusters}
            selectedClusterId={selectedClusterId}
            selectedPostId={selectedPostId}
            showScatter={showScatter}
            showClusters={showClusters}
            onSelectCluster={(c) => {
              const idx = clusters.findIndex((cl) => cl.id === c.id);
              if (idx >= 0) setSelectedClusterIdx(idx);
            }}
            onSelectPost={(p) => setSelectedPostId(p.id)}
          />

          {/* Legend — explains BOTH encodings */}
          <div className="sca-legend">
            <h3>图例 / Legend</h3>

            <div className="grp">
              <div className="lbl">平台 Platform（色相 + 形状）</div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <circle cx="8" cy="8" r="5" fill="#68ddff" />
                  </svg>
                </span>
                <span style={{ color: "#68ddff" }}>Twitter（圆形）</span>
              </div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <rect
                      x="3"
                      y="3"
                      width="10"
                      height="10"
                      fill="#f3c761"
                    />
                  </svg>
                </span>
                <span style={{ color: "#f3c761" }}>Instagram（方形）</span>
              </div>
            </div>

            <div className="grp">
              <div className="lbl">坐标来源 Coord Source（填充样式）</div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <circle cx="8" cy="8" r="5" fill="#68ddff" />
                  </svg>
                </span>
                <span style={{ color: "#7feb9b" }}>GPS 标签（实心）</span>
              </div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <circle
                      cx="8"
                      cy="8"
                      r="5"
                      fill="rgba(3,17,29,0.9)"
                      stroke="#68ddff"
                      strokeWidth="2"
                    />
                  </svg>
                </span>
                <span style={{ color: "#f3c761" }}>图片 EXIF（空心环）</span>
              </div>
            </div>

            <div className="grp">
              <div className="lbl">聚合高亮 Cluster</div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <circle
                      cx="8"
                      cy="8"
                      r="5"
                      fill="none"
                      stroke="#ff665e"
                      strokeWidth="1.5"
                      strokeDasharray="2 1.5"
                    />
                  </svg>
                </span>
                <span style={{ color: "#ff665e" }}>疑似目击潮</span>
              </div>
              <div className="row">
                <span className="swatch">
                  <svg width="16" height="16">
                    <circle
                      cx="8"
                      cy="8"
                      r="5"
                      fill="none"
                      stroke="#f3c761"
                      strokeWidth="1.5"
                      strokeDasharray="2 1.5"
                    />
                  </svg>
                </span>
                <span style={{ color: "#f3c761" }}>聚合（未达目击潮）</span>
              </div>
            </div>
          </div>

          {/* Layer toggle */}
          <div className="sca-layers">
            <span className="lbl">
              <Layers size={11} style={{ verticalAlign: "-2px" }} /> 图层
            </span>
            <button
              className={showScatter ? "active" : ""}
              onClick={() => setShowScatter((v) => !v)}
            >
              <span
                className="led"
                style={{ background: showScatter ? "#68ddff" : "#3a5563" }}
              />
              散点层 Scatter
            </button>
            <button
              className={showClusters ? "active" : ""}
              onClick={() => setShowClusters((v) => !v)}
            >
              <span
                className="led"
                style={{ background: showClusters ? "#ff665e" : "#3a5563" }}
              />
              聚合高亮 Cluster
            </button>
          </div>
        </section>

        {/* Cluster detail panel */}
        <aside className="sca-cluster-panel">
          <div className="sca-panel-head">
            <h2>
              <Waves size={14} style={{ verticalAlign: "-2px" }} /> 聚合 / 目击潮详情
            </h2>
            <span className="pick">
              {clusters.length} 个聚合 · {tideCount} 疑似目击潮
            </span>
          </div>
          <div className="sca-cluster-list">
            {clusters.map((c, idx) => (
              <ClusterCard
                key={idx}
                cluster={c}
                selected={idx === safeSelectedIdx}
                onSelect={() => setSelectedClusterIdx(idx)}
              />
            ))}
            {selectedCluster && (
              <div
                style={{
                  marginTop: "auto",
                  padding: "8px 10px",
                  borderTop: "1px solid rgba(104,221,255,0.18)",
                  color: "#8fb0bf",
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: "#edfaff" }}>选中：</strong>
                {selectedCluster.regionName}
                <br />
                状态判定依据：{selectedCluster.accountCount} 个不同账号 ·{" "}
                {selectedCluster.windowMinutes} 分钟窗口 · 关键词相似度达标
                {selectedCluster.suspectedSightingTide
                  ? " · 含航母/大型舰艇关键词 → 目击潮"
                  : " · 未达目击潮阈值"}
              </div>
            )}
          </div>
        </aside>

        {/* New-post stream */}
        <section className="sca-stream">
          <div className="sca-stream-head">
            <h2>新帖流 / New Post Stream</h2>
            <span className="meta">
              共 {posts.length} 条 · Twitter {platformCounts.twitter} · Instagram{" "}
              {platformCounts.instagram} · GPS {coordCounts.gps} · EXIF{" "}
              {coordCounts.exif} · 语言 {langInUse.join(" / ")}
            </span>
          </div>
          <div className="sca-stream-list" ref={streamRef}>
            {posts.map((p) => (
              <PostRow
                key={p.id}
                post={p}
                isNew={newPostIds.has(p.id)}
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
