/**
 * Mock 潮汐数据生成器
 *
 * 生成未来 72 小时的潮汐数据和可出港时间窗。
 * 所有数据为演示用途，不代表真实潮汐情况。
 */

const THRESHOLD = 12.8; // 航母吃水阈值（米）
const HOURS_72 = 72 * 60 * 60 * 1000; // 72 小时（毫秒）
const SAMPLE_INTERVAL = 15 * 60 * 1000; // 每 15 分钟采样一次

/**
 * 生成单个港口的潮汐数据
 */
export function generatePortData(port) {
  const now = Date.now();
  const series = buildTideSeries(port.id, now, HOURS_72);
  const windows = computeWindows(series, THRESHOLD);

  return {
    id: port.id,
    name: port.name,
    nameEn: port.nameEn,
    timezone: port.timezone,
    threshold: THRESHOLD,
    series,
    windows
  };
}

/**
 * 生成潮汐时间序列
 *
 * 使用正弦波模拟潮汐周期（约12.4小时一个周期），
 * 叠加随机扰动和港口特征偏移。
 */
function buildTideSeries(portId, startTime, duration) {
  const series = [];
  const points = Math.ceil(duration / SAMPLE_INTERVAL);

  // 港口特征参数
  const params = getPortParams(portId);

  for (let i = 0; i <= points; i++) {
    const t = startTime + i * SAMPLE_INTERVAL;
    const hourOffset = (i * SAMPLE_INTERVAL) / (1000 * 60 * 60);

    // 主潮汐周期（12.4小时）
    const primaryTide = params.amplitude * Math.sin((2 * Math.PI * hourOffset) / 12.4 + params.phase);

    // 次级潮汐周期（24.8小时，较小振幅）
    const secondaryTide = (params.amplitude * 0.3) * Math.sin((2 * Math.PI * hourOffset) / 24.8 + params.phase + 1.2);

    // 随机扰动
    const noise = (Math.random() - 0.5) * 0.4;

    // 合成潮高
    const height = params.mean + primaryTide + secondaryTide + noise;

    series.push({
      t,
      height: Math.max(8.0, Math.min(16.0, height)) // 限制在合理范围
    });
  }

  return series;
}

/**
 * 获取港口特征参数
 */
function getPortParams(portId) {
  const params = {
    'norfolk': {
      mean: 12.5,
      amplitude: 2.8,
      phase: 0
    },
    'san-diego': {
      mean: 13.2,
      amplitude: 2.2,
      phase: 1.5
    },
    'bremerton': {
      mean: 12.0,
      amplitude: 3.5,
      phase: 0.8
    },
    'yokosuka': {
      mean: 13.0,
      amplitude: 2.6,
      phase: 2.3
    }
  };

  return params[portId] || params['norfolk'];
}

/**
 * 计算可出港时间窗
 *
 * 找出所有连续满足 height >= threshold 的时间段。
 */
function computeWindows(series, threshold) {
  const windows = [];
  let windowStart = null;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    const meetsThreshold = point.height >= threshold;

    if (meetsThreshold && windowStart === null) {
      // 窗口开始
      windowStart = point.t;
    } else if (!meetsThreshold && windowStart !== null) {
      // 窗口结束
      windows.push({
        start: windowStart,
        end: point.t
      });
      windowStart = null;
    }
  }

  // 处理最后一个窗口（如果在系列末尾仍然开放）
  if (windowStart !== null) {
    windows.push({
      start: windowStart,
      end: series[series.length - 1].t
    });
  }

  return windows;
}

/**
 * 格式化时间戳为可读字符串
 */
export function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
