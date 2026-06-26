import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const files = [
  "src/main.jsx",
  "src/app/App.jsx",
  "src/components/TideCurve.jsx",
  "src/data/mock.js",
  "src/styles/global.css",
];

const missingFiles = files.filter((file) => !existsSync(join(root, file)));
if (missingFiles.length > 0) {
  throw new Error(`Missing blueprint-structured files: ${missingFiles.join(", ")}`);
}

const source = files
  .map((file) => readFileSync(join(root, file), "utf8"))
  .join("\n");

const requiredMarkers = [
  "tide-kpis",
  "tide-source",
  "DetailPanel",
  "tide-detail",
  "REFRESH_CADENCE_LABEL",
  "computeWindows",
  "TideCurve",
  "threshold-label",
  "windowCount",
];

const missingMarkers = requiredMarkers.filter((marker) => !source.includes(marker));
if (missingMarkers.length > 0) {
  throw new Error(`Generated app is missing blueprint parity markers: ${missingMarkers.join(", ")}`);
}

console.log("Blueprint parity markers present.");
