// 目击潮聚类引擎：同一海域 + 时间窗内 + 半径内 的多账号相似发帖聚合。
// 判定要素与默认阈值（运行时可配置）：
//   windowMinutes=60、radiusKm=50、minAccounts=3、minSimilarity=0.6
// 严重度（紧急/关注/正常）由账号数与相似度推导；复核状态支持 待复核/已确认/已排除 流转。
import { distKm } from './geo';
import { groupSimilarity } from './similarity';
import { hashString } from './random';
import { CARRIER_TERMS, WARSHIP_TERMS } from '../data/keywords';

export const DEFAULT_THRESHOLDS = {
  windowMinutes: 60,
  radiusKm: 50,
  minAccounts: 3,
  minSimilarity: 0.6,
};

export const SEVERITY_ORDER = { 紧急: 0, 关注: 1, 正常: 2 };
export const REVIEW_STATUS_LABEL = { pending: '待复核', confirmed: '已确认', dismissed: '已排除' };

export function deriveSeverity(accountCount, similarityScore) {
  if (accountCount >= 6 || (accountCount >= 4 && similarityScore >= 0.88)) return '紧急';
  if (accountCount >= 4 || similarityScore >= 0.75) return '关注';
  return '正常';
}

export function deriveSuspectedType(members) {
  const matched = new Set(members.flatMap((p) => p.matchedKeywords.map((s) => s.toLowerCase())));
  for (const t of matched) {
    if (CARRIER_TERMS.has(t)) return '疑似航母/大型舰船编队经过';
  }
  for (const t of matched) {
    if (WARSHIP_TERMS.has(t)) return '疑似军用舰船活动';
  }
  return '疑似大型船舶活动';
}

// 演示剧本的预设复核结论（SC-B 已确认 / SC-C 已排除），其余默认待复核
export function presetReviewState(members) {
  const tags = new Set(members.map((p) => p.scenarioTag).filter(Boolean));
  if (tags.has('SC-C')) return 'dismissed';
  if (tags.has('SC-B')) return 'confirmed';
  return null;
}

const toMs = (iso) => Date.parse(iso);

export function detectClusters(posts, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const candidates = posts
    .filter((p) => p.latitude != null)
    .sort((a, b) => toMs(a.postedAt) - toMs(b.postedAt));

  const used = new Set();
  const clusters = [];

  for (const seed of candidates) {
    if (used.has(seed.postId)) continue;
    const group = [seed];
    used.add(seed.postId);
    const seedMs = toMs(seed.postedAt);
    for (const p of candidates) {
      if (used.has(p.postId)) continue;
      if (p.seaArea !== seed.seaArea) continue;
      if (Math.abs(toMs(p.postedAt) - seedMs) > t.windowMinutes * 60 * 1000) continue;
      if (distKm(p.latitude, p.longitude, seed.latitude, seed.longitude) > t.radiusKm) continue;
      group.push(p);
      used.add(p.postId);
    }
    const accounts = new Set(group.map((p) => p.accountId));
    const similarity = groupSimilarity(group);
    if (accounts.size < t.minAccounts || similarity < t.minSimilarity) continue;

    clusters.push(buildCluster(group, t));
  }

  // 最新事件在前
  clusters.sort((a, b) => toMs(b.windowStart) - toMs(a.windowStart));
  return clusters;
}

function buildCluster(members, thresholds) {
  const lats = members.map((p) => p.latitude);
  const lons = members.map((p) => p.longitude);
  const centerLatitude = lats.reduce((s, v) => s + v, 0) / members.length;
  const centerLongitude = lons.reduce((s, v) => s + v, 0) / members.length;
  let radiusKm = 0;
  for (const p of members) {
    radiusKm = Math.max(radiusKm, distKm(centerLatitude, centerLongitude, p.latitude, p.longitude));
  }
  const times = members.map((p) => toMs(p.postedAt)).sort((a, b) => a - b);
  const windowStart = new Date(times[0]).toISOString();
  const windowEnd = new Date(times[times.length - 1]).toISOString();
  const windowMinutes = Math.round((times[times.length - 1] - times[0]) / 60000);
  const accountCount = new Set(members.map((p) => p.accountId)).size;
  const similarityScore = Math.round(groupSimilarity(members) * 100) / 100;
  const memberPostIds = members.map((p) => p.postId).sort();
  const clusterKey = memberPostIds.join('+');
  const clusterId = `C-${1000 + (hashString(clusterKey) % 9000)}`;
  const areaCount = {};
  for (const p of members) areaCount[p.seaArea] = (areaCount[p.seaArea] || 0) + 1;
  const seaArea = Object.entries(areaCount).sort((a, b) => b[1] - a[1])[0][0];

  return {
    clusterId,
    clusterKey,
    seaArea,
    centerLatitude: Number(centerLatitude.toFixed(4)),
    centerLongitude: Number(centerLongitude.toFixed(4)),
    radiusKm: Math.round(radiusKm * 10) / 10,
    windowStart,
    windowEnd,
    windowMinutes,
    accountCount,
    postCount: members.length,
    similarityScore,
    severity: deriveSeverity(accountCount, similarityScore),
    suspectedType: deriveSuspectedType(members),
    memberPostIds,
    members,
    appliedThresholds: { ...thresholds },
    demo: true,
  };
}
