import { parentPort, workerData } from "node:worker_threads";
import { analyzeVesselCarrierRelations } from "./carrierAffiliation.js";

try {
  // Worker 只负责纯计算，不触碰 HTTP、快照文件或本体凭据。
  const result = analyzeVesselCarrierRelations(workerData);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
