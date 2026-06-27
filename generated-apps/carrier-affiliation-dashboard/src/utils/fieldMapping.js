// 字段映射速查 —— DaaS raw → UI 归一化
// 不要从这里取字段名去构造请求 columns；columns 必须用 daasAdapter.js 里的常量

export const CARRIER_MAP = {
  curHeading:  'heading',
  curSpeed:    'speed',
  homeportStation: 'homeport',
  longitude:   'lon',
  latitude:    'lat',
};

export const ADSB_MAP = {
  lat:         'lat',
  lon:         'lon',
  groundspeed: 'speed_kt',
  startTime:   'time',
  altitude:    'alt_ft',
  track:       'track_deg',
};

export const TRACK_LOG_MAP = {
  refAviationCarrier: 'carrierId',
  trackInitTime:      'time',
  longitude:          'lon',
  latitude:           'lat',
};
