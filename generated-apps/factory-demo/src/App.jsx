import React from "react";
import "./style.css";

export function App() {
  return (
    <div className="app-shell">
      <aside className="side-panel">
        <span className="eyebrow">SOFTWARE FACTORY GENERATED</span>
        <h1>航母编队月度航迹复盘</h1>
        <p>展示航母编队近一个月在东海方向的航行轨迹、关键时间点事件和阶段性态势摘要。</p>
        <div className="metrics">
          <span><strong>30</strong> 天</span>
          <span><strong>8</strong> 事件</span>
          <span><strong>东海</strong> 海域</span>
        </div>
      </aside>
      <main className="map-stage">
        <div className="coast coast-cn">浙江 / 福建</div>
        <div className="coast coast-jp">琉球方向</div>
        <div className="coast coast-tw">台湾岛</div>
        <svg className="track" viewBox="0 0 900 560" role="img" aria-label="航母编队近一个月航迹">
          <path d="M95 365 C170 315 235 300 310 270 S470 220 560 185 S705 145 805 105" />
          {[95, 205, 315, 425, 535, 650, 760, 805].map((x, index) => (
            <g key={x}>
              <circle cx={x} cy={365 - index * 36} r="7" />
              <text x={x + 13} y={369 - index * 36}>D+{index * 4}</text>
            </g>
          ))}
        </svg>
        <section className="event-board">
          <h2>时间点事件</h2>
          {["补给航渡", "舰载机训练", "编队转向", "远海协同", "靠近识别区"].map(item => (
            <div className="event" key={item}>
              <span></span>
              <p>{item}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
