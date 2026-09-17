// 演示数据集（mock_data 口径，显著标注）：
// - 全部账号、文案、坐标均为本地确定性合成内容（种子 PRNG，可复现，零外网请求）；
// - 契约字段与原型 assumedDataFields 一一对应（post/cluster/batch/keywordTask/system 五实体）；
// - 内置目击潮剧本：SC-A 西太平洋（紧急·待复核）、SC-B 阿拉伯海（关注·已确认）、
//   SC-C 南大西洋（关注·已排除）、SC-D 南海同账号多发（边界样本，不应触发聚类）；
// - 含 1 个失败批次剧本（Instagram 源超时，可重试恢复）。
import { makeRng, randInt, pickWeighted } from '../core/random';
import { SEA_AREAS, seaAreaForPoint } from './seaAreas';
import { KEYWORD_GROUPS, CONTENT_TEMPLATES, TAIL_VARIANTS, ACCOUNT_POOLS } from './keywords';

export const BATCH_INTERVAL_MINUTES = 15;
export const DEMO_METADATA = {
  demo: true,
  label: '演示数据（本地内置合成，非真实平台数据）',
  generator: 'DemoDataSource v1（确定性种子）',
};

const INTERVAL_MS = BATCH_INTERVAL_MINUTES * 60 * 1000;
const LOOKBACK_BATCHES = 96; // 近 24 小时

const GROUP_BY_LANG = Object.fromEntries(KEYWORD_GROUPS.map((g) => [g.language, g]));
const LANGS = KEYWORD_GROUPS.map((g) => g.language);
const LANG_WEIGHTS = [0.24, 0.24, 0.14, 0.14, 0.12, 0.12];

// 账号 → 稳定 accountId（合成）
const ACCOUNT_IDS = {};
for (const [lang, pool] of Object.entries(ACCOUNT_POOLS)) {
  pool.forEach((name, i) => {
    ACCOUNT_IDS[`${lang}|${name}`] = `acc-${lang}-${i + 1}`;
  });
}

const iso = (ms) => new Date(ms).toISOString();

function randPointInArea(rng, area) {
  const m = 0.6;
  const [lo1, la1, lo2, la2] = area.bbox;
  return [lo1 + m + rng() * (lo2 - lo1 - 2 * m), la1 + m + rng() * (la2 - la1 - 2 * m)];
}

function nearCenter(rng, center, spreadDeg) {
  return [center[0] + (rng() * 2 - 1) * spreadDeg, center[1] + (rng() * 2 - 1) * spreadDeg];
}

function makePost(opt) {
  const {
    postId, batchId, platform, language, terms, templateIdx, tail, account,
    postedAtMs, coord, coordSource, areaName, scenarioTag, rng,
  } = opt;
  const templates = CONTENT_TEMPLATES[language];
  const template = templates[templateIdx % templates.length];
  let content = template.replaceAll('{T}', terms[0]);
  if (tail) content += tail;

  let latitude = null;
  let longitude = null;
  let resolvedCoordSource = null;
  let seaArea = areaName;
  if (coord) {
    longitude = Number(coord[0].toFixed(4));
    latitude = Number(coord[1].toFixed(4));
    resolvedCoordSource = coordSource;
    const resolved = seaAreaForPoint(longitude, latitude);
    if (resolved) seaArea = resolved.name;
  }

  const hasImage = platform === 'instagram' ? rng() < 0.9 : rng() < 0.35;
  return {
    postId,
    platform,
    accountId: ACCOUNT_IDS[`${language}|${account}`] || `acc-${language}-x`,
    accountName: account,
    language,
    matchedKeywords: terms.slice(),
    postedAt: iso(postedAtMs),
    capturedBatchId: batchId,
    content,
    hasImage,
    latitude,
    longitude,
    coordSource: resolvedCoordSource,
    seaArea,
    scenarioTag: scenarioTag || null,
    demo: true,
  };
}

