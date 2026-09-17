import React from 'react';
import { DRAFT_LIMIT_M, REFRESH_INTERVAL_MINUTES } from '../config/ports.js';

// 状态图例与刷新说明：六种状态语义 + 刷新策略 + 四格独立性 + 数据边界声明
export default function StatusFooter() {
  return (
    <footer className="status-footer">
      <div className="legend">
        <span className="lg open"><i aria-hidden="true">●</i> 窗口开放（潮高≥判定阈值）</span>
        <span className="lg closed"><i aria-hidden="true">●</i> 窗口关闭（倒计时至下一窗口）</span>
        <span className="lg error"><i aria-hidden="true">⚠</i> 取数失败（该格独立报错）</span>
        <span className="lg stale"><i aria-hidden="true">◆</i> 数据陈旧（超10分钟未成功刷新）</span>
        <span className="lg empty"><i aria-hidden="true">○</i> 无可用窗口（72h潮高均不足）</span>
        <span className="lg loading"><i aria-hidden="true">⟳</i> 加载中</span>
      </div>
      <p>
        刷新策略：每 {REFRESH_INTERVAL_MINUTES} 分钟自动刷新 + 手动刷新；倒计时由本地时钟每秒插值，取数失败不重置。
        四格数据链路完全独立，单港失败仅该格显式报错，不影响其他港口。
      </p>
      <p>
        数据边界（live_api）：诺福克 / 圣迭戈 / 布雷默顿来自
        <a href="https://tidesandcurrents.noaa.gov/stations.html" target="_blank" rel="noreferrer"> NOAA CO-OPS 官方预测 API</a>（MLLW 基准），
        横须贺来自<a href="https://www1.kaiho.mlit.go.jp/TIDE/pred2/" target="_blank" rel="noreferrer"> JCG 日本海上保安厅潮汐推算</a>（平均海面基准），
        均为免鉴权公开数据，运行时经同源代理取数。本看板不含任何演示或合成数据；取数失败按格显式报错，绝不伪造潮汐曲线。
      </p>
      <p>
        判定口径：出港吃水阈值 {DRAFT_LIMIT_M.toFixed(1)} m − 泊位基准水深 = 潮高判定阈值（与各港潮高同基准直接比较）；
        泊位水深为公开资料整理缺省值，待校准（见各港判定口径卡）。
      </p>
    </footer>
  );
}
