/**
 * Mock tide data generator for carrier homeport tide window calculator
 * Generates deterministic 72-hour tide series and computes departure windows
 * based on 12.8m draft threshold
 */

const PORTS = [
  { id: 'norfolk', name: '诺福克', lat: 36.85, lon: -76.29 },
  { id: 'san-diego', name: '圣迭戈', lat: 32.71, lon: -117.16 },
  { id: 'bremerton', name: '布雷默顿', lat: 47.56, lon: -122.63 },
  { id: 'yokosuka', name: '横须贺', lat: 35.28, lon: 139.67 }
];

const THRESHOLD = 12.8; // meters
const HOURS_72 = 72 * 60; // minutes

/**
 * Generate sinusoidal tide curve for a port
 * @param {string} portId - Port identifier
 * @param {number} baseTime - Base timestamp in milliseconds
 * @param {number} durationMinutes - Duration in minutes
 * @returns {Array} Array of {t: timestamp, height: meters}
 */
function buildSeries(portId, baseTime, durationMinutes = HOURS_72) {
  const series = [];
  const interval = 10; // minutes between data points

  // Port-specific tide characteristics
  const tideParams = {
    'norfolk': { amplitude: 1.2, period: 12.42, mean: 12.5, phase: 0 },
    'san-diego': { amplitude: 1.8, period: 12.42, mean: 13.0, phase: 1.5 },
    'bremerton': { amplitude: 2.5, period: 12.42, mean: 12.2, phase: 3.0 },
    'yokosuka': { amplitude: 1.5, period: 12.42, mean: 12.9, phase: 2.0 }
  };

  const params = tideParams[portId];

  for (let min = 0; min <= durationMinutes; min += interval) {
    const t = baseTime + min * 60 * 1000;
    const hours = min / 60;

    // Simple sinusoidal model: height = mean + amplitude * sin(2π * hours / period + phase)
    const height = params.mean + params.amplitude * Math.sin(
      (2 * Math.PI * hours / params.period) + params.phase
    );

    series.push({ t, height: parseFloat(height.toFixed(2)) });
  }

  return series;
}

/**
 * Compute departure windows where tide height >= threshold
 * @param {Array} series - Tide series data
 * @param {number} threshold - Minimum tide height for departure
 * @returns {Array} Array of {start, end, duration} windows
 */
function computeWindows(series, threshold) {
  const windows = [];
  let windowStart = null;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    const isAboveThreshold = point.height >= threshold;

    if (isAboveThreshold && windowStart === null) {
      // Window opening
      windowStart = point.t;
    } else if (!isAboveThreshold && windowStart !== null) {
      // Window closing
      windows.push({
        start: windowStart,
        end: series[i - 1].t,
        duration: (series[i - 1].t - windowStart) / (60 * 1000) // minutes
      });
      windowStart = null;
    }
  }

  // Close last window if still open at end of series
  if (windowStart !== null) {
    const lastPoint = series[series.length - 1];
    windows.push({
      start: windowStart,
      end: lastPoint.t,
      duration: (lastPoint.t - windowStart) / (60 * 1000)
    });
  }

  return windows;
}

/**
 * Get current tide height at a specific time
 * @param {Array} series - Tide series data
 * @param {number} currentTime - Current timestamp
 * @returns {number} Interpolated tide height
 */
function getCurrentHeight(series, currentTime) {
  // Find surrounding points
  for (let i = 0; i < series.length - 1; i++) {
    if (currentTime >= series[i].t && currentTime <= series[i + 1].t) {
      // Linear interpolation
      const ratio = (currentTime - series[i].t) / (series[i + 1].t - series[i].t);
      return series[i].height + ratio * (series[i + 1].height - series[i].height);
    }
  }
  return series[series.length - 1].height;
}

/**
 * Get next window after current time
 * @param {Array} windows - Computed windows
 * @param {number} currentTime - Current timestamp
 * @returns {Object|null} Next window or null
 */
function getNextWindow(windows, currentTime) {
  for (const window of windows) {
    if (window.start > currentTime) {
      return window;
    }
    if (currentTime >= window.start && currentTime <= window.end) {
      return { ...window, isActive: true };
    }
  }
  return null;
}

/**
 * Generate mock tide data for all ports
 * @param {number} baseTime - Base timestamp (usually Date.now())
 * @returns {Array} Port tide data with series and windows
 */
export function generateMockTideData(baseTime = Date.now()) {
  return PORTS.map(port => {
    const series = buildSeries(port.id, baseTime);
    const windows = computeWindows(series, THRESHOLD);

    return {
      port: port.name,
      portId: port.id,
      series,
      threshold: THRESHOLD,
      windows,
      lat: port.lat,
      lon: port.lon
    };
  });
}

/**
 * Get current status for a port
 * @param {Object} portData - Port tide data
 * @param {number} currentTime - Current timestamp
 * @returns {Object} Current status with height, window info, countdown
 */
export function getCurrentStatus(portData, currentTime) {
  const currentHeight = getCurrentHeight(portData.series, currentTime);
  const nextWindow = getNextWindow(portData.windows, currentTime);

  const isWindowOpen = nextWindow && nextWindow.isActive;
  const meetsThreshold = currentHeight >= THRESHOLD;

  let countdown = null;
  let countdownLabel = '';

  if (isWindowOpen) {
    countdown = Math.floor((nextWindow.end - currentTime) / (60 * 1000));
    countdownLabel = '窗口关闭倒计时';
  } else if (nextWindow) {
    countdown = Math.floor((nextWindow.start - currentTime) / (60 * 1000));
    countdownLabel = '距离下一个窗口';
  }

  return {
    currentHeight: parseFloat(currentHeight.toFixed(2)),
    meetsThreshold,
    isWindowOpen,
    nextWindow,
    countdown,
    countdownLabel
  };
}
