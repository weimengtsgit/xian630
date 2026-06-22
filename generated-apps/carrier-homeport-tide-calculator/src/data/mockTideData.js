/**
 * Mock 潮汐数据生成器
 *
 * 生成确定性的 72 小时潮汐序列与可出港窗口
 * 数据结构按未来公开潮汐预测 API 设计，真实适配器替换该 provider 即可
 */

const THRESHOLD = 12.8 // 航母吃水阈值 (米)
const HOURS_72 = 72 * 60 * 60 * 1000 // 72小时毫秒数

/**
 * 生成单个港口的潮汐数据
 */
export function generatePortData(port) {
  const baseTime = Date.now()
  const series = generateTideSeries(port.id, baseTime)
  const windows = computeWindows(series, THRESHOLD, baseTime)

  return {
    id: port.id,
    port,
    series,
    threshold: THRESHOLD,
    windows
  }
}

/**
 * 生成 72 小时潮汐序列
 * 使用正弦波模拟半日潮和日潮组合
 */
function generateTideSeries(portId, baseTime) {
  const series = []
  const pointsPerHour = 4 // 每小时4个数据点
  const totalPoints = 72 * pointsPerHour

  // 不同港口的潮汐参数
  const params = getTideParams(portId)

  for (let i = 0; i < totalPoints; i++) {
    const hours = i / pointsPerHour
    const t = baseTime + hours * 60 * 60 * 1000

    // 半日潮（12.42小时周期）
    const semiDiurnal = params.semiAmplitude * Math.sin((2 * Math.PI * hours) / 12.42 + params.semiPhase)

    // 日潮（24小时周期）
    const diurnal = params.diurnalAmplitude * Math.sin((2 * Math.PI * hours) / 24 + params.diurnalPhase)

    // 叠加基准潮高
    const height = params.meanLevel + semiDiurnal + diurnal

    series.push({ t, height })
  }

  return series
}

/**
 * 获取不同港口的潮汐特征参数
 */
function getTideParams(portId) {
  const params = {
    norfolk: {
      meanLevel: 12.5,
      semiAmplitude: 3.2,
      semiPhase: 0,
      diurnalAmplitude: 1.8,
      diurnalPhase: Math.PI / 4
    },
    sandiego: {
      meanLevel: 11.8,
      semiAmplitude: 2.8,
      semiPhase: Math.PI / 3,
      diurnalAmplitude: 2.2,
      diurnalPhase: Math.PI / 6
    },
    bremerton: {
      meanLevel: 13.2,
      semiAmplitude: 3.5,
      semiPhase: Math.PI / 2,
      diurnalAmplitude: 1.5,
      diurnalPhase: Math.PI / 3
    },
    yokosuka: {
      meanLevel: 12.0,
      semiAmplitude: 3.0,
      semiPhase: Math.PI / 6,
      diurnalAmplitude: 2.0,
      diurnalPhase: Math.PI / 2
    }
  }

  return params[portId] || params.norfolk
}

/**
 * 计算可出港时间窗
 * 窗口定义：潮高连续 >= 阈值的时段
 */
function computeWindows(series, threshold, baseTime) {
  const windows = []
  let windowStart = null

  for (let i = 0; i < series.length; i++) {
    const point = series[i]
    const isSafe = point.height >= threshold

    if (isSafe && windowStart === null) {
      // 窗口开启
      windowStart = point.t
    } else if (!isSafe && windowStart !== null) {
      // 窗口关闭
      windows.push({
        start: windowStart,
        end: series[i - 1].t
      })
      windowStart = null
    }
  }

  // 如果窗口在72小时结束时仍开放
  if (windowStart !== null) {
    windows.push({
      start: windowStart,
      end: series[series.length - 1].t
    })
  }

  // 过滤掉太短的窗口（< 30分钟）
  return windows.filter(w => (w.end - w.start) >= 30 * 60 * 1000)
}
