import { toNumber } from "../logic/domain.js";

export function nearestValidPointIndex(data, valueKey, pointerX, plotLeft, plotWidth) {
  if (!Array.isArray(data) || data.length === 0 || plotWidth <= 0) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  data.forEach((item, index) => {
    if (toNumber(item?.[valueKey]) === null) return;
    const x = plotLeft + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
    const distance = Math.abs(x - pointerX);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}
