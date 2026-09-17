// 全球海域态势地图（主视图）：
// - 本地示意世界轮廓底图（等距圆柱投影，演示资产，非精确地理渲染）
// - 帖子落点散点（平台着色 / EXIF 空心）、目击潮聚类高亮圈（脉冲）、海区网格、热度层
// - 缩放 / 平移 / 点选散点浮层 / 点选聚类下钻 / 空态引导 / 抓取中扫描线
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAP_W, MAP_H, project, radiusToPx } from '../core/geo';
import { LAND_POLYGONS, WATER_OVERLAYS } from '../data/worldOutline';
import { SEA_AREAS } from '../data/seaAreas';
import { fmtDateTime } from '../core/format';

const DEFAULT_VIEW = { x: 0, y: 0, w: MAP_W, h: MAP_H };

function polygonPoints(points) {
  return points.map(([lon, lat]) => project(lon, lat).join(',')).join(' ');
}

export default function WorldMap({ m }) {
  const [view, setView] = useState(DEFAULT_VIEW);
  const [layers, setLayers] = useState({ scatter: true, clusters: true, grid: true, heat: false });
  const [size, setSize] = useState({ w: 800, h: 400 });
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);

  // 容器尺寸（用于 HTML 浮层定位）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  // 滚轮缩放（以光标为中心）
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setView((v) => zoomView(v, e, el));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 地图定位联动（告警条 / 事件下钻 / 帖子定位）
  useEffect(() => {
    const f = m.mapFocus;
    if (!f) return;
    const [cx, cy] = project(f.lon, f.lat);
    const w = Math.min(MAP_W, Math.max(120, (f.spanDeg * 2 / 360) * MAP_W));
    const h = w / 2;
    setView({ x: cx - w / 2, y: cy - h / 2, w, h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.mapFocus && m.mapFocus.ts]);

  const scale = Math.min(size.w / view.w, size.h / view.h);
  const contentW = view.w * scale;
  const contentH = view.h * scale;
  const offX = (size.w - contentW) / 2;
  const offY = (size.h - contentH) / 2;

  const onPointerDown = (e) => {
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, vw: view.w };
    movedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = ((e.clientX - d.px) * d.vw) / Math.max(1, contentW);
    const dy = ((e.clientY - d.py) * d.vw) / Math.max(1, contentW);
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) movedRef.current = true;
    setView((v) => ({
      ...v,
      x: Math.min(MAP_W - 40, Math.max(40 - v.w, d.vx - dx)),
      y: Math.min(MAP_H - 20, Math.max(20 - v.h, d.vy - dy)),
    }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoomBy = (factor) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setView((v) =>
      zoomView(v, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: factor }, el)
    );
  };

  const toggleLayer = (key) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  // 海区帖子计数（网格层标签）
  const areaCounts = useMemo(() => {
    const counts = {};
    for (const p of m.mapPosts) counts[p.seaArea] = (counts[p.seaArea] || 0) + 1;
    return counts;
  }, [m.mapPosts]);

  // 热度网格（15°）
  const heatCells = useMemo(() => {
    if (!layers.heat) return [];
    const cells = new Map();
    for (const p of m.mapPosts) {
      const key = `${Math.floor(p.longitude / 15)}_${Math.floor(p.latitude / 15)}`;
      cells.set(key, (cells.get(key) || 0) + 1);
    }
    const max = Math.max(1, ...cells.values());
    return [...cells.entries()].map(([key, count]) => {
      const [gx, gy] = key.split('_').map(Number);
      const lon = gx * 15;
      const lat = gy * 15;
      const [x, y] = project(lon, lat);
      return {
        x,
        y,
        w: (15 / 360) * MAP_W,
        h: (15 / 180) * MAP_H,
        opacity: 0.1 + 0.3 * (count / max),
        count,
      };
    });
  }, [m.mapPosts, layers.heat]);

  const selectedClusterMemberIds = useMemo(
    () => new Set(m.selectedCluster ? m.selectedCluster.memberPostIds : []),
    [m.selectedCluster]
  );

  // 散点半径与标注字号随缩放级别换算，保持屏幕观感恒定
  const pointR = Math.max(1.5, Math.min(8, view.w * 0.0075));
  const labelFontSize = Math.max(3.5, Math.min(10, view.w * 0.009));
  const ringMin = view.w * 0.03;

  // 浮层像素坐标
  const popupPos = useMemo(() => {
    if (!m.selectedPost || m.selectedPost.latitude == null) return null;
    const [x, y] = project(m.selectedPost.longitude, m.selectedPost.latitude);
    return {
      left: offX + (x - view.x) * scale,
      top: offY + (y - view.y) * scale,
      flip: offY + (y - view.y) * scale < 190,
    };
  }, [m.selectedPost, view, scale, offX, offY]);

  const emptyState = m.mapPosts.length === 0;

  return (
    <section className="panel map-panel">
      <div className="panel-title">
        全球海域态势地图
        <span className="tag">map_primary · 主视图</span>
        <span className="map-count mono">
          落点 {m.mapPosts.length} / 窗口帖 {m.scopePosts.length}（演示数据）
        </span>
      </div>
      <div className="map-canvas" ref={wrapRef}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {/* 海洋底 */}
          <rect x={-40} y={-20} width={MAP_W + 80} height={MAP_H + 40} className="ocean" />

          {/* 30° 主网格线（常显） */}
          <g className="graticule">
            {Array.from({ length: 11 }, (_, i) => -180 + i * 30).map((lon) => {
              const [x] = project(lon, 0);
              return <line key={`gl${lon}`} x1={x} y1={0} x2={x} y2={MAP_H} />;
            })}
            {Array.from({ length: 5 }, (_, i) => -60 + i * 30).map((lat) => {
              const [, y] = project(0, lat);
              return <line key={`gp${lat}`} x1={0} y1={y} x2={MAP_W} y2={y} className={lat === 0 ? 'equator' : ''} />;
            })}
          </g>

          {/* 10° 海区网格 + 海域框（可开关） */}
          {layers.grid && (
            <g className="sea-grid">
              {Array.from({ length: 35 }, (_, i) => -180 + i * 10).map((lon) => {
                const [x] = project(lon, 0);
                return <line key={`sg${lon}`} x1={x} y1={0} x2={x} y2={MAP_H} />;
              })}
              {Array.from({ length: 17 }, (_, i) => -80 + i * 10).map((lat) => {
                const [, y] = project(0, lat);
                return <line key={`sp${lat}`} x1={0} y1={y} x2={MAP_W} y2={y} />;
              })}
              {SEA_AREAS.map((a) => {
                const [x1, y1] = project(a.bbox[0], a.bbox[3]);
                const [x2, y2] = project(a.bbox[2], a.bbox[1]);
                return (
                  <g key={a.id}>
                    <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} className="sea-box" />
                    <text x={x1 + 3} y={y1 + 11} className="sea-label" fontSize={labelFontSize}>
                      {a.name}·{areaCounts[a.name] || 0}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* 热度层 */}
          {layers.heat && (
            <g className="heat-layer">
              {heatCells.map((c, i) => (
                <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} fill="#35c5d8" fillOpacity={c.opacity} />
              ))}
            </g>
          )}

          {/* 陆地（示意底图） */}
          <g className="land">
            {LAND_POLYGONS.map((p) => (
              <polygon key={p.name} points={polygonPoints(p.points)} />
            ))}
            {WATER_OVERLAYS.map((w) => {
              const [cx, cy] = project(w.cx, w.cy);
              const rx = (w.rx / 360) * MAP_W;
              const ry = (w.ry / 180) * MAP_H;
              return <ellipse key={w.name} cx={cx} cy={cy} rx={rx} ry={ry} className="water" />;
            })}
          </g>

          {/* 目击潮聚类高亮圈 */}
          {layers.clusters &&
            m.clusters.map((c) => {
              const [cx, cy] = project(c.centerLongitude, c.centerLatitude);
              const [rx0, ry0] = radiusToPx(Math.max(c.radiusKm, 12), c.centerLatitude);
              const rx = Math.max(rx0, ringMin);
              const ry = Math.max(ry0, ringMin);
              const selected = m.selectedClusterId === c.clusterId;
              const sevCls = c.status === 'dismissed' ? 'dismissed' : c.severity === '紧急' ? 'critical' : c.severity === '关注' ? 'warn' : 'normal';
              return (
                <g
                  key={c.clusterId}
                  className={`cluster-ring ${sevCls} ${selected ? 'selected' : ''} ${c.severity === '紧急' && c.status !== 'dismissed' ? 'pulse' : ''}`}
                  onClick={(e) => {
                    if (movedRef.current) return;
                    e.stopPropagation();
                    m.focusCluster(c);
                  }}
                >
                  <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="ring" />
                  <circle cx={cx} cy={cy} r={Math.max(1.2, ringMin * 0.15)} className="ring-center" />
                  <text x={cx} y={cy - ry - labelFontSize * 0.5} className="ring-label" fontSize={labelFontSize}>
                    #{c.clusterId} {c.seaArea} · {c.accountCount} 账号 · {c.similarityScore}
                  </text>
                </g>
              );
            })}

          {/* 帖子落点散点 */}
          {layers.scatter &&
            m.mapPosts.map((p) => {
              const [x, y] = project(p.longitude, p.latitude);
              const cls = [
                'pt',
                p.platform === 'x' ? 'x' : 'ig',
                p.coordSource === 'exif' ? 'exif' : '',
                m.selectedPostId === p.postId ? 'selected' : '',
                m.activeFalsePositives[p.postId] ? 'fp' : '',
                selectedClusterMemberIds.has(p.postId) ? 'member' : '',
              ].join(' ');
              return (
                <circle
                  key={p.postId}
                  cx={x}
                  cy={y}
                  r={m.selectedPostId === p.postId ? pointR * 1.6 : pointR}
                  className={cls}
                  onClick={(e) => {
                    if (movedRef.current) return;
                    e.stopPropagation();
                    m.selectPost(p.postId);
                  }}
                >
                  <title>
                    {`${p.accountName} · ${p.platform === 'x' ? 'X' : 'Instagram'} · ${p.coordSource === 'gps_tag' ? 'GPS 标签' : '图片 EXIF'}\n${p.content}`}
                  </title>
                </circle>
              );
            })}
        </svg>

        {/* 图层工具栏 */}
        <div className="map-toolbar">
          <button type="button" className={`chip ${layers.scatter ? 'on' : 'off'}`} onClick={() => toggleLayer('scatter')}>
            散点层
          </button>
          <button type="button" className={`chip ${layers.clusters ? 'on' : 'off'}`} onClick={() => toggleLayer('clusters')}>
            聚类高亮层
          </button>
          <button type="button" className={`chip ${layers.grid ? 'on' : 'off'}`} onClick={() => toggleLayer('grid')}>
            海区网格
          </button>
          <button type="button" className={`chip ${layers.heat ? 'on' : 'off'}`} onClick={() => toggleLayer('heat')}>
            热度
          </button>
          {m.runningBatch && <span className="map-polling-tag">批次 {m.runningBatch.batchId} 抓取中…</span>}
        </div>

        {/* 缩放控件 */}
        <div className="zoom-ctl">
          <button type="button" onClick={() => zoomBy(-80)} title="放大">＋</button>
          <button type="button" onClick={() => zoomBy(80)} title="缩小">－</button>
          <button type="button" onClick={() => setView(DEFAULT_VIEW)} title="复位全景">⌖</button>
        </div>

        {/* 图例 */}
        <div className="map-legend">
          <div className="li"><span className="pt-legend x-gps" />X（推特）· GPS 标签</div>
          <div className="li"><span className="pt-legend ig-gps" />Instagram · GPS 标签</div>
          <div className="li"><span className="pt-legend exif" />图片 EXIF 提取（空心）</div>
          <div className="li"><span className="pt-legend cluster" />目击潮聚类高亮</div>
          <div className="li"><span className="pt-legend fp" />已标记误报（淡化）</div>
        </div>

        {/* 演示水印 */}
        <div className="map-demo-tag">演示数据 · 示意底图 · 非真实地理渲染</div>

        {/* 抓取中扫描线 */}
        {m.runningBatch && <div className="map-scanline" />}

        {/* 帖子浮层 */}
        {popupPos && m.selectedPost && (
          <div
            className={`post-popup ${popupPos.flip ? 'flip' : ''}`}
            style={{ left: `${popupPos.left}px`, top: `${popupPos.top}px` }}
          >
            <div className="pp-head">
              <span className="acct">{m.selectedPost.accountName}</span>
              <span className={`plat-tag ${m.selectedPost.platform}`}>{m.selectedPost.platform === 'x' ? 'X' : 'Instagram'}</span>
              <span className="mono">{m.selectedPost.language}</span>
              <button type="button" className="pp-close" onClick={() => m.selectPost(null)}>×</button>
            </div>
            <div className="pp-meta">
              <span className="coord-tag">
                {m.selectedPost.coordSource === 'gps_tag' ? 'GPS 标签' : '图片 EXIF'}{' '}
                {Math.abs(m.selectedPost.latitude).toFixed(2)}°{m.selectedPost.latitude >= 0 ? 'N' : 'S'}{' '}
                {Math.abs(m.selectedPost.longitude).toFixed(2)}°{m.selectedPost.longitude >= 0 ? 'E' : 'W'}
              </span>
              <span className="mono">{fmtDateTime(m.selectedPost.postedAt)}</span>
              <span className="mono">{m.selectedPost.seaArea}</span>
            </div>
            <div className="pp-body">{m.selectedPost.content}</div>
            <div className="pp-kw">
              {m.selectedPost.matchedKeywords.map((k) => (
                <span key={k} className="kw-chip">{k}</span>
              ))}
            </div>
            <div className="pp-actions">
              <button type="button" className="btn-mini ghost" onClick={() => m.markFalsePositive(m.selectedPost)}>
                标记误报
              </button>
              <span className="demo-note">演示数据</span>
            </div>
          </div>
        )}

        {/* 空态引导 */}
        {emptyState && !m.runningBatch && (
          <div className="map-empty">
            <div className="me-title">
              {m.scopePosts.length === 0 ? '当前筛选条件下无命中帖子' : '当前筛选条件下无带坐标帖子'}
            </div>
            <div className="me-sub">
              {m.scopePosts.length === 0
                ? '调整关键词 / 平台 / 时间窗后重新检索；演示数据集覆盖近 24 小时。'
                : `${m.scopePosts.length} 帖未含坐标（GPS 标签与 EXIF 均缺失），已保留于新帖流供人工研判，不计入散点。`}
            </div>
            <div className="me-actions">
              <button type="button" className="btn-mini" onClick={m.widenTimeWindow}>放宽时间窗（近 24 小时）</button>
              <button type="button" className="btn-mini ghost" onClick={m.resetFilters}>清空筛选</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// 统一缩放计算（factor>0 缩小视野=放大画面）
function zoomView(v, e, el) {
  const r = el.getBoundingClientRect();
  const scale = Math.min(r.width / v.w, r.height / v.h);
  const contentW = v.w * scale;
  const contentH = v.h * scale;
  const offX = (r.width - contentW) / 2;
  const offY = (r.height - contentH) / 2;
  const wx = v.x + (e.clientX - r.left - offX) / Math.max(1, scale);
  const wy = v.y + (e.clientY - r.top - offY) / Math.max(1, scale);
  const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
  const w = Math.min(MAP_W, Math.max(80, v.w * factor));
  const f = w / v.w;
  return {
    x: wx - (wx - v.x) * f,
    y: wy - (wy - v.y) * f,
    w,
    h: w / 2,
  };
}
