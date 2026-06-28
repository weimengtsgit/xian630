// Mock / demo data provider for the 社媒海上目击聚合告警地图 board.
//
// This module is the ONLY data source for the preset app. It returns a payload
// shaped for future social-search / ingest adapters (Twitter & Instagram public
// search, GPS geotag + image EXIF coordinate extraction, cluster aggregation).
// NO real API, no scraping, no fetch, no keys, no backend. The dashboard owns
// a local demo tick that prepends synthetic "new posts" and advances the
// last-fetch clock, while the UI keeps showing the customer cadence
// "每 15 分钟抓取一次新帖".

// Customer keyword set, provided in multiple languages (中/英/日/俄).
// The dashboard shows which languages are in use. The `keyword` on each post
// is the term that matched during the (mocked) search.
export const KEYWORDS = [
  { term: "航母", lang: "zh" },
  { term: "carrier", lang: "en" },
  { term: "空母", lang: "ja" },
  { term: "авианосец", lang: "ru" },
  { term: "军舰", lang: "zh" },
  { term: "warship", lang: "en" },
  { term: "軍艦", lang: "ja" },
  { term: "大船", lang: "zh" },
  { term: "large ship", lang: "en" },
  { term: "海上", lang: "zh" },
  { term: "at sea", lang: "en" },
  { term: "海上", lang: "ja" },
];

export const LANGUAGES = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ru", label: "Русский" },
];

const MIN = 60 * 1000;

// id helper
let _seq = 1000;
const nextId = (prefix) => `${prefix}-${++_seq}`;

