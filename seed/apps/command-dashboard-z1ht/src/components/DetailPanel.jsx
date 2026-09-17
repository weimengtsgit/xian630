import React from 'react';
import { DATA_QUALITY_LABELS, STALE_LEVEL_LABELS, DECK_WIND_THRESHOLD_KT, CARRIER_MAX_SPEED_KT } from '../constants.js';
import { formatDateTime, formatAge } from '../utils/timeFormat.js';
import RangeBar from './RangeBar.jsx';
import { DataUnavailable } from './DataUnavailable.jsx';

function kv(label, value, title) {
  return (
    <div className="kv" title={title || ''}>
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

function VerdictPill({ label, value }) {
  const cls = value === true ? 'ok' : value === false ? 'bad' : 'na';
  const text = value === true ? '满足' : value === false ? '不满足' : '无法判定';
  return (
    <div className={`verdict-pill ${cls}`}>
      <span className="verdict-label">{label}</span>
      <span className="verdict-value">{text}</span>
    </div>
  );
}

// 辅助信息区 · 单舰下钻详情（矢量合成计算明细可复核）
export default function DetailPanel({ carrier, aisNote }) {
  if (!carrier) {
    return (
      <section className="panel detail-panel" aria-label="单舰详情">
        <div className="panel-head"><h2>单舰评估详情</h2></div>
        <p className="detail-hint">在左侧航母态势矩阵中点击一艘航母，查看甲板风矢量合成计算明细与判定依据。</p>
      </section>
    );
  }

  const p = carrier.position;
  const w = carrier.wind;
  const d = carrier.deckWind;
  const isStaticPosition = p.source === 'static-default-region';

  return (
    <section className="panel detail-panel" aria-label={`单舰详情 ${carrier.name}`}>
      <div className="panel-head">
        <h2>单舰评估详情</h2>
        <span className={`badge quality-${carrier.dataQuality}`}>
          数据健康度：{DATA_QUALITY_LABELS[carrier.dataQuality]}
        </span>
      </div>

      <h3 className="detail-sec">① 舰艇身份</h3>
      <div className="kv-grid">
        {kv('舰名', carrier.name)}
        {kv('舷号', carrier.hullNumber)}
        {kv('舰级', carrier.className || '—')}
        {kv('在册状态', carrier.statusText)}
        {kv('母港', isStaticPosition ? `${carrier.homeport}（公开常识）` : carrier.homeport)}
        {carrier.airWing ? kv('舰载航空联队', carrier.airWing) : null}
        {carrier.aircraftCarried ? kv('舰载机', carrier.aircraftCarried) : null}
      </div>

      <h3 className="detail-sec">② 位置与时效</h3>
      <div className="kv-grid">
        {kv('坐标', p.lat != null && p.lon != null ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '—',
          isStaticPosition ? '默认活动区域代表点（公开常识，非当前位置）' : '公开情报位置库坐标')}
        {kv('推定海域', p.seaArea || '—', '按公开常识海域框推定')}
        {kv('位置时间', p.observedAt ? formatDateTime(p.observedAt) : '不可用')}
        {kv('位置时效', p.observedAt ? `${p.ageLabel}（${STALE_LEVEL_LABELS[p.staleLevel]}）` : '不可用')}
        {!isStaticPosition && kv('当前航向 / 航速', p.heading != null && p.speedKt != null ? `${Math.round(p.heading)}° / ${p.speedKt.toFixed(1)} kn` : '—', '本体字段，仅展示参考，不参与合成计算')}
        {kv('位置来源', p.sourceLabel)}
      </div>
      {isStaticPosition && (
        <p className="pos-warning">⚠ 位置库不可用，当前按内置默认活动区域代表点评估——非当前位置，结论仅代表默认区域风况。</p>
      )}

      <h3 className="detail-sec">③ 活动区域 10 米风场</h3>
      {w ? (
        <div className="kv-grid">
          {kv('风速', `${w.speedKt.toFixed(1)} kn`)}
          {kv('风向', `${w.directionText} ${Math.round(w.directionDeg)}°`)}
          {kv('数据时间（validTime）', `${formatDateTime(w.validTime, { utc: true })} UTC`)}
          {kv('槽龄', w.slotAgeHours != null ? formatAge(w.slotAgeHours) : '—', w.slotAgeHours != null && w.slotAgeHours > 2 ? '超过 2 小时，已标注陈旧' : '')}
          {kv('格点坐标', `${w.gridLat != null ? w.gridLat.toFixed(4) : '—'}, ${w.gridLon != null ? w.gridLon.toFixed(4) : '—'}`, 'GFS 网格吸附点（约 0.11° 分辨率，区域近似评估）')}
          {kv('风场来源', w.sourceLabel)}
        </div>
      ) : (
        <DataUnavailable
          compact
          title="该舰风场数据不可用"
          reason={carrier.windError || '风场取数失败'}
          note="风场恢复后此处将显示该舰活动区域 10 米风速/风向，判定「无法判定」不做估算。"
        />
      )}

      <h3 className="detail-sec">④ 甲板风矢量合成计算明细（可复核）</h3>
      {w && d.minDeckWindKt != null ? (
        <>
          <RangeBar
            minDeckWindKt={d.minDeckWindKt}
            maxDeckWindKt={d.maxDeckWindKt}
            thresholdKt={d.thresholdKt}
            naturalWindKt={d.naturalWindKt}
          />
          <table className="calc-table">
            <tbody>
              <tr><th>自然风 W（10 米，当前小时槽）</th><td>{d.naturalWindKt.toFixed(1)} kn</td></tr>
              <tr><th>航母最大航速（固定常量）</th><td>{d.maxSpeedKt} kn</td></tr>
              <tr><th>最小甲板风 |W−30|</th><td className="num">{d.minDeckWindKt.toFixed(1)} kn</td></tr>
              <tr><th>最大甲板风 W+30</th><td className="num">{d.maxDeckWindKt.toFixed(1)} kn</td></tr>
              <tr><th>甲板风阈值（固定常量）</th><td>{d.thresholdKt} kn</td></tr>
            </tbody>
          </table>
        </>
      ) : (
        <p className="calc-unavailable">风场数据缺失，合成计算无法进行——不展示估算值（判定「无法判定」）。</p>
      )}

      <h3 className="detail-sec">⑤ 判定结论与依据</h3>
      <div className="verdict-row">
        <VerdictPill label="无弹射器辅助起飞" value={d.unassistedTakeoff} />
        <VerdictPill label="安全着舰" value={d.safeRecovery} />
        <span className={`badge grade-${d.grade} grade-lg`}>{d.gradeLabel}</span>
      </div>
      <p className="basis-text">{d.basisText}</p>
      {carrier.dataQuality === 'stale' && (
        <p className="pos-warning">⚠ 数据陈旧（位置时效超限或风场槽龄 &gt; 2 小时），上述结论仅供参考。</p>
      )}

      <h3 className="detail-sec">⑥ 数据链路与佐证</h3>
      <div className="kv-grid">
        {kv('位置链路', p.sourceLabel)}
        {kv('风场链路', w ? w.sourceLabel : '不可用')}
        {kv('计算时刻', formatDateTime(carrier.computedAt))}
      </div>
      {p.source === 'ontology-daas' && (
        <div className="ais-note">
          {aisNote && aisNote.loading ? 'AIS 佐证查询中…' : null}
          {aisNote && !aisNote.loading && aisNote.available && (
            <span>
              AIS 佐证（可选）：最新存档点 {aisNote.latestTime ? formatDateTime(aisNote.latestTime) : '时间缺失'}
              {aisNote.sogKt != null ? ` · ${aisNote.sogKt.toFixed(1)} kn` : ''}
              {` · 本小样本 ${aisNote.pointCount} 点 · ${aisNote.note}`}
            </span>
          )}
          {aisNote && !aisNote.loading && !aisNote.available && <span>AIS 佐证未启用：{aisNote.note}</span>}
          {!aisNote && p.mmsi ? 'AIS 佐证：待查询' : null}
          {!p.mmsi ? 'AIS 佐证：该舰无 MMSI，未启用' : null}
        </div>
      )}
      <p className="detail-footnote">
        判定口径：阈值 {DECK_WIND_THRESHOLD_KT} 节 / 最大航速 {CARRIER_MAX_SPEED_KT} 节为固定常量，不随报文数据变化；
        简化模型未计入弹射器状态、机型、海况等因素，结论仅供值班参考。
      </p>
    </section>
  );
}