// 常规背景帖子：随机跨海区、跨语种、跨账号
function genericPosts(batchIndex, batchId, startMs, rng, { forcePlatform = null } = {}) {
  const posts = [];
  let count = randInt(rng, 1, 4);
  if (batchIndex % 7 === 3) count += 2;
  for (let k = 0; k < count; k++) {
    const language = pickWeighted(rng, LANGS, LANG_WEIGHTS);
    const group = GROUP_BY_LANG[language];
    const termIdx = randInt(rng, 0, group.terms.length - 1);
    const terms = [group.terms[termIdx]];
    if (rng() < 0.35) terms.push(group.terms[(termIdx + 2) % group.terms.length]);
    const area = SEA_AREAS[randInt(rng, 0, SEA_AREAS.length - 1)];
    const platform = forcePlatform || (rng() < 0.58 ? 'x' : 'instagram');
    const pool = ACCOUNT_POOLS[language];
    const account = pool[randInt(rng, 0, pool.length - 1)];
    const postedAtMs = startMs - 30 * 1000 - Math.floor(rng() * (INTERVAL_MS - 90 * 1000));
    const roll = rng();
    let coord = randPointInArea(rng, area);
    let coordSource = null;
    if (roll < 0.62) coordSource = 'gps_tag';
    else if (roll < 0.92) coordSource = 'exif';
    else coord = null;
    posts.push(makePost({
      postId: `p${batchIndex}-${k}`,
      batchId,
      platform,
      language,
      terms,
      templateIdx: randInt(rng, 0, 3),
      tail: TAIL_VARIANTS[randInt(rng, 0, TAIL_VARIANTS.length - 1)],
      account,
      postedAtMs,
      coord,
      coordSource,
      areaName: area.name,
      rng,
    }));
  }
  return posts;
}

// 目击潮剧本注入：同海区、短时间、多账号、相似内容
function scenarioPosts(tag, lang, templateIdx, terms, center, spread, accounts, batchIndex, batchId, startMs, perBatchCount) {
  const posts = [];
  for (let j = 0; j < perBatchCount; j++) {
    const rng = makeRng('demo-scenario', tag, batchIndex, j);
    const account = accounts[(batchIndex * perBatchCount + j) % accounts.length];
    const platform = rng() < 0.6 ? 'x' : 'instagram';
    const postedAtMs = startMs - Math.floor(rng() * 13 * 60 * 1000) - 30 * 1000;
    const coordSource = rng() < 0.55 ? 'gps_tag' : 'exif';
    const termsForPost = rng() < 0.7 ? terms.slice() : [terms[0]];
    posts.push(makePost({
      postId: `s${tag}-${batchIndex}-${j}`,
      batchId,
      platform,
      language: lang,
      terms: termsForPost,
      templateIdx,
      tail: TAIL_VARIANTS[randInt(rng, 0, TAIL_VARIANTS.length - 1)],
      account,
      postedAtMs,
      coord: nearCenter(rng, center, spread),
      coordSource,
      areaName: seaAreaNameOfPoint(center),
      scenarioTag: tag,
      rng,
    }));
  }
  return posts;
}

function seaAreaNameOfPoint(center) {
  const a = seaAreaForPoint(center[0], center[1]);
  return a ? a.name : '公海';
}

// 演示时间线：以锚点为界向前回溯 96 个批次，向后可继续生成
export class DemoTimeline {
  constructor(referenceMs) {
    this.anchorMs = Math.floor(referenceMs / INTERVAL_MS) * INTERVAL_MS;
    this.latestIndex = LOOKBACK_BATCHES - 1;
  }

  startMsOf(batchIndex) {
    return this.anchorMs + (batchIndex - this.latestIndex) * INTERVAL_MS;
  }

