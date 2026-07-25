import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Gauge,
  LineChart,
  MapPin,
  Navigation,
  Radio,
  ShieldAlert,
} from "lucide-react";
import React from "react";
import { combinedSpeedDistanceSeries, headingDistribution, hourDistribution, speedSeries } from "../logic/analytics.js";
import { fmtDuration, toNumber } from "../logic/domain.js";

const chartWidth = 760;
const chartHeight = 260;
const pad = { top: 18, right: 34, bottom: 34, left: 42 };
const plotWidth = chartWidth - pad.left - pad.right;
const plotHeight = chartHeight - pad.top - pad.bottom;

function fmtNumber(value, digits = 0, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits).replace(/\.0$/, "") : fallback;
}

function fmtDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDay(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function vesselText(value) {
  return String(value || "");
}

function targetPoints(target) {
  return (target?.segments || []).flatMap((segment) => segment.points || []);
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function percentage(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function clampRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [0, max === 0 ? 1 : max * 1.15];
  return [Math.min(0, min), max * 1.08];
}

function chartPoint(index, length, value, min, max) {
  const x = pad.left + (length <= 1 ? plotWidth / 2 : (index / (length - 1)) * plotWidth);
  const ratio = max === min ? 0 : (value - min) / (max - min);
  const y = pad.top + plotHeight - ratio * plotHeight;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function linePath(data, key, min, max) {
  const points = data
    .map((item, index) => {
      const value = toNumber(item[key]);
      return value === null ? null : chartPoint(index, data.length, value, min, max);
    })
    .filter(Boolean);
  return points.length ? `M ${points.join(" L ")}` : "";
}

function EmptyChart() {
  return <div className="analysis-chart-empty">当前时间段没有足够轨迹点</div>;
}

function ChartStats({ items }) {
  return (
    <div className="analysis-chart-stats">
      {items.map((item) => (
        <span key={item.label}>
          <em>{item.label}</em>
          <strong>{item.value}</strong>
        </span>
      ))}
    </div>
  );
}

function ChartShell({ icon: Icon, title, children, legend, stats, fullWidth }) {
  return (
    <article className={`analysis-chart-card${fullWidth ? " wide" : ""}`}>
      <header>
        <h4><Icon size={13} />{title}</h4>
        {legend && <div className="analysis-chart-legend">{legend}</div>}
      </header>
      {children}
      {stats?.length > 0 && <ChartStats items={stats} />}
    </article>
  );
}

function LineMiniChart({ title, data, valueKey = "v", unit, color = "#fbbf24", icon = LineChart, maxValue, extraStats = [], fullWidth = false }) {
  const values = data.map((item) => toNumber(item[valueKey])).filter((value) => value !== null);
  if (values.length < 2) return <ChartShell icon={icon} title={title} fullWidth={fullWidth}><EmptyChart /></ChartShell>;
  const [min, max] = clampRange(Math.min(...values), maxValue ?? Math.max(...values));
  const first = fmtDay(data[0]?.t);
  const last = fmtDay(data[data.length - 1]?.t);
  const peak = Math.max(...values);
  const avg = average(values);

  return (
    <ChartShell
      icon={icon}
      title={title}
      fullWidth={fullWidth}
      legend={<><span style={{ "--dot": color }}>{unit}</span><strong>最高 {fmtNumber(peak, 1)} {unit}</strong></>}
      stats={[
        { label: "样本", value: `${values.length} 点` },
        { label: "均值", value: `${fmtNumber(avg, 1)} ${unit}` },
        ...extraStats,
      ]}
    >
      <svg className="analysis-line-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={title}>
        <g className="chart-grid">
          {[0, 1, 2].map((row) => <line key={row} x1={pad.left} x2={chartWidth - pad.right} y1={pad.top + row * plotHeight / 2} y2={pad.top + row * plotHeight / 2} />)}
        </g>
        <path d={linePath(data, valueKey, min, max)} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <text x={pad.left} y={chartHeight - 7}>{first}</text>
        <text x={chartWidth - pad.right} y={chartHeight - 7} textAnchor="end">{last}</text>
        <text x={pad.left - 8} y={pad.top + 4} textAnchor="end">{fmtNumber(max, 0)}</text>
        <text x={pad.left - 8} y={pad.top + plotHeight} textAnchor="end">{fmtNumber(min, 0)}</text>
      </svg>
    </ChartShell>
  );
}

function SpeedDistanceChart({ target, coastData }) {
  const data = combinedSpeedDistanceSeries(target, coastData, 90).filter((item) => item.speed !== null || item.dist !== null);
  const speedValues = data.map((item) => toNumber(item.speed)).filter((value) => value !== null);
  const distValues = data.map((item) => toNumber(item.dist)).filter((value) => value !== null);
  if (data.length < 2 || speedValues.length < 2) {
    return <ChartShell icon={Activity} title="速度 vs 国土距离"><EmptyChart /></ChartShell>;
  }
  const [speedMin, speedMax] = clampRange(Math.min(...speedValues), Math.max(...speedValues));
  const [distMin, distMax] = distValues.length ? clampRange(Math.min(...distValues), Math.max(...distValues)) : [0, 1];
  const peakIndex = data.reduce((best, item, index) => (toNumber(item.speed) ?? -1) > (toNumber(data[best]?.speed) ?? -1) ? index : best, 0);
  const peakSpeed = toNumber(data[peakIndex]?.speed) ?? 0;
  const peakPoint = chartPoint(peakIndex, data.length, peakSpeed, speedMin, speedMax).split(",");
  const minDistance = distValues.length ? Math.min(...distValues) : null;
  const latestDistance = toNumber([...data].reverse().find((item) => item.dist !== null)?.dist);

  return (
    <ChartShell
      icon={Activity}
      title="速度 vs 国土距离"
      legend={<><span style={{ "--dot": "#fbbf24" }}>速度 节</span><span style={{ "--dot": "#38bdf8" }}>距离 海里</span></>}
      stats={[
        { label: "最高", value: `${fmtNumber(Math.max(...speedValues), 1)} 节` },
        { label: "最近", value: `${fmtNumber(minDistance, 0)} 海里` },
        { label: "末点距离", value: `${fmtNumber(latestDistance, 0)} 海里` },
      ]}
    >
      <svg className="analysis-line-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="速度与国土距离关系">
        <g className="chart-grid">
          {[0, 1, 2].map((row) => <line key={row} x1={pad.left} x2={chartWidth - pad.right} y1={pad.top + row * plotHeight / 2} y2={pad.top + row * plotHeight / 2} />)}
        </g>
        <path d={linePath(data, "speed", speedMin, speedMax)} fill="none" stroke="#fbbf24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {distValues.length > 1 && <path d={linePath(data, "dist", distMin, distMax)} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />}
        <circle cx={peakPoint[0]} cy={peakPoint[1]} r="4" fill="#fb7185" stroke="#fff" strokeWidth="1.5" />
        <text x={pad.left - 8} y={pad.top + 4} textAnchor="end">{fmtNumber(speedMax, 0)}</text>
        <text x={chartWidth - pad.right + 6} y={pad.top + 4}>{fmtNumber(distMax, 0)}</text>
        <text x={pad.left} y={chartHeight - 7}>{fmtDay(data[0]?.t)}</text>
        <text x={chartWidth - pad.right} y={chartHeight - 7} textAnchor="end">{fmtDay(data[data.length - 1]?.t)}</text>
      </svg>
    </ChartShell>
  );
}

function dailyActivity(target, maxBuckets = 12) {
  const byDay = new Map();
  for (const point of targetPoints(target)) {
    const date = new Date(point.time);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, label: fmtDay(`${day}T00:00:00Z`), count, rawDays: 1 }));
  if (days.length <= maxBuckets) return days;

  const bucketSize = Math.ceil(days.length / maxBuckets);
  const buckets = [];
  for (let index = 0; index < days.length; index += bucketSize) {
    const bucketDays = days.slice(index, index + bucketSize);
    const first = bucketDays[0];
    const last = bucketDays[bucketDays.length - 1];
    const label = first.day === last.day ? first.label : `${first.label}-${last.label}`;
    buckets.push({
      day: first.day,
      label,
      count: bucketDays.reduce((sum, item) => sum + item.count, 0),
      rawDays: bucketDays.reduce((sum, item) => sum + item.rawDays, 0),
    });
  }
  return buckets;
}

function BarMiniChart({ title, data, labelKey, valueKey, color = "#fbbf24", icon = BarChart3, stats = [], fullWidth }) {
  const max = Math.max(...data.map((item) => item[valueKey] || 0), 1);
  if (!data.some((item) => item[valueKey] > 0)) return <ChartShell icon={icon} title={title} fullWidth={fullWidth}><EmptyChart /></ChartShell>;

  return (
    <ChartShell icon={icon} title={title} stats={stats} fullWidth={fullWidth}>
      <div className="analysis-bar-chart" role="img" aria-label={title}>
        {data.map((item) => (
          <span key={item[labelKey]} style={{ "--bar": color, "--height": `${Math.max(4, (item[valueKey] / max) * 100)}%` }} title={`${item[labelKey]}：${item[valueKey]}`}>
            <i />
            <em>{item[labelKey]}</em>
            {item.total > 0 && <b>{percentage(item[valueKey], item.total)}%</b>}
          </span>
        ))}
      </div>
    </ChartShell>
  );
}

function EvidenceList({ selectedTarget }) {
  const alerts = selectedTarget?.alerts || [];
  const gaps = selectedTarget?.aisGaps || [];
  const longestGap = gaps.length ? Math.max(...gaps.map((gap) => gap.gapMinutes || 0)) : 0;
  const evidence = [
    `状态：${selectedTarget?.status || "未知"}`,
    `威胁分：${fmtNumber(selectedTarget?.score)}`,
    `最近离国土：${fmtNumber(selectedTarget?.minCoastDistanceNm)} 海里`,
    `AIS 报点：${fmtNumber(selectedTarget?.reportCount)} 个`,
  ];
  if (alerts.length) evidence.push(`告警：${alerts.length} 条`);
  if (gaps.length) evidence.push(`AIS 中断：${gaps.length} 次，最长 ${fmtDuration(longestGap)}`);

  return (
    <ul className="analysis-evidence-list">
      {evidence.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function AlertSummary({ alerts }) {
  if (!alerts?.length) {
    return <p className="analysis-empty">当前关注舰艇暂无告警。</p>;
  }
  return (
    <div className="analysis-alert-list">
      {alerts.slice(0, 3).map((alert) => (
        <article className={`analysis-alert-item ${alert.severity || "info"}`} key={alert.id}>
          <header>
            <strong>{vesselText(alert.title)}</strong>
            <time>{fmtDateTime(alert.time)}</time>
          </header>
          <p>{vesselText(alert.summary)}</p>
        </article>
      ))}
    </div>
  );
}

function AdviceList({ summary }) {
  const advice = summary?.advice || [];
  if (!advice.length) {
    return <p className="analysis-empty">暂无额外处置建议。</p>;
  }
  return (
    <ul className="analysis-advice-list">
      {advice.slice(0, 2).map((item, index) => (
        <li className={item.level || "low"} key={`${item.text}-${index}`}>{vesselText(item.text)}</li>
      ))}
    </ul>
  );
}

function AnalysisCharts({ selectedTarget, coastData }) {
  const speedData = speedSeries(selectedTarget, 90);
  const speedValues = speedData.map((item) => item.v).filter((value) => value !== null);
  const lowSpeedCount = speedValues.filter((speed) => speed <= 3).length;
  const hours = hourDistribution(selectedTarget).map((item) => ({ ...item, label: String(item.h) }));
  const heading = headingDistribution(selectedTarget).map((item) => ({ ...item, label: item.dir }));
  const dominantHeading = [...heading].sort((a, b) => b.count - a.count)[0];
  const days = dailyActivity(selectedTarget);
  const activeDayCount = days.reduce((sum, item) => sum + (item.rawDays || 1), 0);
  const busiestHour = [...hours].sort((a, b) => b.count - a.count)[0];
  const busiestDay = [...days].sort((a, b) => b.count - a.count)[0];
  const nightReports = hours.filter((item) => item.h <= 5 || item.h >= 20).reduce((sum, item) => sum + item.count, 0);
  const totalReports = hours.reduce((sum, item) => sum + item.count, 0);

  return (
    <article className="analysis-group analysis-charts-group">
      <h3><LineChart size={15} />AIS 轨迹图表</h3>
      <div className="analysis-chart-grid">
        <LineMiniChart
          title="速度变化 · 全时段"
          data={speedData}
          unit="节"
          color="#fbbf24"
          icon={Gauge}
          extraStats={[{ label: "低速占比", value: `${percentage(lowSpeedCount, speedValues.length)}%` }]}
        />
        <SpeedDistanceChart target={selectedTarget} coastData={coastData} />
        <BarMiniChart
          title="航向分布"
          data={heading}
          labelKey="label"
          valueKey="count"
          color="#22d3ee"
          icon={Navigation}
          stats={[
            { label: "有效航向", value: `${heading.reduce((sum, item) => sum + item.count, 0)} 点` },
            { label: "主方向", value: dominantHeading?.count ? dominantHeading.label : "--" },
          ]}
        />
        <BarMiniChart
          title="活动时段"
          data={hours}
          labelKey="label"
          valueKey="count"
          color="#fbbf24"
          icon={Clock3}
          stats={[
            { label: "最活跃", value: `${busiestHour?.h ?? "--"} 时` },
            { label: "夜间占比", value: `${percentage(nightReports, totalReports)}%` },
          ]}
        />
        <BarMiniChart
          title="每日活动趋势"
          data={days}
          labelKey="label"
          valueKey="count"
          color="#a78bfa"
          icon={BarChart3}
          fullWidth
          stats={[
            { label: "活动日", value: `${activeDayCount} 天` },
            { label: "最高日", value: `${busiestDay?.label || "--"}` },
          ]}
        />
      </div>
    </article>
  );
}

function CompactConclusion({ summary, selectedTarget, gapCount }) {
  const threatLabel = summary?.threatLabel || "未研判";
  const narrative = vesselText(summary?.narrative || "暂无可用研判。");
  const shortNarrative = narrative.length > 96 ? `${narrative.slice(0, 96)}...` : narrative;

  return (
    <article className="analysis-group conclusion-group compact-conclusion">
      <h3><ShieldAlert size={15} />研判结论</h3>
      <div className={`threat-line ${summary?.threatLevel || "none"}`}>威胁等级 <strong>{threatLabel}</strong></div>
      <p className="narrative">{shortNarrative}</p>
      <div className="conclusion-chips">
        <span><Gauge size={12} />最快 {fmtNumber(selectedTarget?.maxSpeedSegment?.speedKn, 1)} 节</span>
        <span><MapPin size={12} />最近 {fmtNumber(selectedTarget?.minCoastDistanceNm)} 海里</span>
        <span><Radio size={12} />中断 {gapCount} 次</span>
      </div>
    </article>
  );
}

export function AnalysisPanel({ analysis, selectedTarget, coastData, trackLoading = false, trackError = null }) {
  const summary = analysis?.summary;
  const alerts = selectedTarget?.alerts || [];
  const gapCount = selectedTarget?.aisGaps?.length || 0;

  return (
    <section className="analysis-panel simplified-analysis">
      {trackLoading && <div className="track-query-status loading" role="status">本体轨迹统计加载中…</div>}
      {!trackLoading && trackError && <div className="track-query-status error" role="alert">本体轨迹统计加载失败：{trackError}</div>}
      <AnalysisCharts selectedTarget={selectedTarget} coastData={coastData} />

      <article className="analysis-group evidence-group">
        <h3><CheckCircle2 size={15} />关键证据</h3>
        <EvidenceList selectedTarget={selectedTarget} />
      </article>

      <article className="analysis-group event-group">
        <h3><AlertTriangle size={15} />当前舰艇事件</h3>
        <AlertSummary alerts={alerts} />
      </article>

      <article className="analysis-group advice-group">
        <h3><ShieldAlert size={15} />建议动作</h3>
        <AdviceList summary={summary} />
      </article>

      <CompactConclusion summary={summary} selectedTarget={selectedTarget} gapCount={gapCount} />
    </section>
  );
}
