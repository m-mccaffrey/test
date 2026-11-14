// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Route, haversine, decodePolyline, formatDistance } from '../js/geo.js';
import { classify, scorePoi } from '../js/topics.js';
import { sentences, cleanForSpeech, writeScript } from '../js/narrator.js';

test('haversine: Boston to New York is about 306 km', () => {
  const d = haversine([42.3601, -71.0589], [40.7128, -74.006]);
  assert.ok(Math.abs(d - 306000) < 3000, d);
});

test('Route: length, pointAt and projection with side of road', () => {
  // Due north along a meridian, ~11.1 km.
  const r = new Route([[0, 0], [0.05, 0], [0.1, 0]]);
  assert.ok(Math.abs(r.length - 11120) < 30, r.length);
  const mid = r.pointAt(r.length / 2);
  assert.ok(Math.abs(mid[0] - 0.05) < 1e-6);
  const east = r.project([0.03, 0.01]); // east of a northbound road = right
  assert.equal(east.side, 'right');
  assert.ok(Math.abs(east.offset - 1112) < 10, east.offset);
  assert.ok(Math.abs(east.along - 3336) < 10, east.along);
  const west = r.project([0.07, -0.005]);
  assert.equal(west.side, 'left');
  // Windowed projection gives the same answer when the window contains it.
  const w = r.project([0.07, -0.005], 6000, 9000);
  assert.ok(Math.abs(w.along - west.along) < 1);
});

test('Route.sample covers both ends', () => {
  const r = new Route([[0, 0], [0.1, 0]]);
  const s = r.sample(3000);
  assert.equal(s[0].along, 0);
  assert.equal(s.at(-1).along, r.length);
  assert.equal(s.length, 5);
});

test('decodePolyline decodes the Google reference example', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('formatDistance reads naturally', () => {
  assert.equal(formatDistance(800, 'imperial'), 'half a mile');
  assert.equal(formatDistance(1609, 'imperial'), 'a mile');
  assert.equal(formatDistance(5000, 'imperial'), '3.1 miles');
  assert.equal(formatDistance(2500, 'metric'), '2.5 kilometres');
});

test('classify recognises towns, battles, parks and bridges', () => {
  assert.equal(classify({ title: 'Concord, Massachusetts', description: 'Town in Massachusetts, United States',
    categories: ['Category:Towns in Middlesex County, Massachusetts'] })[0], 'towns');
  const battle = classify({ title: 'Battle of Gettysburg', description: '1863 battle of the American Civil War',
    categories: ['Category:Battles of the American Civil War'] });
  assert.equal(battle[0], 'military');
  assert.ok(classify({ title: 'Hocking Hills State Park', description: 'State park in Ohio' }).includes('nature'));
  assert.ok(classify({ title: 'Golden Gate Bridge', description: 'Suspension bridge in San Francisco' }).includes('transport'));
  // Housekeeping categories are ignored.
  assert.deepEqual(classify({ title: 'X', categories: ['Category:Articles with short description'] }), []);
});

test('scorePoi respects "only my topics"', () => {
  const poi = { topics: ['nature'], length: 10000 };
  assert.equal(scorePoi(poi, new Set(['history']), 'only'), 0);
  assert.ok(scorePoi(poi, new Set(['history']), 'mix') > 0);
  assert.ok(scorePoi(poi, new Set(['nature']), 'mix') > scorePoi(poi, new Set(['history']), 'mix'));
});

test('sentences does not split on abbreviations or initials', () => {
  const s = sentences('St. Louis is a city in Mo. It was founded by P. Laclède in 1764. It grew fast!');
  assert.deepEqual(s, ['St. Louis is a city in Mo.', 'It was founded by P. Laclède in 1764.', 'It grew fast!']);
});

test('cleanForSpeech removes pronunciations and brackets', () => {
  assert.equal(cleanForSpeech('Worcester (/ˈwʊstər/ WUUS-tər) is a city (pop. 200,000 [1]).'), 'Worcester is a city.');
});

test('writeScript mentions distance, side and the story', () => {
  const s = writeScript(
    { title: 'Old Mill', description: 'Grist mill', extract: 'The Old Mill was built in 1790. It ground corn. It closed in 1920. It is now a museum.',
      offset: 900, side: 'left', topics: ['history'] },
    3000, { units: 'imperial', detail: 'normal' },
  );
  assert.match(s, /1\.9 miles/);
  assert.match(s, /to your left/);
  assert.match(s, /built in 1790\. It ground corn\. It closed in 1920\.$/);
  const town = writeScript({ title: 'Springfield', extract: 'Springfield is a city.', offset: 100, side: 'right', topics: ['towns'] }, 100);
  assert.match(town, /^Welcome to Springfield\./);
});