  // 生成单个批次（确定性：同一 index + retry 标志永远产出相同结果）
  generateBatch(batchIndex, { retry = false } = {}) {
    const startMs = this.startMsOf(batchIndex);
    const batchId = `B-${1000 + batchIndex}`;
    const L = this.latestIndex;
    const posts = [];
    let status = 'success';
    let errorMessage = null;
    let platforms = { x: 'ok', instagram: 'ok' };

    const rng = makeRng('demo-batch', batchIndex);
    posts.push(...genericPosts(batchIndex, batchId, startMs, rng));

    // SC-A 西太平洋目击潮（紧急 · 待复核）：最近 3 个批次，6 账号 9 帖
    if (batchIndex >= L - 3 && batchIndex <= L - 1) {
      posts.push(...scenarioPosts('SC-A', 'zh', 0, ['航母', '海上'], [129.0, 24.0], 0.12,
        ACCOUNT_POOLS.zh.slice(0, 6), batchIndex, batchId, startMs, 3));
    }
    // SC-B 阿拉伯海目击潮（关注 · 剧本复核=已确认）：约 4 小时前，4 账号 6 帖
    if (batchIndex === L - 17 || batchIndex === L - 16) {
      posts.push(...scenarioPosts('SC-B', 'en', 0, ['warship', 'at sea'], [67.5, 13.5], 0.12,
        ACCOUNT_POOLS.en.slice(0, 4), batchIndex, batchId, startMs, 3));
    }
    // SC-C 南大西洋目击潮（关注 · 剧本复核=已排除）：约 6.5 小时前，5 账号 7 帖
    if (batchIndex === L - 26 || batchIndex === L - 25) {
      posts.push(...scenarioPosts('SC-C', 'ru', 1, ['большой корабль', 'в море'], [-15.0, -24.0], 0.12,
        ACCOUNT_POOLS.ru.slice(0, 5), batchIndex, batchId, startMs, batchIndex === L - 26 ? 3 : 4));
    }
    // SC-D 南海同账号多发（边界样本：单账号不满足 minAccounts，不应聚类）
    if (batchIndex === L - 8) {
      posts.push(...scenarioPosts('SC-D', 'zh', 2, ['大船'], [112.0, 12.0], 0.1,
        [ACCOUNT_POOLS.zh[6]], batchIndex, batchId, startMs, 5));
    }

    // 失败批次剧本：Instagram 源超时（可重试），重试后补齐双源数据
    if (batchIndex === L - 13) {
      if (!retry) {
        status = 'failed';
        errorMessage = 'Instagram 源响应超时（演示剧本）';
        platforms = { x: 'ok', instagram: 'error' };
        const failRng = makeRng('demo-batch-failed', batchIndex);
        const kept = genericPosts(batchIndex, batchId, startMs, failRng, { forcePlatform: 'x' }).slice(0, 2);
        return {
          batch: this.buildBatch(batchIndex, startMs, { status, errorMessage, platforms, durationSec: 25 }),
          posts: kept,
        };
      }
      const retryRng = makeRng('demo-batch-retry', batchIndex);
      posts.push(...genericPosts(batchIndex, batchId, startMs, retryRng));
    }

    // 运行期持续剧本：每 9 个批次出现一波新的多账号相似发帖（供演示加速观察新聚类）
    if (batchIndex > L && (batchIndex - L) % 9 === 4) {
      const group = KEYWORD_GROUPS[batchIndex % KEYWORD_GROUPS.length];
      const area = SEA_AREAS[(batchIndex * 5) % SEA_AREAS.length];
      const center = [(area.bbox[0] + area.bbox[2]) / 2, (area.bbox[1] + area.bbox[3]) / 2];
      posts.push(...scenarioPosts('SC-W', group.language, 0, [group.terms[0], group.terms[3] || group.terms[1]],
        center, 0.12, ACCOUNT_POOLS[group.language].slice(0, 4), batchIndex, batchId, startMs, 4));
    }

    return {
      batch: this.buildBatch(batchIndex, startMs, { status, errorMessage, platforms, durationSec: 40 }),
      posts,
    };
  }

  buildBatch(batchIndex, startMs, { status, errorMessage, platforms, durationSec }) {
    return {
      batchId: `B-${1000 + batchIndex}`,
      index: batchIndex,
      startedAt: iso(startMs),
      finishedAt: status === 'running' ? null : iso(startMs + durationSec * 1000),
      intervalMinutes: BATCH_INTERVAL_MINUTES,
      status,
      errorMessage,
      platforms,
      demo: true,
    };
  }

  buildInitial() {
    const batches = [];
    const posts = [];
    for (let i = 0; i <= this.latestIndex; i++) {
      const { batch, posts: batchPosts } = this.generateBatch(i);
      batches.push(batch);
      posts.push(...batchPosts);
    }
    return { batches, posts, latestIndex: this.latestIndex, anchorMs: this.anchorMs };
  }
}

// 批次实体统计（newPostCount / withCoordCount / 双通道计数）
export function withBatchStats(batch, posts) {
  const own = posts.filter((p) => p.capturedBatchId === batch.batchId);
  return {
    ...batch,
    newPostCount: own.length,
    withCoordCount: own.filter((p) => p.latitude != null).length,
    gpsTagCount: own.filter((p) => p.coordSource === 'gps_tag').length,
    exifCount: own.filter((p) => p.coordSource === 'exif').length,
  };
}
