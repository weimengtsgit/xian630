// 航母/属舰关联分析的候选集合由使用方提供；不通过全量 AIS 猜测候选舰船。
export const AFFILIATION_REFERENCE = {
  mmsi: "338414915",
  name: "SEASATS 55",
  role: "无人艇",
};

export const AFFILIATION_CANDIDATES = [
  { mmsi: "338432795", name: "SD3001", role: "候选舰船" },
  { mmsi: "338432796", name: "SD3002", role: "候选舰船" },
  { mmsi: "338432797", name: "SD3003", role: "候选舰船" },
  { mmsi: "368913000", name: "CVN-73", role: "航母" },
  { mmsi: "368926574", name: "海鹰", role: "候选舰船" },
  { mmsi: "369970970", name: "海猎号", role: "候选舰船" },
  { mmsi: "366984000", name: "CVN-71", role: "航母" },
];
