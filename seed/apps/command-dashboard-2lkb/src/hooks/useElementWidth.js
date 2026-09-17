import { useEffect, useRef, useState } from 'react';

// 测量元素内容宽度（ResizeObserver），供 SVG 图表按像素坐标绘制与 hover 精确定位
export function useElementWidth(fallback = 220) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w) => setWidth(Math.max(40, Math.round(w)));
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
