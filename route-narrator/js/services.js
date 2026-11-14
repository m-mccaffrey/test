// Network services: geocoding (Nominatim), routing (OSRM) and points of
// interest (Wikipedia). All are free, keyless and CORS-enabled.

import { Route, haversine } from './geo.js';
import { classify } from './topics.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';

let wikiLang = 'en';
export function setWikiLanguage(lang) { wikiLang = lang || 'en'; }
const wikiApi = () => `https://${wikiLang}.wikipedia.org/w/api.php`;

async function getJSON(url, { signal } = {}) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

/** Turn free text into a place. Accepts "lat, lon" directly. */
export async function geocode(text, { signal } = {}) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { name: text.trim(), point: [parseFloat(m[1]), parseFloat(m[2])] };
  const data = await getJSON(`${NOMINATIM}/search?${qs({ q: text, format: 'jsonv2', limit: 1 })}`, { signal });
  if (!data.length) throw new Error(`Couldn't find “${text}”`);
  return { name: data[0].display_name, point: [parseFloat(data[0].lat), parseFloat(data[0].lon)] };
}

export async function reverseGeocode(point, { signal } = {}) {
  try {
    const data = await getJSON(
      `${NOMINATIM}/reverse?${qs({ lat: point[0], lon: point[1], format: 'jsonv2', zoom: 14 })}`,
      { signal },
    );
    return data.display_name || `${point[0].toFixed(4)}, ${point[1].toFixed(4)}`;
  } catch {
    return `${point[0].toFixed(4)}, ${point[1].toFixed(4)}`;
  }
}

/** Driving route between waypoints. */
export async function fetchRoute(points, { signal } = {}) {
  const path = points.map((p) => `${p[1]},${p[0]}`).join(';');
  const data = await getJSON(
    `${OSRM}/route/v1/driving/${path}?${qs({ overview: 'full', geometries: 'geojson', steps: 'false' })}`,
    { signal },
  );
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message || 'No driving route found');
  const r = data.routes[0];
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return { route: new Route(coords), duration: r.duration, distance: r.distance };
}

/** Run async tasks with limited concurrency, preserving order of starts. */
export async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Query Wikipedia for geotagged articles near a point, including the
 * metadata needed to classify and rank them (but not the text itself).
 */
async function wikiNearby(point, radius, { signal } = {}) {
  const base = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'geosearch',
    ggscoord: `${point[0]}|${point[1]}`,
    ggsradius: String(Math.round(Math.min(10000, Math.max(10, radius)))),
    ggslimit: '50',
    ggsnamespace: '0',
    prop: 'coordinates|info|categories|description|pageimages',
    clshow: '!hidden',
    cllimit: 'max',
    piprop: 'thumbnail',
    pithumbsize: '240',
    pilimit: '50',
    colimit: '50',
  };
  const pages = new Map();
  let cont = {};
  for (let i = 0; i < 6; i++) {
    const data = await getJSON(`${wikiApi()}?${qs({ ...base, ...cont })}`, { signal });
    for (const p of data.query?.pages || []) {
      const prev = pages.get(p.pageid) || { categories: [] };
      pages.set(p.pageid, {
        ...prev,
        ...p,
        categories: [...prev.categories, ...(p.categories || []).map((c) => c.title)],
      });
    }
    if (!data.continue) break;
    cont = data.continue;
  }
  return [...pages.values()].filter((p) => p.coordinates?.length);
}

/**
 * Find points of interest along a route. Calls `onBatch(newPois, progress)`
 * as results come in, ordered roughly from the start of the route onward,
 * so narration can begin before the whole route has been scanned.
 */
export async function findPoisAlongRoute(route, corridor, onBatch, { signal, maxRequests = 140 } = {}) {
  // Space query circles so every point within `corridor` of the road is covered.
  let step = Math.max(1500, corridor * 1.4);
  step = Math.max(step, route.length / maxRequests);
  const radius = Math.min(10000, Math.hypot(step / 2, corridor) * 1.05);
  const samples = route.sample(step);
  const seen = new Set();
  let done = 0;
  await pool(samples, 4, async (s) => {
    if (signal?.aborted) return;
    let pages = [];
    try {
      pages = await wikiNearby(s.point, radius, { signal });
    } catch (e) {
      if (signal?.aborted) return;
      console.warn('Wikipedia lookup failed near', s.point, e);
    }
    const fresh = [];
    for (const p of pages) {
      if (seen.has(p.pageid)) continue;
      const point = [p.coordinates[0].lat, p.coordinates[0].lon];
      // Only search route segments near this sample for speed.
      const proj = route.project(point, s.along - radius - step, s.along + radius + step);
      if (proj.offset > corridor) continue;
      seen.add(p.pageid);
      fresh.push({
        id: p.pageid,
        title: p.title,
        description: p.description || '',
        point,
        along: proj.along,
        offset: proj.offset,
        side: proj.side,
        length: p.length || 0,
        thumb: p.thumbnail?.source || null,
        topics: classify({ title: p.title, description: p.description, categories: p.categories }),
        url: `https://${wikiLang}.wikipedia.org/?curid=${p.pageid}`,
        extract: null,
      });
    }
    done++;
    onBatch(fresh, done / samples.length);
  });
}

/**
 * Fetch plain-text intro extracts for up to 20 page ids at once.
 * Returns a Map of id -> text.
 */
export async function fetchExtracts(ids, { signal } = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const data = await getJSON(
      `${wikiApi()}?${qs({
        action: 'query',
        format: 'json',
        formatversion: '2',
        origin: '*',
        prop: 'extracts',
        exintro: '1',
        explaintext: '1',
        exlimit: '20',
        pageids: chunk.join('|'),
      })}`,
      { signal },
    );
    for (const p of data.query?.pages || []) out.set(p.pageid, p.extract || '');
  }
  return out;
}

export { haversine };
