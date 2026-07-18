// 受监测 MMSI 由使用方提供；首页只加载名单，点选后才拉取该船完整 AIS 轨迹。
const defaultVessels = [
  { mmsi: "338555318", name: "SEASATS 74", role: "无人艇" },
  { mmsi: "338414915", name: "SEASATS 55", role: "无人艇" },
  { mmsi: "338432795", name: "SD3001", role: "候选舰船" },
  { mmsi: "338432796", name: "SD3002", role: "候选舰船" },
  { mmsi: "338432797", name: "SD3003", role: "候选舰船" },
  { mmsi: "368913000", name: "乔治·华盛顿号 (USS George Washington)", role: "航母" },
  // 使用方指定该艇的展示名称，关联结论中统一显示英文船名。
  { mmsi: "368926574", name: "SEAHAWK", role: "无人艇" },
  { mmsi: "369970970", name: "海猎号", role: "无人艇" },
  { mmsi: "366984000", name: "西奥多·罗斯福号 (USS Theodore Roosevelt)", role: "航母" },
  // 来自 mmsis.csv 的补充名单；名称会在用户点选并获取真实 AIS 后以接口值更新。
  { mmsi: "338462016", name: "MMSI 338462016", role: "候选舰船" },
  { mmsi: "338526166", name: "MMSI 338526166", role: "候选舰船" },
  { mmsi: "368926540", name: "MMSI 368926540", role: "候选舰船" },
  { mmsi: "369970641", name: "MMSI 369970641", role: "候选舰船" },
  { mmsi: "369970455", name: "MMSI 369970455", role: "候选舰船" },
  { mmsi: "369970176", name: "MMSI 369970176", role: "候选舰船" },
  { mmsi: "368776000", name: "MMSI 368776000", role: "候选舰船" },
  { mmsi: "666966000", name: "MMSI 666966000", role: "候选舰船" },
  { mmsi: "338962000", name: "MMSI 338962000", role: "候选舰船" },
  { mmsi: "338816000", name: "MMSI 338816000", role: "候选舰船" },
  { mmsi: "367197000", name: "MMSI 367197000", role: "候选舰船" },
  { mmsi: "303852000", name: "MMSI 303852000", role: "候选舰船" },
  { mmsi: "368006000", name: "MMSI 368006000", role: "候选舰船" },
  { mmsi: "369933000", name: "MMSI 369933000", role: "候选舰船" },
  { mmsi: "369939000", name: "MMSI 369939000", role: "候选舰船" },
  { mmsi: "369970407", name: "MMSI 369970407", role: "候选舰船" },
  { mmsi: "368011000", name: "MMSI 368011000", role: "候选舰船" },
  { mmsi: "367219000", name: "MMSI 367219000", role: "候选舰船" },
  { mmsi: "367860000", name: "MMSI 367860000", role: "候选舰船" },
  { mmsi: "367276000", name: "MMSI 367276000", role: "候选舰船" },
  { mmsi: "369914055", name: "MMSI 369914055", role: "候选舰船" },
];

const configuredMmsi = process.env.MONITORED_MMSI;
const configuredSet = configuredMmsi ? new Set(configuredMmsi.split(",").map((value) => value.trim()).filter((value) => /^\d{6,12}$/.test(value))) : null;
export const MONITORED_VESSELS = configuredSet
  ? [...configuredSet].map((mmsi) => defaultVessels.find((vessel) => vessel.mmsi === mmsi) || { mmsi, name: `MMSI ${mmsi}`, role: "受监测舰船" })
  : defaultVessels;
export const SEASATS_MMSI_SCOPE = MONITORED_VESSELS.map((vessel) => vessel.mmsi);
