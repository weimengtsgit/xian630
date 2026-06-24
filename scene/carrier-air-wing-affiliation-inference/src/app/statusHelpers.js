// Shared status helpers used across the left table, tree, and detail panels.

const STATUS_META = {
  已离舰: { key: "departed", badge: "departed", order: 0 },
  高置信度属舰飞机: { key: "high", badge: "high", order: 1 },
  疑似交叉部署飞机: { key: "cross", badge: "cross", order: 2 },
  数据不足: { key: "insufficient", badge: "insufficient", order: 3 },
};

export function statusBadgeClass(status) {
  return STATUS_META[status]?.badge ?? "insufficient";
}

export function statusOrder(status) {
  return STATUS_META[status]?.order ?? 9;
}

// Default ordering: 已离舰 → 高置信度属舰 → 疑似交叉部署 → 数据不足; within a
// status, latest activity descending.
export function defaultSort(aircraft) {
  return [...aircraft].sort((a, b) => {
    const so = statusOrder(a.status) - statusOrder(b.status);
    if (so !== 0) return so;
    return Date.parse(b.latestActivityDate) - Date.parse(a.latestActivityDate);
  });
}

export function fmtDate(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${fmtDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function carrierName(carriers, id) {
  if (!id) return "—";
  const c = carriers.find((x) => x.id === id);
  return c ? c.name : id;
}
