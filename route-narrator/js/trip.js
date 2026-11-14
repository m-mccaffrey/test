// The trip engine: tracks where the vehicle is along the route and decides
// which point of interest to narrate next, and when.

import { fetchExtracts } from './services.js';
import { scorePoi } from './topics.js';
import { writeScript } from './narrator.js';

export const CHATTINESS = {
  relaxed: { gap: 120, minScore: 3.7, label: 'Relaxed' },
  normal: { gap: 35, minScore: 3.2, label: 'Normal' },
  chatty: { gap: 6, minScore: 0, label: 'Chatty' },
};

export class Trip {
  /**
   * @param {object} o
   * @param {import('./geo.js').Route} o.route
   * @param {number} o.duration  routed duration in seconds
   * @param {import('./narrator.js').Narrator} o.narrator
   * @param {() => object} o.settings  returns current listener settings
   */
  constructor({ route, duration, narrator, settings }) {
    this.route = route;
    this.duration = duration;
    this.avgSpeed = route.length / Math.max(60, duration); // m/s
    this.narrator = narrator;
    this.settings = settings;
    this.pois = new Map();
    this.narrated = new Set();
    this.along = 0;
    this.speed = this.avgSpeed;
    this.mode = null; // 'gps' | 'sim'
    this.running = false;
    this.nextAllowedAt = 0;
    this.current = null;
    this.extractQueue = new Set();
    this.extractBusy = false;
    this.onposition = () => {};
    this.onnarrate = () => {};
    this.onstatus = () => {};
    this.onfinish = () => {};
  }

  addPois(list) {
    for (const p of list) if (!this.pois.has(p.id)) this.pois.set(p.id, p);
  }

  score(poi) {
    const s = this.settings();
    return scorePoi(poi, s.topics, s.mode);
  }

  /** Points of interest still ahead, in route order. */
  upcoming(limit = 50) {
    return [...this.pois.values()]
      .filter((p) => p.along >= this.along - 150 && !this.narrated.has(p.id) && this.score(p) > 0)
      .sort((a, b) => a.along - b.along)
      .slice(0, limit);
  }

  lookahead() {
    return Math.max(600, Math.min(8000, this.speed * 50));
  }

  // --- position sources -------------------------------------------------

