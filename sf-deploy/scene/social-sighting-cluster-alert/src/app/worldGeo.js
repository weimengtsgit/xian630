// Simplified land silhouettes for the global scatter map. These are coarse
// polygons (NOT accurate coastlines) drawn as inline SVG paths so the board is
// fully self-contained and builds offline (no maplibre / tile server).
//
// Coordinate system: equirectangular. We map lon [-180,180] -> x [0,W] and
// lat [85,-65] -> y [0,H] (slightly clipped poles for sea-area focus).
//
// Each entry: { name, d } where d is an SVG path string in lon/lat space.
// The WorldMap component scales these to pixels.
//
// NOTE: Deliberately crude silhouettes — the focus is the global SEA area where
// sightings scatter, not cartographic accuracy.

export const MAP_LON_MIN = -180;
export const MAP_LON_MAX = 180;
export const MAP_LAT_MIN = -65;
export const MAP_LAT_MAX = 85;

// Coarse land masses. Points are [lon, lat].
export const LAND = [
  {
    name: "North America",
    pts: [
      [-168, 66], [-156, 71], [-140, 70], [-128, 70], [-110, 73], [-95, 78],
      [-78, 76], [-62, 70], [-55, 60], [-58, 50], [-66, 44], [-72, 40],
      [-78, 33], [-82, 26], [-88, 29], [-96, 28], [-100, 25], [-108, 23],
      [-116, 30], [-124, 40], [-126, 50], [-135, 56], [-152, 60], [-168, 66],
    ],
  },
  {
    name: "South America",
    pts: [
      [-78, 12], [-70, 11], [-60, 8], [-50, 0], [-42, -5], [-38, -14],
      [-40, -25], [-48, -33], [-58, -40], [-66, -45], [-72, -52], [-72, -55],
      [-68, -50], [-64, -40], [-72, -30], [-76, -18], [-80, -8], [-79, 0],
      [-78, 12],
    ],
  },
  {
    name: "Europe",
    pts: [
      [-10, 36], [-6, 38], [0, 44], [8, 44], [14, 38], [20, 40], [28, 42],
      [30, 46], [40, 48], [44, 56], [40, 64], [30, 66], [18, 64], [10, 60],
      [4, 58], [-4, 54], [-10, 50], [-10, 44], [-10, 36],
    ],
  },
  {
    name: "Africa",
    pts: [
      [-10, 36], [0, 34], [10, 32], [20, 30], [32, 30], [42, 22], [50, 16],
      [52, 10], [44, 0], [40, -8], [38, -18], [32, -28], [26, -34], [20, -34],
      [16, -28], [12, -18], [8, -8], [0, -2], [-8, 6], [-12, 14], [-10, 22],
      [-10, 30], [-10, 36],
    ],
  },
  {
    name: "Asia",
    pts: [
      [28, 42], [40, 40], [50, 38], [58, 32], [64, 38], [72, 42], [80, 44],
      [88, 48], [100, 50], [112, 52], [124, 54], [140, 58], [150, 60],
      [160, 60], [172, 66], [178, 70], [170, 74], [150, 76], [120, 76],
      [90, 78], [60, 74], [44, 70], [40, 64], [44, 56], [40, 48], [30, 46],
      [28, 42],
    ],
  },
  {
    name: "Southeast Asia",
    pts: [
      [95, 20], [100, 14], [105, 10], [110, 2], [116, -2], [122, -6],
      [128, -8], [132, -2], [126, 6], [120, 10], [114, 14], [108, 18],
      [100, 20], [95, 20],
    ],
  },
  {
    name: "Australia",
    pts: [
      [114, -22], [122, -16], [132, -12], [142, -10], [148, -18], [152, -26],
      [148, -36], [140, -38], [130, -34], [120, -34], [114, -28], [114, -22],
    ],
  },
  {
    name: "Greenland",
    pts: [
      [-50, 60], [-40, 60], [-24, 64], [-18, 70], [-22, 78], [-36, 82],
      [-52, 80], [-58, 72], [-54, 64], [-50, 60],
    ],
  },
  {
    name: "Antarctica",
    pts: [
      [-180, -62], [-120, -66], [-60, -70], [0, -68], [60, -68], [120, -66],
      [180, -62], [180, -90], [-180, -90], [-180, -62],
    ],
  },
  {
    name: "Japan",
    pts: [
      [130, 32], [134, 33], [138, 35], [141, 39], [142, 43], [145, 45],
      [141, 42], [137, 37], [132, 34], [130, 32],
    ],
  },
  {
    name: "British Isles",
    pts: [
      [-8, 50], [-4, 50], [0, 52], [-2, 56], [-6, 58], [-8, 54], [-8, 50],
    ],
  },
];

// Reference sea-area labels placed on the map for orientation.
export const SEA_LABELS = [
  { name: "Pacific", lon: -150, lat: 20 },
  { name: "Philippine Sea", lon: 134, lat: 20 },
  { name: "South China Sea", lon: 113, lat: 12 },
  { name: "Indian Ocean", lon: 70, lat: -10 },
  { name: "Arabian Sea", lon: 60, lat: 18 },
  { name: "Mediterranean", lon: 16, lat: 35 },
  { name: "Atlantic", lon: -36, lat: 20 },
  { name: "Bering Sea", lon: -174, lat: 58 },
  { name: "Norwegian Sea", lon: 5, lat: 66 },
  { name: "Bab-el-Mandeb", lon: 44, lat: 12 },
];

// Convert lon/lat -> SVG x/y given width/height.
export function project(lon, lat, width, height) {
  const x =
    ((lon - MAP_LON_MIN) / (MAP_LON_MAX - MAP_LON_MIN)) * width;
  const y =
    ((MAP_LAT_MAX - lat) / (MAP_LAT_MAX - MAP_LAT_MIN)) * height;
  return [x, y];
}
