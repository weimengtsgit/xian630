// 内容相似度（确定性计算，无随机）：
// CJK 按单字切分，其他文字按词切分；帖子相似度 = 0.7 × 文本 Jaccard + 0.3 × 命中词 Jaccard。

const CJK_RE = /[一-鿿぀-ヿ]/g;

export function tokenize(text) {
  const tokens = [];
  const rest = String(text)
    .toLowerCase()
    .replace(CJK_RE, (ch) => {
      tokens.push(ch);
      return ' ';
    });
  for (const w of rest.split(/[^\p{L}\p{N}]+/u)) {
    if (w) tokens.push(w);
  }
  return tokens;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function postSimilarity(p1, p2) {
  const t = jaccard(new Set(tokenize(p1.content)), new Set(tokenize(p2.content)));
  const k = jaccard(
    new Set(p1.matchedKeywords.map((s) => s.toLowerCase())),
    new Set(p2.matchedKeywords.map((s) => s.toLowerCase()))
  );
  return Math.min(1, 0.7 * t + 0.3 * k);
}

// 组内平均两两相似度
export function groupSimilarity(posts) {
  if (posts.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      total += postSimilarity(posts[i], posts[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}
