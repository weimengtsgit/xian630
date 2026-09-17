// 全局集中常量（唯一事实来源，规则不得散落多处）

// 告警阈值：当前数量 / 30 天滑动平均基线 = ratio
// 判定顺序为先红后黄（见 utils/alertRule.js），阈值仅在此处定义
export const RATIO_RED_THRESHOLD = 0.50; // ratio < 0.50 → 净空告警（红）
export const RATIO_YELLOW_THRESHOLD = 0.70; // ratio < 0.70 → 净空预警（黄）

// 看板刷新节奏：固定 180 秒（3 分钟）
export const REFRESH_INTERVAL_SEC = 180;
export const TICK_MS = REFRESH_INTERVAL_SEC * 1000;

// 监控网格边长：固定 50 海里
export const GRID_EDGE_NM = 50;

// 近 24h 走势窗口：3 分钟粒度 480 点
export const RECENT_WINDOW_TICKS = 480;
// 30 天滑动平均基线窗口：小时粒度 720 点（30 天 × 24 小时）
export const BASELINE_WINDOW_HOURS = 720;

// 演示数据流锚点：游标 tick = floor((now - ANCHOR_EPOCH_MS) / TICK_MS)，确定性推进、全网可复现
export const ANCHOR_EPOCH_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z

// 演示数据流中断段（确定性注入，用于验收错误态）：
// 每 288 个游标步（= 24 小时）周期中的固定相位 96、97（约第 8 小时节点，持续 2 步 = 6 分钟）
export const FEED_CYCLE_TICKS = 288;
export const FEED_OUTAGE_TICK_PHASES = [96, 97];

// 数据滞后判定：超过 180 秒未成功刷新 → stale（独立橙色语义，不占用黄/红告警色）
export const STALE_AFTER_MS = TICK_MS;

// 演示口径标注（全局可见：顶栏徽标 + 页脚声明）
export const DEMO_BADGE_TEXT = '演示数据';
export const DEMO_DISCLAIMER =
  '本看板全部数据为预生成演示口径（mock）数据，由种子化确定性生成器在浏览器内模拟 AIS 商船密度数据流，不接入、不代表任何真实 AIS 数据源；网格中心坐标为演示值。真实 AIS 接入需另行采购实时数据服务并重新进行数据接入确认。';