// Seed posts span: BOTH platforms (twitter/instagram), MULTIPLE languages,
// customer keywords + translations, BOTH coordinate sources (gps/exif), spread
// across global sea areas, with at least one tight cluster (multiple accounts,
// same sea area, short window) flagged as a suspected 目击潮.
// Seed posts are anchored on `anchor` (default: build time). Using a build-time
// now (not a fixed date) keeps seed posts and the demo tick's real-`Date.now()`
// new posts on the SAME clock, so new posts land inside the cluster time window
// and the 目击潮 cluster actually grows as the demo ticks.
function seedPosts(anchor = Date.now()) {
  // fmt(minAgo) -> ISO string relative to anchor (recent past)
  const t = (minAgo) => new Date(anchor - minAgo * MIN).toISOString();

  return [
    // ── Cluster C1: 东海 / Philippines Sea — suspected 目击潮 ──────────────
    // Multiple DISTINCT accounts, SAME sea area (tight), SHORT time window,
    // similar keyword (carrier/航母). This is the sighting-tide cluster.
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@kuro_shio_watch",
      language: "zh",
      keyword: "航母",
      coordSource: "gps",
      lat: 27.5,
      lon: 134.2,
      text: "刚才在港口外海看到一艘超大的平顶船经过，甲板上全是飞机 #航母",
      time: t(4),
      similarSummary: "与同海域 5 个账号在 40 分钟内发布相似航母目击内容",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "pacific_lens",
      language: "en",
      keyword: "carrier",
      coordSource: "exif",
      lat: 27.7,
      lon: 134.5,
      text: "Huge flattop transiting the horizon this morning, flight deck fully loaded #carrier",
      time: t(9),
      similarSummary: "与同海域 5 个账号在 40 分钟内发布相似航母目击内容",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@fleet_observer_jp",
      language: "ja",
      keyword: "空母",
      coordSource: "gps",
      lat: 27.4,
      lon: 133.9,
      text: "今朝、外洋を巨大な空母が通過。甲板に艦載機が並んでいる #空母",
      time: t(15),
      similarSummary: "与同海域 5 个账号在 40 分钟内发布相似航母目击内容",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "sea_breeze_07",
      language: "zh",
      keyword: "大船",
      coordSource: "exif",
      lat: 27.6,
      lon: 134.3,
      text: " ferry 上拍到的，真的是好大一艘船，甲板好长 #大船",
      time: t(22),
      similarSummary: "与同海域 5 个账号在 40 分钟内发布相似航母目击内容",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@open_source_navy",
      language: "en",
      keyword: "carrier",
      coordSource: "gps",
      lat: 27.8,
      lon: 134.6,
      text: "Possible CVN transit south of the ridge, confirm via imagery metadata #carrier",
      time: t(31),
      similarSummary: "与同海域 5 个账号在 40 分钟内发布相似航母目击内容",
    },

    // ── Cluster C2: Mediterranean — second cluster (warship, NOT tide) ─────
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@med_mariner",
      language: "en",
      keyword: "warship",
      coordSource: "exif",
      lat: 35.2,
      lon: 18.7,
      text: "Warship group east of Sicily, taken from the ferry deck #warship",
      time: t(58),
      similarSummary: "同海域 3 个账号在 90 分钟内发布军舰相关内容",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "sicilia_coast",
      language: "it",
      keyword: "warship",
      coordSource: "gps",
      lat: 35.4,
      lon: 19.1,
      text: "Navi militari a est della Sicilia stamattina #warship",
      time: t(74),
      similarSummary: "同海域 3 个账号在 90 分钟内发布军舰相关内容",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@osint_med",
      language: "en",
      keyword: "warship",
      coordSource: "exif",
      lat: 35.1,
      lon: 18.4,
      text: "Three-ship naval formation, EXIF confirms location off Malta #warship",
      time: t(91),
      similarSummary: "同海域 3 个账号在 90 分钟内发布军舰相关内容",
    },

    // ── Spread: other global sea-area sightings (loners / sparse) ──────────
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@bering_watch",
      language: "ru",
      keyword: "авианосец",
      coordSource: "gps",
      lat: 58.3,
      lon: -174.1,
      text: "Большой корабль к югу от Алеутских островов, фото с геотегом #авианосец",
      time: t(120),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "aleutian_wind",
      language: "en",
      keyword: "at sea",
      coordSource: "exif",
      lat: 55.9,
      lon: -169.8,
      text: "Rough seas today, huge silhouette on the horizon #atsea",
      time: t(140),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@horn_of_africa",
      language: "en",
      keyword: "warship",
      coordSource: "gps",
      lat: 11.6,
      lon: 48.3,
      text: "Warship escort near Bab-el-Mandeb, geotag from port side #warship",
      time: t(165),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "aden_sailor",
      language: "ja",
      keyword: "海上",
      coordSource: "exif",
      lat: 12.8,
      lon: 47.5,
      text: "アデン湾は今日も船が多い、写真のEXIFに位置が残っていた #海上",
      time: t(190),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@south_china_sea",
      language: "zh",
      keyword: "军舰",
      coordSource: "exif",
      lat: 14.2,
      lon: 115.8,
      text: "南沙附近看到军舰编队航行，照片元数据带了坐标 #军舰",
      time: t(210),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "reef_sailor",
      language: "en",
      keyword: "large ship",
      coordSource: "gps",
      lat: 10.1,
      lon: 110.5,
      text: "Large ship anchoring near the reef, GPS tag on the post #largeship",
      time: t(235),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@north_atlantic",
      language: "ru",
      keyword: "大船",
      coordSource: "gps",
      lat: 60.2,
      lon: -22.5,
      text: "К югу от Исландии замечено большое судно, геотег подтверждает #大船",
      time: t(260),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "instagram",
      account: "arctic_lens",
      language: "en",
      keyword: "carrier",
      coordSource: "exif",
      lat: 71.4,
      lon: 25.7,
      text: "Flat-top vessel in the Arctic passage, EXIF places it off Norway #carrier",
      time: t(285),
      similarSummary: "暂无同海域聚合",
    },
    {
      id: nextId("p"),
      platform: "twitter",
      account: "@indian_ocean_osint",
      language: "en",
      keyword: "at sea",
      coordSource: "exif",
      lat: -7.9,
      lon: 72.4,
      text: "Naval traffic in the central Indian Ocean, metadata confirms position #atsea",
      time: t(310),
      similarSummary: "暂无同海域聚合",
    },
  ];
}

// ── Dynamic clustering ─────────────────────────────────────────────────
// Clusters are now a DERIVED view of the posts array: any new post landing
// inside a group's sea-area / time window must visibly grow that group.
// `computeClusters(posts, opts)` is pure — same input ⇒ same output — so the
// demo tick recomputing on each `setPosts` keeps the "抓取新帖 → 自动聚合 →
// 高亮" loop live. `buildPayload` also calls it, so clusters have a single
// source of truth (posts).

