import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachAisTracksToCarriers,
  attachAisTracksToPlatforms,
  buildCapabilityStatus,
  normalizeAisTrack,
} from '../src/data/carrierDataTransforms.js';

test('normalizes AIS rows into coordinate track points and preserves totals', () => {
  const result = normalizeAisTrack(
    [
      { latitude: '47.55378', longitude: '-122.6502', sog: '0.0', startTime: '2026-02-28T00:00' },
      { latitude: '', longitude: '-122.7', sog: '4.1', startTime: '2026-02-28T00:01' },
      { latitude: '1.9820183', longitude: '104.9591033', sog: '37.966', startTime: null },
    ],
    44711,
  );

  assert.equal(result.source, 'ais');
  assert.equal(result.total, 44711);
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0], {
    lat: 47.55378,
    lon: -122.6502,
    sog: 0,
    time: '2026-02-28T00:00',
  });
});

test('attaches carrier tracks from AviationCarrier mmsi AIS before TrackLog fallback', () => {
  const carriers = [
    { id: 'CVN-68', name: 'Nimitz', mmsi: '303981000' },
    { id: 'CVN-X', name: 'No AIS', mmsi: '' },
  ];
  const trackByCarrier = {
    'CVN-68': [{ lat: null, lon: null, time: 'bad-tracklog' }],
    'CVN-X': [{ lat: 10, lon: 20, time: 'fallback' }],
  };
  const aisByMmsi = {
    303981000: {
      total: 44711,
      rows: [{ latitude: '47.5', longitude: '-122.6', sog: '0', startTime: '2026-02-28T00:00' }],
    },
  };

  const result = attachAisTracksToCarriers(carriers, trackByCarrier, aisByMmsi);

  assert.equal(result[0].trackSource, 'ais');
  assert.equal(result[0].trackTotal, 44711);
  assert.equal(result[0].track[0].lat, 47.5);
  assert.equal(result[1].trackSource, 'tracklog');
  assert.equal(result[1].track[0].time, 'fallback');
});

test('attaches AIS availability to ship platforms with populated mmsi', () => {
  const platforms = [
    { id: 'DDG-1', name: 'Escort', mmsi: '369970409' },
    { id: 'DDG-2', name: 'No MMSI', mmsi: '' },
  ];
  const aisByMmsi = {
    369970409: {
      total: 12,
      rows: [{ latitude: '32.7', longitude: '-117.1', sog: '3.5', startTime: '2026-01-01T00:00' }],
    },
  };

  const result = attachAisTracksToPlatforms(platforms, aisByMmsi);

  assert.equal(result[0].aisStatus, 'available');
  assert.equal(result[0].aisTrackTotal, 12);
  assert.equal(result[1].aisStatus, 'missing_mmsi');
});

test('builds honest capability status for AIS-enhanced, ADS-B-limited mode', () => {
  const status = buildCapabilityStatus({
    carrierCount: 14,
    carriersWithAis: 11,
    shipCount: 20,
    shipsWithAis: 6,
    adsbEventMode: false,
  });

  assert.equal(status.carrierAis.level, 'available');
  assert.equal(status.shipAis.level, 'partial');
  assert.equal(status.adsbEventInference.level, 'unavailable');
});
