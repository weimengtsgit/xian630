// 受监测 MMSI 由使用方提供；首页只加载名单，点选后才拉取该船完整 AIS 轨迹。
// 新增船只可直接填写 englishName / chineseName；两者齐全时左侧栏自动显示“英文（中文）”。
// 若本体 AIS 为同一 MMSI 返回中英文别名，可省略这两个字段，由服务端自动识别。
const defaultVessels = [
  { mmsi: "338555318", name: "SEASATS 74", role: "无人艇" },
  { mmsi: "338414915", name: "SEASATS 55", role: "无人艇" },
  { mmsi: "338432795", name: "SD3001", role: "候选舰船" },
  { mmsi: "338432796", name: "SD3002", role: "候选舰船" },
  { mmsi: "338432797", name: "SD3003", role: "候选舰船" },
  // shortName 仅供左侧栏“代号 船名”展示；name 保持完整船名，右侧栏及其他界面显示不受影响。
  { mmsi: "368913000", code: "CVN-73", name: "乔治·华盛顿号", shortName: "华盛顿号", role: "航母" },
  // 海鹰号的中文名来自客户名单；英文 AIS 名已确认，作为本体身份查询短暂失败时的稳定双语展示兜底。
  { mmsi: "368926574", name: "海鹰号", englishName: "SEAHAWK", chineseName: "海鹰号", role: "无人艇" },
  { mmsi: "369970970", name: "海猎号", englishName: "SEA HUNTER", chineseName: "海猎号", role: "无人艇" },
  { mmsi: "366984000", code: "CVN-71", name: "西奥多·罗斯福号", shortName: "罗斯福号", role: "航母" },
  // 来自 mmsis.csv 的补充名单；代号按公开舷号维护，船名已按本体实际返回值补全（2026-07-23）。
  // 其余 MMSI 占位船在本体中无任何 AIS 记录，暂以 MMSI 作为唯一标识。
  { mmsi: "338462016", name: "SEASATS 33", role: "候选舰船" },
  { mmsi: "338526166", name: "SEASATS 50", role: "候选舰船" },
  { mmsi: "368926540", code: "DDG-118", name: "丹尼尔·井上号", role: "候选舰船" },
  { mmsi: "369970641", name: "MMSI 369970641", role: "候选舰船" },
  { mmsi: "369970455", code: "SSN-750", name: "纽波特纽斯", role: "候选舰船" },
  { mmsi: "369970176", name: "MMSI 369970176", role: "候选舰船" },
  { mmsi: "368776000", code: "CG-62", name: "罗伯特·斯莫尔斯号", role: "候选舰船" },
  { mmsi: "666966000", code: "CG-65", name: "长津湖", role: "候选舰船" },
  { mmsi: "338962000", name: "MMSI 338962000", role: "候选舰船" },
  { mmsi: "338816000", code: "DDG-65", name: "本福德", role: "候选舰船" },
  { mmsi: "367197000", code: "DDG-70", name: "霍珀", role: "候选舰船" },
  { mmsi: "303852000", code: "DDG-83", name: "霍华德", role: "候选舰船" },
  { mmsi: "368006000", code: "DDG-86", name: "肖普", role: "候选舰船" },
  { mmsi: "369933000", code: "DDG-90", name: "查菲", role: "候选舰船" },
  { mmsi: "369939000", code: "DDG-91", name: "平克尼", role: "候选舰船" },
  { mmsi: "369970407", name: "MMSI 369970407", role: "候选舰船" },
  { mmsi: "368011000", name: "MMSI 368011000", role: "候选舰船" },
  { mmsi: "367219000", code: "T-AO-200", name: "瓜达卢佩", role: "候选舰船" },
  { mmsi: "367860000", code: "T-AO-199", name: "蒂珀卡努河", role: "候选舰船" },
  { mmsi: "367276000", code: "T-AKE-11", name: "钱伯斯", role: "候选舰船" },
  { mmsi: "369914055", code: "T-AO-207", name: "厄尔·沃伦", role: "候选舰船" },
];

const configuredMmsi = process.env.MONITORED_MMSI;
const configuredSet = configuredMmsi ? new Set(configuredMmsi.split(",").map((value) => value.trim()).filter((value) => /^\d{6,12}$/.test(value))) : null;
export const MONITORED_VESSELS = configuredSet
  ? [...configuredSet].map((mmsi) => defaultVessels.find((vessel) => vessel.mmsi === mmsi) || { mmsi, name: `MMSI ${mmsi}`, role: "受监测舰船" })
  : defaultVessels;
export const SEASATS_MMSI_SCOPE = MONITORED_VESSELS.map((vessel) => vessel.mmsi);
