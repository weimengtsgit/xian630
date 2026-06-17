import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { trajectoryPath } from '../data/trajectoryData'
import './MapView.css'

// 卫星瓦片URL
const tileUrl =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

// 地图样式配置
const style = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [tileUrl],
      tileSize: 256,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'satellite',
      type: 'raster',
      source: 'satellite',
      paint: {
        'raster-brightness-min': 0,
        'raster-brightness-max': 0.62,
        'raster-contrast': 0.26,
        'raster-saturation': -0.08,
      },
    },
  ],
}

// 使用Canvas生成航母图标
function createCarrierIcon(callback) {
  const canvas = document.createElement('canvas')
  const size = 64
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    callback(null)
    return
  }

  const centerX = size / 2
  const centerY = size / 2

  // 外圈光晕
  ctx.beginPath()
  ctx.arc(centerX, centerY, 28, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 247, 255, 0.15)'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(centerX, centerY, 24, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 247, 255, 0.1)'
  ctx.fill()

  // 航母甲板轮廓（梯形）
  ctx.beginPath()
  ctx.moveTo(16, centerY + 4) // 左下
  ctx.lineTo(48, centerY + 4) // 右下
  ctx.lineTo(44, centerY - 12) // 右上
  ctx.lineTo(20, centerY - 12) // 左上
  ctx.closePath()
  ctx.fillStyle = '#1a2a3a'
  ctx.fill()
  ctx.strokeStyle = '#00f7ff'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 甲板跑道
  ctx.beginPath()
  ctx.roundRect(18, centerY - 14, 28, 4, 1)
  ctx.fillStyle = 'rgba(0, 247, 255, 0.8)'
  ctx.fill()

  // 舰岛
  ctx.beginPath()
  ctx.moveTo(28, centerY - 18)
  ctx.lineTo(36, centerY - 18)
  ctx.lineTo(34, centerY - 24)
  ctx.lineTo(30, centerY - 24)
  ctx.closePath()
  ctx.fillStyle = 'rgba(0, 247, 255, 0.6)'
  ctx.fill()
  ctx.strokeStyle = '#00f7ff'
  ctx.lineWidth = 1
  ctx.stroke()

  // 中心红点
  ctx.beginPath()
  ctx.arc(centerX, centerY - 4, 4, 0, Math.PI * 2)
  ctx.fillStyle = '#ff4444'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(centerX, centerY - 4, 2, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // 方向指示（十字）
  ctx.strokeStyle = '#00f7ff'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'

  // 上
  ctx.beginPath()
  ctx.moveTo(centerX, 10)
  ctx.lineTo(centerX, 18)
  ctx.stroke()

  // 下
  ctx.beginPath()
  ctx.moveTo(centerX, 42)
  ctx.lineTo(centerX, 50)
  ctx.stroke()

  // 左
  ctx.beginPath()
  ctx.moveTo(12, centerY - 2)
  ctx.lineTo(20, centerY - 2)
  ctx.stroke()

  // 右
  ctx.beginPath()
  ctx.moveTo(44, centerY - 2)
  ctx.lineTo(52, centerY - 2)
  ctx.stroke()

  // 转换为Image对象
  const img = new Image()
  img.onload = () => callback(img)
  img.onerror = () => callback(null)
  img.src = canvas.toDataURL()
}

function MapView({ carrierPosition, onCarrierClick }) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return
    }

    // 创建地图实例
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style,
      center: [122.5, 30.0],
      zoom: 5.5,
      minZoom: 3,
      maxZoom: 10,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    mapRef.current = map

    map.on('load', () => {
      // 生成并添加航母图标
      createCarrierIcon((image) => {
        if (!image) return

        map.addImage('carrier-icon', image)

        // 添加轨迹数据源
        map.addSource('trajectory', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: trajectoryPath,
            },
          },
        })

        // 添加轨迹阴影线
        map.addLayer({
          id: 'trajectory-shadow',
          type: 'line',
          source: 'trajectory',
          paint: {
            'line-color': '#031624',
            'line-width': 6,
            'line-opacity': 0.6,
          },
        })

        // 添加轨迹主线
        map.addLayer({
          id: 'trajectory',
          type: 'line',
          source: 'trajectory',
          paint: {
            'line-color': '#00f7ff',
            'line-width': 3,
            'line-opacity': 0.85,
          },
        })

        // 添加航母标记数据源
        map.addSource('carrier', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {
              name: '航空母舰',
            },
            geometry: {
              type: 'Point',
              coordinates: carrierPosition,
            },
          },
        })

        // 添加航母光晕效果
        map.addLayer({
          id: 'carrier-glow',
          type: 'circle',
          source: 'carrier',
          paint: {
            'circle-radius': 32,
            'circle-color': '#00f7ff',
            'circle-opacity': 0.2,
            'circle-blur': 1,
          },
        })

        // 添加航母图标
        map.addLayer({
          id: 'carrier-icon-layer',
          type: 'symbol',
          source: 'carrier',
          layout: {
            'icon-image': 'carrier-icon',
            'icon-size': 1,
            'icon-anchor': 'center',
            'icon-allow-overlap': true,
          },
        })

        // 添加点击检测层
        map.addLayer({
          id: 'carrier-hit',
          type: 'circle',
          source: 'carrier',
          paint: {
            'circle-radius': 40,
            'circle-color': '#ffffff',
            'circle-opacity': 0,
          },
        })

        // 点击事件
        map.on('click', 'carrier-hit', () => {
          onCarrierClick()
        })

        map.on('mouseenter', 'carrier-hit', () => {
          map.getCanvas().style.cursor = 'pointer'
        })

        map.on('mouseleave', 'carrier-hit', () => {
          map.getCanvas().style.cursor = ''
        })

        setIsLoaded(true)
      })
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // 当航母位置更新时
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isLoaded) {
      return
    }

    const source = map.getSource('carrier')
    if (source) {
      source.setData({
        type: 'Feature',
        properties: {
          name: '航空母舰',
        },
        geometry: {
          type: 'Point',
          coordinates: carrierPosition,
        },
      })
    }

    // 平滑移动到新位置
    map.easeTo({
      center: carrierPosition,
      duration: 1000,
    })
  }, [carrierPosition, isLoaded])

  return (
    <div className="map-view">
      <div ref={mapContainerRef} className="map-canvas" />
      <div className="map-overlay-top">
        <div className="map-title">航母轨迹分析系统</div>
        <div className="map-subtitle">Aircraft Carrier Trajectory Analysis System</div>
      </div>
      <div className="map-overlay-bottom">
        <div className="coordinates">
          <span className="coord-label">经度:</span>
          <span className="coord-value">{carrierPosition[0].toFixed(4)}°E</span>
          <span className="coord-label">纬度:</span>
          <span className="coord-value">{carrierPosition[1].toFixed(4)}°N</span>
        </div>
      </div>
    </div>
  )
}

export default MapView
