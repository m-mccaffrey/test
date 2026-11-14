// Geometry helpers for working with a driving route on the Earth's surface.
// Coordinates are [lat, lon] in degrees; distances are in metres.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Local equirectangular projection around a reference latitude: accurate to
// well under 1% over the few kilometres we ever project across.
function toXY(p, ref) {
  const k = Math.cos(toRad(ref[0]));
  return [toRad(p[1] - ref[1]) * R * k, toRad(p[0] - ref[0]) * R];
}

/**
 * A route polyline with cumulative distances and fast point projection.
 */
export class Route {
  constructor(coords) {
    if (!coords || coords.length < 2) throw new Error('Route needs at least two points');
    this.coords = coords;
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      this.cum[i] = this.cum[i - 1] + haversine(coords[i - 1], coords[i]);
    }
    this.length = this.cum[coords.length - 1];
  }

  /** Index of the segment containing distance `d` along the route. */
  segmentAt(d) {
    let lo = 0;
    let hi = this.coords.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Point at distance `d` (m) along the route. */
  pointAt(d) {
    d = Math.max(0, Math.min(this.length, d));
    const i = this.segmentAt(d);
    const a = this.coords[i];
    const b = this.coords[Math.min(i + 1, this.coords.length - 1)];
    const segLen = this.cum[Math.min(i + 1, this.coords.length - 1)] - this.cum[i];
    const t = segLen > 0 ? (d - this.cum[i]) / segLen : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Direction of travel (degrees) at distance `d`. */
  headingAt(d) {
    const i = this.segmentAt(Math.max(0, Math.min(this.length - 1, d)));
    return bearing(this.coords[i], this.coords[Math.min(i + 1, this.coords.length - 1)]);
  }

  /**
   * Evenly spaced sample points every `step` metres (always includes both ends).
   */
  sample(step) {
    const out = [];
    for (let d = 0; d < this.length; d += step) out.push({ along: d, point: this.pointAt(d) });
    out.push({ along: this.length, point: this.pointAt(this.length) });
    return out;
  }

  /**
   * Project a point onto the route.
   * Optionally restrict the search to the distance window [fromD, toD].
   * Returns { along, offset, side } where offset is perpendicular distance in m
   * and side is 'left' | 'right' relative to the direction of travel.
   */
  project(p, fromD = 0, toD = Infinity) {
    const n = this.coords.length;
    const i0 = fromD > 0 ? this.segmentAt(fromD) : 0;
    const i1 = toD < this.length ? Math.min(n - 2, this.segmentAt(toD) + 1) : n - 2;
    let best = { along: 0, offset: Infinity, side: 'right', seg: 0 };
    for (let i = i0; i <= i1; i++) {
      const a = this.coords[i];
      const b = this.coords[i + 1];
      const B = toXY(b, a);
      const P = toXY(p, a);
      const len2 = B[0] * B[0] + B[1] * B[1];
      let t = len2 > 0 ? (P[0] * B[0] + P[1] * B[1]) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = P[0] - B[0] * t;
      const dy = P[1] - B[1] * t;
      const dist = Math.hypot(dx, dy);
      if (dist < best.offset) {
        const cross = B[0] * P[1] - B[1] * P[0];
        best = {
          along: this.cum[i] + (this.cum[i + 1] - this.cum[i]) * t,
          offset: dist,
          side: cross > 0 ? 'left' : 'right',
          seg: i,
        };
      }
    }
    return best;
  }
}

/** Decode a Google-style encoded polyline (precision 5 or 6). */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** Human-friendly distance. */
export function formatDistance(m, units = 'imperial') {
  if (units === 'metric') {
    if (m < 950) return `${Math.max(50, Math.round(m / 50) * 50)} metres`;
    const km = m / 1000;
    return km < 10 ? `${km.toFixed(1).replace(/\.0$/, '')} kilometres` : `${Math.round(km)} kilometres`;
  }
  const mi = m / 1609.344;
  if (mi < 0.15) return `${Math.max(100, Math.round((m * 3.28084) / 100) * 100)} feet`;
  if (mi < 0.4) return 'a quarter mile';
  if (mi < 0.65) return 'half a mile';
  if (mi < 0.85) return 'three quarters of a mile';
  if (mi < 1.25) return 'a mile';
  return mi < 10 ? `${mi.toFixed(1).replace(/\.0$/, '')} miles` : `${Math.round(mi)} miles`;
}

/** Compact distance for the UI ("3.2 mi"). */
export function shortDistance(m, units = 'imperial') {
  if (units === 'metric') return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const mi = m / 1609.344;
  return mi < 0.1 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
}

export function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
