// 确定性伪随机：演示数据集必须可复现，禁止使用 Math.random。
// mulberry32 + 字符串散列（FNV-1a 变体），同一批次索引永远得到同一数据。

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(...keys) {
  return mulberry32(hashString(keys.join('|')));
}

// 区间随机整数 [min, max]
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// 按权重挑选（weights 与 items 等长）
export function pickWeighted(rng, items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