// Carrier-related keyword stems — presence in a qualifying group raises it to
// a suspected 目击潮 (sighting tide). Matches the customer 口径 carrier terms
// across the supported languages.
const CARRIER_KEYWORDS = new Set(["航母", "carrier", "空母", "авианосец"]);

// Tunables (exposed via opts so callers/tests can probe).
const DEFAULTS = {
  radiusDeg: 1.5, // ~1.5 deg lat/lon ≈ tight sea-area grouping
  clusterWindowMin: 90, // posts must all fall within this many minutes of the newest
  minAccounts: 2, // a cluster needs ≥ this many distinct accounts
  minAccountsTide: 3, // a 目击潮 needs ≥ this many distinct accounts + a carrier keyword
};

// Keyword similarity: two keywords are "similar" if one is carrier-related and
// the other is too, OR they share the same normalized term. Carrier-class
// (航母/carrier/空母/авианосец) and big-ship-class (大船/large ship) are treated
// as one sighting family; warship-class (军舰/warship/軍艦) as another; generic
// sea-class (海上/at sea) only groups with itself.
function keywordFamily(kw) {
  if (CARRIER_KEYWORDS.has(kw)) return "carrier";
  if (kw === "大船" || kw === "large ship") return "bigship";
  if (kw === "军舰" || kw === "warship" || kw === "軍艦") return "warship";
  if (kw === "海上" || kw === "at sea") return "sea";
  return kw; // fallback: exact term
}
function keywordsSimilar(a, b) {
  const fa = keywordFamily(a);
  const fb = keywordFamily(b);
  if (fa === fb) return true;
  // carrier + bigship co-occur in the same sighting (deck full of planes +
  // "huge ship") — group them, mirroring the seed 目击潮 (航母 + 大船 + carrier).
  if (
    (fa === "carrier" && fb === "bigship") ||
    (fa === "bigship" && fb === "carrier")
  )
    return true;
  return false;
}

// Cheap sea-area label for a derived cluster, keyed off the centroid lat/lon.
// Keeps the same two region names the static clusters used so the first
// viewport is unchanged.
function regionNameFor(lat, lon) {
  if (lat > 26 && lat < 29 && lon > 132 && lon < 136) {
    return "菲律宾海北部 / North Philippine Sea";
  }
  if (lat > 34 && lat < 37 && lon > 16 && lon < 21) {
    return "西西里岛以东 / East of Sicily";
  }
  if (lat > 56 && lat < 60 && lon > -176 && lon < -168) {
    return "阿留申群岛以南海域 / South of Aleutians";
  }
  if (lat > 69 && lat < 73 && lon > 23 && lon < 28) {
    return "北极航道 / Arctic Passage";
  }
  if (lat > 10 && lat < 14 && lon > 46 && lon < 50) {
    return "亚丁湾 / Gulf of Aden";
  }
  if (lat > 8 && lat < 16 && lon > 108 && lon < 118) {
    return "南海 / South China Sea";
  }
  if (lat < 0 && lon > 68 && lon < 76) {
    return "中印度洋 / Central Indian Ocean";
  }
  if (lat > 58 && lat < 62 && lon > -25 && lon < -20) {
    return "冰岛以南海域 / South of Iceland";
  }
  return `${lat.toFixed(1)}°, ${lon.toFixed(1)}° 海域`;
}

