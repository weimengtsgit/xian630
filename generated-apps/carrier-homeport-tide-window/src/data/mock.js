/**
 * Mock tide data generator for 4 carrier homeports
 * Generates deterministic 72-hour tide series and launch windows
 * Structure matches future public tide prediction API for easy adapter replacement
 */

const PORTS = [
  { id: 'norfolk', name: '诺福克', nameEn: 'Norfolk', lat: 36.85, lon: -76.29, phaseShift: 0 },
  { id: 'san-diego', name: '圣迭戈', nameEn: 'San Diego', lat: 32.71, lon: -117.16, phaseShift: 4.5 },
  { id: 'bremerton', name: '布雷默顿', nameEn: 'Bremerton', lat: 47.56, lon: -122.63, phaseShift: 2.8 },
  { id: 'yokosuka', name: '横须贺', nameEn: 'Yokosuka', lat: 35.28, lon: 139.67, phaseShift: 6.2 }
];

const THRESHOLD = 12.8; // meters - carrier draft threshold
const HOURS_HORIZON = 72;
const INTERVAL_MINUTES = 10;

/**
 * Generate tide height using semi-diurnal tide model
 * @param {Date} t - timestamp
 * @param {number} phaseShift - phase offset in hours
 * @returns {number} tide height in meters
 */
function tideHeight(t, phaseShift) {
  const hoursSinceEpoch = t.getTime() / (1000 * 60 * 60);
  const phase = (hoursSinceEpoch + phaseShift) * 2 * Math.PI / 12.42; // semi-diurnal tide ~12.42h period
  const primary = 7.5 * Math.sin(phase); // primary component
  const secondary = 2.0 * Math.sin(2 * phase + Math.PI / 3); // secondary harmonic
  const mean = 10.5; // mean tide level
  return mean + primary + secondary;
}

/**
 * Build 72-hour tide series for a port
 * @param {object} port - port configuration
 * @param {Date} startTime - simulation start time
 * @returns {Array} [{t: Date, height: number}]
 */
export function buildSeries(port, startTime) {
  const series = [];
  const totalPoints = (HOURS_HORIZON * 60) / INTERVAL_MINUTES;

  for (let i = 0; i < totalPoints; i++) {
    const t = new Date(startTime.getTime() + i * INTERVAL_MINUTES * 60 * 1000);
    const height = tideHeight(t, port.phaseShift);
    series.push({ t, height });
  }

  return series;
}

/**
 * Compute launch windows where tide >= threshold
 * @param {Array} series - tide time series
 * @param {number} threshold - minimum tide height
 * @returns {Array} [{start: Date, end: Date, duration: number}]
 */
export function computeWindows(series, threshold) {
  const windows = [];
  let windowStart = null;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    const isAbove = point.height >= threshold;

    if (isAbove && windowStart === null) {
      windowStart = point.t;
    } else if (!isAbove && windowStart !== null) {
      const duration = (series[i - 1].t - windowStart) / (1000 * 60); // minutes
      windows.push({
        start: windowStart,
        end: series[i - 1].t,
        duration
      });
      windowStart = null;
    }
  }

  // Close final window if still open
  if (windowStart !== null) {
    const lastPoint = series[series.length - 1];
    const duration = (lastPoint.t - windowStart) / (1000 * 60);
    windows.push({
      start: windowStart,
      end: lastPoint.t,
      duration
    });
  }

  return windows;
}

/**
 * Get current tide status for a port
 * @param {Array} series - tide time series
 * @param {Array} windows - launch windows
 * @param {Date} currentTime - current simulation time
 * @param {number} threshold - threshold value
 * @returns {object} current status
 */
export function getCurrentStatus(series, windows, currentTime, threshold) {
  // Find current tide height (interpolate if needed)
  let currentHeight = 0;
  for (let i = 0; i < series.length - 1; i++) {
    if (currentTime >= series[i].t && currentTime < series[i + 1].t) {
      const ratio = (currentTime - series[i].t) / (series[i + 1].t - series[i].t);
      currentHeight = series[i].height + ratio * (series[i + 1].height - series[i].height);
      break;
    }
  }

  // Check if currently in a window
  const currentWindow = windows.find(w => currentTime >= w.start && currentTime <= w.end);
  const isOpen = currentWindow !== null;

  // Find next window
  const nextWindow = windows.find(w => w.start > currentTime);

  // Calculate countdown
  let countdown = null;
  let countdownTarget = null;

  if (isOpen && currentWindow) {
    countdown = Math.floor((currentWindow.end - currentTime) / 1000); // seconds until window closes
    countdownTarget = 'close';
  } else if (nextWindow) {
    countdown = Math.floor((nextWindow.start - currentTime) / 1000); // seconds until window opens
    countdownTarget = 'open';
  }

  return {
    currentHeight,
    isOpen,
    currentWindow,
    nextWindow,
    countdown,
    countdownTarget
  };
}

/**
 * Generate complete port data
 * @param {Date} startTime - simulation start time
 * @returns {Array} port data for all 4 homeports
 */
export function generatePortData(startTime) {
  return PORTS.map(port => {
    const series = buildSeries(port, startTime);
    const windows = computeWindows(series, THRESHOLD);

    return {
      port,
      series,
      threshold: THRESHOLD,
      windows
    };
  });
}
