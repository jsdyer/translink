import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCaptures, formatDelay, inspectRoute, matchRoutes, median, projectOnto, sortLabels } from '../web/model.mjs';

const limits = { bunchMeters: 500, staleSeconds: 180, onTimeSeconds: 60 };
const line = Array.from({ length: 21 }, (_, i) => [49 + i * 0.01, -123]);
const routes = [
  { id: '6641', label: '99', name: 'Broadway B-Line', dir: { '1': 'UBC Exchange' }, shapes: { '1': line } },
  { id: '6728', label: '410', name: 'Brighouse Station/22nd St Station', dir: {}, shapes: {} },
  { id: '37807', label: 'R5', name: 'Hastings St', dir: { '0': 'SFU Exchange' } },
  { id: '30053', label: 'Expo Line', name: 'Expo Line', dir: {} },
  { id: '6618', label: '9', name: 'Broadway', dir: {} },
];

test('matches numbers without leading zeros and does not confuse 9 with 99', () => {
  assert.equal(matchRoutes('99', routes)[0].id, '6641');
  assert.equal(matchRoutes('099', routes)[0].id, '6641');
  assert.equal(matchRoutes('9', routes)[0].id, '6618');
  assert.equal(matchRoutes('r5', routes)[0].label, 'R5');
  assert.equal(matchRoutes('expo', routes)[0].label, 'Expo Line');
  assert.equal(matchRoutes('4', routes).length, 0);
  assert.equal(matchRoutes('410', routes)[0].id, '6728');
});

test('a route beyond the starter watchlist is still described', () => {
  const capture = {
    coverage: 'sample',
    vehicles: [
      { id: 'A', routeId: '6728', lat: 49.17, lon: -123.14, delay: 30 },
      { id: 'B', routeId: '6728', lat: 49.172, lon: -123.14, delay: 90 },
    ],
    summary: {},
    canceled: [],
    alerts: [],
  };
  const result = inspectRoute({ capture, routes, query: '410', limits });
  assert.equal(result.status, 'ok');
  assert.match(result.sentence, /2 buses are reporting on the 410/);
  assert.match(result.sentence, /as the crow flies/);
  assert.match(result.sentence, /No line is saved/);
  assert.notEqual(result.vehicles.length, 24);
});

test('places buses along a saved line and names a bunch', () => {
  const start = projectOnto(49.05, -123, line);
  const near = projectOnto(49.052, -123, line);
  assert.ok(near.along - start.along < 400);
  const capture = {
    coverage: 'full',
    vehicles: [
      { id: 'A', routeId: '6641', direction: '1', lat: 49.05, lon: -123, delay: 120, age: 20 },
      { id: 'B', routeId: '6641', direction: '1', lat: 49.052, lon: -123, delay: 360, age: 400 },
    ],
    summary: { '6641': { canceled: 1 } },
    canceled: [],
    alerts: [{ routes: ['6641'], header: 'Illustrated', effect: 'detour' }],
  };
  const result = inspectRoute({ capture, routes, query: '99', limits });
  assert.match(result.sentence, /along the saved line/);
  assert.match(result.sentence, /bunched/);
  assert.match(result.sentence, /towards UBC Exchange/);
  assert.match(result.sentence, /1 trip is cancelled/);
  assert.match(result.sentence, /1 position is stale/);
  assert.equal(result.alerts.length, 1);
  assert.equal(formatDelay(median([120, 360]), 60), '4 min late');
});

test('a bus sitting off the saved line is not stacked onto the buses on it', () => {
  const broadway = Array.from({ length: 11 }, (_, index) => [49, -123.1 + index * 0.01]);
  const localRoutes = [
    { id: '6641', label: '99', name: 'Broadway B-Line', dir: { '1': 'UBC Exchange' }, shapes: { '1': broadway } },
  ];
  const capture = {
    coverage: 'full',
    vehicles: [
      { id: 'on-a', routeId: '6641', direction: '1', lat: 49, lon: -123.05 },
      { id: 'on-b', routeId: '6641', direction: '1', lat: 49, lon: -123.04 },
      { id: 'off', routeId: '6641', direction: '1', lat: 49.001, lon: -123.05 },
    ],
    summary: {},
    canceled: [],
    alerts: [],
  };
  const result = inspectRoute({ capture, routes: localRoutes, query: '99', limits });
  assert.ok(result.closest.metres > 100);
  assert.match(result.sentence, /along the saved line/);
  assert.doesNotMatch(result.sentence, /\b[01] m apart/);
});

test('full captures count a missing route as zero and partial captures do not', () => {
  const labelFor = (id) => ({ '6641': '99', '6728': '410' })[id] || id;
  const older = { coverage: 'full', vehicles: [{ routeId: '6641' }, { routeId: '6641' }, { routeId: '6728' }] };
  const newer = { coverage: 'full', vehicles: [{ routeId: '6641' }] };
  const full = compareCaptures(newer, older, labelFor);
  assert.equal(full.changes.find((row) => row.label === '99').before, 2);
  assert.equal(full.changes.find((row) => row.label === '410').after, 0);
  const partial = compareCaptures(
    { coverage: 'sample', vehicles: [{ routeId: '6641' }, { routeId: '6728' }] },
    { coverage: 'sample', vehicles: [{ routeId: '6641' }, { routeId: '6641' }, { routeId: '6641' }, { routeId: '6641' }] },
    labelFor,
  );
  assert.deepEqual(partial.changes, [{ label: '99', before: 4, after: 1 }]);
  assert.match(partial.note, /410/);
  assert.match(partial.note, /not counted as zero/);
});

test('an older capture without a summary still counts listed cancellations', () => {
  const capture = {
    coverage: 'full',
    vehicles: [],
    canceled: [{ routeId: '6641', trip: 't1' }, { routeId: '6641', trip: 't2' }],
  };
  const result = inspectRoute({ capture, routes, query: '99', limits });
  assert.match(result.sentence, /No vehicle on the 99/);
  assert.equal(result.canceled, 2);
});

test('sorts route labels with numbers before names', () => {
  assert.deepEqual(sortLabels(['R5', '9', '99', 'N9', '14']), ['9', '14', '99', 'N9', 'R5']);
});

test('rejects a capture that is not an object of vehicles', () => {
  assert.throws(() => inspectRoute({ capture: null, routes, query: '99', limits }), TypeError);
});