// Build the cluster object the UI already consumes (shape is unchanged).
function buildCluster(group, index, opts) {
  const times = group.map((p) => Date.parse(p.time)).filter(Number.isFinite);
  const tEnd = times.length ? Math.max(...times) : Date.now();
  const tStart = times.length ? Math.min(...times) : tEnd;
  const windowMinutes = Math.max(
    0,
    Math.round((tEnd - tStart) / MIN)
  );

  const accounts = new Set(group.map((p) => p.account));
  const accountCount = accounts.size;
  const postCount = group.length;

  // centroid
  const lat = group.reduce((s, p) => s + p.lat, 0) / group.length;
  const lon = group.reduce((s, p) => s + p.lon, 0) / group.length;

  // deduped facets (preserve first-seen order)
  const seenKw = new Set();
  const keywords = [];
  const seenLang = new Set();
  const languages = [];
  const seenPlat = new Set();
  const platforms = [];
  group.forEach((p) => {
    if (!seenKw.has(p.keyword)) {
      seenKw.add(p.keyword);
      keywords.push(p.keyword);
    }
    if (!seenLang.has(p.language)) {
      seenLang.add(p.language);
      languages.push(p.language);
    }
    if (!seenPlat.has(p.platform)) {
      seenPlat.add(p.platform);
      platforms.push(p.platform);
    }
  });

  const hasCarrier = keywords.some((k) => CARRIER_KEYWORDS.has(k));
  const suspectedSightingTide =
    hasCarrier && accountCount >= opts.minAccountsTide;

  // radius = max distance from centroid, floored so the ring is always visible.
  const radiusDeg = Math.max(
    0.4,
    Math.sqrt(
      group.reduce((s, p) => {
        const dLat = p.lat - lat;
        const dLon = p.lon - lon;
        return s + dLat * dLat + dLon * dLon;
      }, 0) / group.length
    ) + 0.15
  );

  const regionName = regionNameFor(lat, lon);
  const hint = suspectedSightingTide
    ? `${accountCount} 个不同账号在 ${windowMinutes} 分钟窗口内于同一海域发布航母/大型舰艇目击内容，符合目击潮特征：疑似航母编队经过引发集中目击。`
    : `${accountCount} 个账号在 ${windowMinutes} 分钟内发布相关目击内容，${
        hasCarrier
          ? "账号数未达目击潮阈值（≥" + opts.minAccountsTide + "）"
          : "未出现航母特征关键词"
      }，暂判定为常规活动，未达目击潮阈值。`;

  return {
    id: `C${index + 1}`,
    regionName,
    lat,
    lon,
    accountCount,
    postCount,
    timeWindowStart: new Date(tStart).toISOString(),
    timeWindowEnd: new Date(tEnd).toISOString(),
    windowMinutes,
    keywords,
    languages,
    platforms,
    radiusDeg,
    suspectedSightingTide,
    hint,
  };
}

// Pure cluster derivation. Group posts that are (a) geographically close,
// (b) within a short time window of each other, (c) share/similar keywords,
// then keep groups with ≥ minAccounts distinct accounts.
export function computeClusters(posts, optsArg = {}) {
  const opts = { ...DEFAULTS, ...optsArg };
  const r2 = opts.radiusDeg * opts.radiusDeg;
  const windowMs = opts.clusterWindowMin * MIN;

  const list = (posts || [])
    .filter(
      (p) =>
        p &&
        typeof p.lat === "number" &&
        typeof p.lon === "number" &&
        p.time
    )
    .slice();

  // Sort newest-first so the newest post anchors each group's time window.
  list.sort(
    (a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)
  );

  const used = new Set();
  const groups = [];

  for (let i = 0; i < list.length; i++) {
    const seed = list[i];
    if (used.has(seed.id)) continue;
    const group = [seed];
    used.add(seed.id);
    const seedT = Date.parse(seed.time);

    for (let j = i + 1; j < list.length; j++) {
      const cand = list[j];
      if (used.has(cand.id)) continue;
      // (c) keyword similarity
      if (!keywordsSimilar(seed.keyword, cand.keyword)) continue;
      // (a) geographic proximity to the seed
      const dLat = cand.lat - seed.lat;
      const dLon = cand.lon - seed.lon;
      if (dLat * dLat + dLon * dLon > r2) continue;
      // (b) within the cluster window of the newest (seed) post
      const dt = seedT - Date.parse(cand.time);
      if (dt > windowMs) continue;
      group.push(cand);
      used.add(cand.id);
    }

    const accountCount = new Set(group.map((p) => p.account)).size;
    if (accountCount >= opts.minAccounts) {
      groups.push(group);
    }
  }

  // Sort so a 目击潮 (if any) lands first and keeps the C1 id — matches the
  // previous static layout (Philippine Sea C1, Sicily C2).
  groups.sort((a, b) => {
    const ta = scoreGroup(a, opts);
    const tb = scoreGroup(b, opts);
    return tb - ta;
  });

  return groups.map((g, i) => buildCluster(g, i, opts));
}

