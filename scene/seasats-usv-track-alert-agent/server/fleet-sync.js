import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beginOrResumeSync, markPageSynced, markSyncComplete, readSyncState, writeAisRows } from "./fleet-store.js";

const appRoot = resolve(new URL("..", import.meta.url).pathname);
const skillConfig = resolve(appRoot, "..", "..", ".claude", "skills", "carrier-affiliation-data-skill", "config", "ontology.env");
const pageSize = 1000;
const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const maxPages = maxPagesArg ? Number(maxPagesArg.split("=")[1]) : Infinity;
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
// 用户已授权加速首次建库，仍保留上限以避免本地连接池和本体服务无限膨胀。
const concurrency = Math.min(64, Math.max(1, Number(concurrencyArg ? concurrencyArg.split("=")[1] : 16)) || 16);

function fileEnv() {
  return Object.fromEntries(readFileSync(skillConfig, "utf8").split(/\r?\n/).flatMap((line) => {
    const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return matched ? [[matched[1], matched[2]]] : [];
  }));
}

const env = fileEnv();
const config = {
  baseUrl: process.env.ONTOLOGY_API_BASE_URL || env.ONTOLOGY_API_BASE_URL,
  token: process.env.ONTOLOGY_AUTH_TOKEN || env.ONTOLOGY_AUTH_TOKEN,
  spaceId: process.env.ONTOLOGY_SPACE_ID || env.ONTOLOGY_SPACE_ID,
  scopeType: process.env.ONTOLOGY_SCOPE_TYPE || env.ONTOLOGY_SCOPE_TYPE || "Space",
};
if (!config.baseUrl || !config.token || !config.spaceId) throw new Error("SOURCE_AUTH_MISSING");

const columns = ["mmsi", "shipName", "latitude", "longitude", "sog", "courseOverGround", "trueHeading", "navigationalStatus", "typeCode", "startTime", "dataUpdateTime"];
async function fetchPage(pageIndex) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/daasDMS/entity/RawAISData/list`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, Spaceid: config.spaceId, scopeType: config.scopeType, "Content-Type": "application/json" },
        body: JSON.stringify({ columns, pageParam: { pageIndex, limit: pageSize }, rowType: "map" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`ONTOLOGY_HTTP_${response.status}`);
      const data = await response.json();
      if (data.resultCode !== 200 || data.details?.resultCode !== 200) throw new Error(`ONTOLOGY_RESULT_${data.details?.resultCode || data.resultCode}`);
      return data.details;
    } catch (error) {
      lastError = error;
      // 高并发下的瞬态 400/超时重试，避免单页偶发失败中断数小时的全量同步。
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
  throw new Error(`PAGE_${pageIndex}_FAILED: ${lastError instanceof Error ? lastError.message : "UNKNOWN"}`);
}

// 全量接口没有稳定游标和排序；同步过程逐页落库、按 MMSI 与最新时间合并，可中断后续跑。
const first = await fetchPage(1);
let state = beginOrResumeSync({ totalRecords: Number(first.pageParam?.recordTotal || 0), pageSize });
let page = state.next_page;
let processed = 0;
const totalPages = Math.ceil(state.total_records / pageSize);
while (page <= totalPages && processed < maxPages) {
  const batchPages = Array.from(
    { length: Math.min(concurrency, totalPages - page + 1, maxPages - processed) },
    (_, index) => page + index,
  );
  const detailsBatch = await Promise.all(batchPages.map((pageIndex) => pageIndex === 1 ? first : fetchPage(pageIndex)));
  for (const [index, details] of detailsBatch.entries()) {
    const pageIndex = batchPages[index];
    const rows = details.rows || [];
    writeAisRows(rows);
    markPageSynced({ page: pageIndex, rows: rows.length });
    processed += 1;
    if (processed % 25 === 0 || rows.length < pageSize) console.log(JSON.stringify({ page: pageIndex, processed, totalPages, fetchedRows: rows.length, concurrency }));
    if (rows.length < pageSize) break;
  }
  page += batchPages.length;
}
state = readSyncState();
if (state.next_page > totalPages) markSyncComplete();
console.log(JSON.stringify({ status: readSyncState(), stoppedAfterPages: processed }));
