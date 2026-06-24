import { Plane, ChevronRight, ChevronDown } from "lucide-react";
import {
  statusBadgeClass,
  defaultSort,
  fmtDate,
  fmtDateTime,
  carrierName,
} from "./statusHelpers.js";
import { buildCarrierAssociationTimeline } from "../logic/affiliation.js";

// Left panel — 疑似舰载机列表.
// Columns: ICAO / 机型 / 首次发现 / 最近活动 / 总起降 / 推定航母 / 归属置信度 / 状态.
// Controls: filter by carrier, sort (default order + alternatives), expandable
// row → takeoff/landing timeline + per-carrier probability.
export function AircraftList({
  aircraft,
  events,
  carriers,
  selectedIcao,
  carrierFilter,
  sortBy,
  onSelectAircraft,
  onCarrierFilter,
  onSort,
}) {
  // filter
  let list = aircraft;
  if (carrierFilter && carrierFilter !== "ALL") {
    if (carrierFilter === "UNBOUND") {
      list = list.filter((a) => a.unboundSuspectedEventCount > 0 && a.carrierProbabilities.length === 0);
    } else {
      list = list.filter(
        (a) =>
          a.inferredCarrierId === carrierFilter ||
          a.carrierProbabilities.some((c) => c.carrierId === carrierFilter)
      );
    }
  }

  // sort
  const sorted = (() => {
    const arr = [...list];
    if (sortBy === "confidence") {
      arr.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    } else if (sortBy === "activity") {
      arr.sort((a, b) => Date.parse(b.latestActivityDate) - Date.parse(a.latestActivityDate));
    } else {
      // default: status priority then latest activity
      return defaultSort(arr);
    }
    return arr;
  })();

  return (
    <section className="cai-list">
      <div className="cai-panel-head">
        <h2>
          <Plane size={14} style={{ verticalAlign: "-2px" }} /> 疑似舰载机列表
        </h2>
        <span className="ctrls">
          <select value={carrierFilter} onChange={(e) => onCarrierFilter(e.target.value)} title="按航母筛选">
            <option value="ALL">全部航母</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
            <option value="UNBOUND">未绑定</option>
          </select>
          <select value={sortBy} onChange={(e) => onSort(e.target.value)} title="排序">
            <option value="default">默认（状态优先）</option>
            <option value="activity">最近活动</option>
            <option value="confidence">置信度</option>
          </select>
        </span>
      </div>
      <div className="cai-tablewrap">
        <table className="cai-table">
          <thead>
            <tr>
              <th>ICAO</th>
              <th>机型</th>
              <th>首次发现</th>
              <th>最近活动</th>
              <th style={{ textAlign: "right" }}>总起降</th>
              <th>推定航母</th>
              <th>归属置信度</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const isSel = a.icao === selectedIcao;
              const isExp = a.icao === selectedIcao;
              return (
                <AircraftRow
                  key={a.icao}
                  a={a}
                  events={events}
                  carriers={carriers}
                  selected={isSel}
                  expanded={isExp}
                  onSelect={() => onSelectAircraft(a.icao)}
                />
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", color: "var(--text-muted)", padding: 16 }}>
                  当前筛选下无飞机
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AircraftRow({ a, events, carriers, selected, expanded, onSelect }) {
  const myEvents = events.filter((e) => e.icao === a.icao);
  const associationTimeline = buildCarrierAssociationTimeline(events, a.icao);
  return (
    <>
      <tr
        className={`${selected ? "selected" : ""} ${expanded ? "expanded" : ""}`}
        onClick={onSelect}
      >
        <td className="icao">{a.icao}</td>
        <td>{a.aircraftType}</td>
        <td>{fmtDate(a.firstSeenDate)}</td>
        <td>{fmtDate(a.latestActivityDate)}</td>
        <td className="num">{a.totalTakeoffLandingCount}</td>
        <td>{a.inferredCarrierId ? carrierName(carriers, a.inferredCarrierId) : "—"}</td>
        <td>
          {a.carrierProbabilities.length > 0 ? (
            <span className="cai-conf">
              <span className="bar">
                <i style={{ width: `${Math.round((a.confidence || 0) * 100)}%` }} />
              </span>
              {Math.round((a.confidence || 0) * 100)}%
              {a.unboundSuspectedEventCount > 0 && (
                <span style={{ color: "var(--amber)", fontSize: 10 }}>
                  +{a.unboundSuspectedEventCount}未绑定
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: "var(--text-muted)" }}>—</span>
          )}
        </td>
        <td>
          <span className={`cai-badge ${statusBadgeClass(a.status)}`}>{a.status}</span>
        </td>
      </tr>
      {expanded && (
        <tr className="cai-detail">
          <td colSpan={8}>
            <div className="cai-detail-inner">
              <div>
                <h4>起降时间线（高度从零到正值 / 正值归零）</h4>
                <div className="cai-timeline">
                  {[...myEvents]
                    .sort((x, y) => Date.parse(x.time) - Date.parse(y.time))
                    .map((e) => (
                      <div key={e.id} className={`cai-tlev ${e.bindingStatus} ${e.suspected ? "" : "audit"}`}>
                        <span className={e.eventType === "takeoff" ? "et-to" : "et-ld"}>
                          {e.eventType === "takeoff" ? "起飞" : "降落"}
                        </span>
                        <span style={{ color: "#9fc4d4" }}>{fmtDateTime(e.time)}</span>
                        <span style={{ color: "#a9c3cf" }}>
                          {e.altitudeTransition.from}→{e.altitudeTransition.to} ft · {e.surfaceType}
                        </span>
                        <span className="bind">
                          {e.bindingStatus === "bound"
                            ? `${e.boundCarrierId} · ${e.distanceNm?.toFixed(0)}nm · Δ${e.carrierPositionTimeDeltaMinutes}m`
                            : e.suspected
                            ? "未绑定"
                            : "非海上（审计）"}
                        </span>
                      </div>
                    ))}
                  {myEvents.length === 0 && (
                    <span style={{ color: "var(--text-muted)" }}>无候选事件</span>
                  )}
                </div>
              </div>
              <div>
                <h4>关联航母变化图（按时间）</h4>
                <div className="cai-association-chart" aria-label={`${a.icao} 关联航母变化图`}>
                  {associationTimeline.map((event) => (
                    <div
                      className={`cai-association-point ${event.bindingStatus}`}
                      key={event.id}
                    >
                      <span className="carrier">{event.carrierId || "未绑定"}</span>
                      <span className="event-type">{event.eventType === "takeoff" ? "起飞" : "降落"}</span>
                      <time>{fmtDate(event.time)}</time>
                    </div>
                  ))}
                  {associationTimeline.length === 0 && (
                    <span style={{ color: "var(--text-muted)" }}>无疑似海上起降关联</span>
                  )}
                </div>
                <h4 className="cai-prob-heading">当前归属概率（分母=已绑定事件）</h4>
                <div className="cai-probs">
                  {a.carrierProbabilities.map((c) => (
                    <div className="cai-prob" key={c.carrierId}>
                      <span className="clbl">{carrierName(carriers, c.carrierId)}</span>
                      <span className="pbar">
                        <i style={{ width: `${Math.round(c.probability * 100)}%` }} />
                      </span>
                      <span className="pval">
                        {c.associationCount} / {Math.round(c.probability * 100)}%
                      </span>
                    </div>
                  ))}
                  {a.carrierProbabilities.length === 0 && (
                    <span style={{ color: "var(--text-muted)" }}>无已绑定事件</span>
                  )}
                </div>
                {a.unboundSuspectedEventCount > 0 && (
                  <p className="cai-unbound-note">
                    另有 {a.unboundSuspectedEventCount} 个未绑定疑似事件，不参与置信度分母。
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