// Higher score = more cluster-worthy (tide > plain; then more accounts; then
// more recent). Keeps the 目击潮 cluster stable as C1 across recomputes.
function scoreGroup(group, opts) {
  const accounts = new Set(group.map((p) => p.account)).size;
  const hasCarrier = group.some((p) =>
    CARRIER_KEYWORDS.has(p.keyword)
  );
  const isTide = hasCarrier && accounts >= opts.minAccountsTide;
  const newest = Math.max(...group.map((p) => Date.parse(p.time) || 0));
  return (isTide ? 1e13 : 0) + accounts * 1e6 + newest;
}

// Build the full initial payload.
export function buildPayload() {
  _seq = 1000;
  // Anchor both seed posts and lastFetchAt on the real build-time now so the
  // demo tick (which uses real `Date.now()` for new posts) shares one clock
  // with the seeds — new posts land inside the 目击潮 window and grow it.
  const anchor = Date.now();
  const posts = seedPosts(anchor);
  const clusters = computeClusters(posts);
  return {
    source: "社媒公开搜索（mock）",
    platforms: ["twitter", "instagram"],
    cadenceText: "每 15 分钟抓取一次新帖",
    cadenceMinutes: 15,
    keywordGroups: [
      { lang: "zh", label: "中文", terms: ["航母", "军舰", "大船", "海上"] },
      { lang: "en", label: "English", terms: ["carrier", "warship", "large ship", "at sea"] },
      { lang: "ja", label: "日本語", terms: ["空母", "軍艦", "海上"] },
      { lang: "ru", label: "Русский", terms: ["авианосец"] },
    ],
    coordSources: [
      { code: "gps", label: "GPS 标签" },
      { code: "exif", label: "图片 EXIF" },
    ],
    lastFetchAt: new Date(anchor).toISOString(),
    posts,
    clusters,
  };
}

// Synthesize a "new post" as if just ingested by the (mocked) 15-min crawl.
// Used by the local demo tick to prepend to the stream + advance last-fetch.
const NEW_POST_POOL = [
  {
    platform: "twitter",
    account: "@live_shore_watch",
    language: "zh",
    keyword: "航母",
    coordSource: "gps",
    lat: 27.55,
    lon: 134.25,
    text: "又拍到那艘大船了，这次甲板上飞机更多了 #航母",
  },
  {
    platform: "instagram",
    account: "fleet_tracker_live",
    language: "en",
    keyword: "carrier",
    coordSource: "exif",
    lat: 27.72,
    lon: 134.48,
    text: "Fresh shot of the flattop, EXIF timestamp matches transit window #carrier",
  },
  {
    platform: "twitter",
    account: "@osint_sicily",
    language: "en",
    keyword: "warship",
    coordSource: "gps",
    lat: 35.3,
    lon: 18.9,
    text: "Additional warship sighting east of Sicily, geotag confirmed #warship",
  },
  {
    platform: "instagram",
    account: "arctic_passage_now",
    language: "ru",
    keyword: "авианосец",
    coordSource: "exif",
    lat: 71.3,
    lon: 25.9,
    text: "Новый снимок судна в арктическом проливе, EXIF подтверждает #авианосец",
  },
];

export function makeNewPost(fetchedAt) {
  const tpl = NEW_POST_POOL[Math.floor(Math.random() * NEW_POST_POOL.length)];
  const inCluster = tpl.lat > 27 && tpl.lat < 28 && tpl.lon > 133 && tpl.lon < 135;
  return {
    id: nextId("p"),
    ...tpl,
    time: fetchedAt,
    // Clusters are now derived from posts and re-id each tick, so we no longer
    // reference a hard-coded "C1". This row-level hint just says whether the
    // post lands in a same-sea-area aggregation window; the cluster card shows
    // the recomputed accountCount/postCount/tide flag.
    similarSummary: inCluster
      ? "落入同海域聚合窗口，已自动并入聚合高亮"
      : "暂无同海域聚合",
  };
}