  startSimulation(multiplier = 1, fromAlong = 0) {
    this.stop();
    this.mode = 'sim';
    this.running = true;
    this.simMultiplier = multiplier;
    this.along = fromAlong;
    let last = performance.now();
    this._timer = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (this.simPaused) return;
      this.speed = this.avgSpeed * this.simMultiplier;
      this.along = Math.min(this.route.length, this.along + this.speed * dt);
      this._update();
      if (this.along >= this.route.length) this._finish();
    }, 250);
    this._update();
  }

  startGps() {
    this.stop();
    if (!('geolocation' in navigator)) throw new Error('This device has no location service');
    this.mode = 'gps';
    this.running = true;
    let lastFix = null;
    this._watch = navigator.geolocation.watchPosition(
      (pos) => {
        const p = [pos.coords.latitude, pos.coords.longitude];
        let proj = this.route.project(p, this.along - 2000, this.along + 6000);
        if (proj.offset > 300) proj = this.route.project(p);
        this.offRoute = proj.offset > 1000;
        this.along = proj.along;
        if (pos.coords.speed != null && pos.coords.speed >= 0) this.speed = Math.max(3, pos.coords.speed);
        else if (lastFix) {
          const dt = (pos.timestamp - lastFix.t) / 1000;
          if (dt > 0) this.speed = Math.max(3, Math.abs(proj.along - lastFix.along) / dt);
        }
        lastFix = { t: pos.timestamp, along: proj.along };
        this.gpsPoint = p;
        this._update();
        if (this.route.length - this.along < 150) this._finish();
      },
      (err) => this.onstatus(`Location unavailable: ${err.message}`, 'error'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    this.onstatus('Waiting for GPS…');
  }

  setSimPaused(p) { this.simPaused = p; }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    if (this._watch != null) navigator.geolocation.clearWatch(this._watch);
    this._watch = null;
    this.narrator.stop();
  }

  _finish() {
    const wasRunning = this.running;
    clearInterval(this._timer);
    if (this._watch != null) navigator.geolocation.clearWatch(this._watch);
    this._watch = null;
    this.running = false;
    if (wasRunning) this.onfinish();
  }

  // --- narration decisions ----------------------------------------------

  _update() {
    const point = this.mode === 'gps' && this.gpsPoint ? this.gpsPoint : this.route.pointAt(this.along);
    this.onposition(point, this.along, this.route.headingAt(this.along));
    this._prefetch();
    this._maybeNarrate();
  }

  _candidates(windowAhead) {
    const minScore = CHATTINESS[this.settings().chattiness].minScore;
    const out = [];
    for (const p of this.pois.values()) {
      if (this.narrated.has(p.id)) continue;
      const ahead = p.along - this.along;
      if (ahead < -150 || ahead > windowAhead) continue;
      const s = this.score(p);
      if (s > 0 && s >= minScore) out.push({ p, s });
    }
    return out.sort((a, b) => b.s - a.s);
  }

  _prefetch() {
    const want = this._candidates(this.lookahead() * 3).slice(0, 12).map((c) => c.p);
    for (const p of want) if (p.extract == null) this.extractQueue.add(p.id);
    this._drainExtracts();
  }

  async _drainExtracts() {
    if (this.extractBusy || !this.extractQueue.size) return;
    this.extractBusy = true;
    const ids = [...this.extractQueue].slice(0, 20);
    ids.forEach((id) => this.extractQueue.delete(id));
    try {
      const map = await fetchExtracts(ids);
      for (const [id, text] of map) {
        const p = this.pois.get(id);
        if (p) p.extract = text;
      }
    } catch (e) {
      console.warn('extract fetch failed', e);
      for (const id of ids) {
        const p = this.pois.get(id);
        if (p && p.extract == null) p.extract = '';
      }
    }
    this.extractBusy = false;
    if (this.extractQueue.size) this._drainExtracts();
  }

  async _maybeNarrate() {
    if (!this.running || this._choosing || this.narrator.speaking) return;
    if (Date.now() < this.nextAllowedAt) return;
    const best = this._candidates(this.lookahead())[0];
    if (!best) return;
    this._choosing = true;
    try {
      await this.narrate(best.p);
    } finally {
      this._choosing = false;
    }
  }

  /** Narrate a point now (also used for "read this" from the list). */
  async narrate(poi, { manual = false } = {}) {
    this.narrated.add(poi.id);
    if (poi.extract == null) {
      try {
        const map = await fetchExtracts([poi.id]);
        poi.extract = map.get(poi.id) || '';
      } catch {
        poi.extract = '';
      }
    }
    // Let whatever is playing (e.g. the welcome message) finish first.
    while (!manual && this.narrator.speaking) await new Promise((r) => setTimeout(r, 300));
    if (!manual && !this.running) return;
    const s = this.settings();
    const ahead = manual && !this.running ? Infinity : poi.along - this.along;
    const script = Number.isFinite(ahead)
      ? writeScript(poi, ahead, { units: s.units, detail: s.detail })
      : writeScript({ ...poi, offset: 0 }, 0, { units: s.units, detail: s.detail })
          .replace(/^(Right about now|We're passing)[^:.]*[:.]\s*/, `${poi.title}. `);
    await this._say(poi, script);
  }

  async _say(poi, script) {
    const s = this.settings();
    this.current = { poi, script };
    this.lastNarrated = this.current;
    this._skipped = false;
    this.onnarrate(poi, script);
    await this.narrator.speak(script);
    if (this.current?.poi !== poi) return; // interrupted by another narration
    this.current = null;
    this.nextAllowedAt = Date.now() + (this._skipped ? 3 : CHATTINESS[s.chattiness].gap) * 1000;
    this.onnarrate(null, null);
  }

  skip() {
    this._skipped = true;
    this.narrator.stop();
  }

  replay() {
    const last = this.lastNarrated;
    if (last) this._say(last.poi, last.script);
  }
}
