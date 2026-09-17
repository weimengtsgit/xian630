// 种子化确定性 PRNG（mulberry32）：同一 seed 序列完全可复现，全程不使用 Math.random。
// 依据数据接入契约：确定性生成器置于 src/utils/，数据层目录只做读取与归一化。

// 字符串 → 32 位种子（FNV-1a）
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32：返回 [0,1) 的确定性伪随机数
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

// 无状态确定性标量噪声：对（key, index）映射到 [-1, 1]，任意时刻调用结果一致
export function noiseAt(key, index) {
  const seed = (hashSeed(key) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  return mulberry32(seed)() * 2 - 1;
}
