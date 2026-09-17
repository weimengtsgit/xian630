import React from 'react';
import { PORTS } from '../config/ports.js';
import PortCard from './PortCard.jsx';

// 2×2 四格港口看板（主任务区）：四港相互独立，单港失败仅该格显式报错
export default function PortGrid({ assessed, now, onRetry }) {
  return (
    <main className="port-grid" id="port-grid">
      {PORTS.map((p) => (
        <PortCard key={p.key} entry={assessed[p.key]} now={now} onRetry={onRetry} />
      ))}
    </main>
  );
}
