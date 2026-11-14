// UI wiring for Roadside Narrator.

import { shortDistance, formatDuration } from './geo.js';
import { geocode, reverseGeocode, fetchRoute, findPoisAlongRoute, setWikiLanguage } from './services.js';
import { TOPICS, TOPIC_BY_ID } from './topics.js';
import { Narrator } from './narrator.js';
import { Trip } from './trip.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'roadside-narrator:v1';

// ---- settings (persisted per browser) ------------------------------------

const defaults = {
  topics: [], mode: 'mix', chattiness: 'normal', detail: 'normal', corridor: '3000',
  units: navigator.language === 'en-US' || navigator.language === 'en-GB' ? 'imperial' : 'metric',
  lang: 'en', voice: '', rate: 1, muted: false, from: '', to: '',
};
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* storage unavailable */ }
const prefs = { ...defaults, ...saved };
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

const settings = () => ({
  topics: new Set(prefs.topics),
  mode: prefs.mode,
  chattiness: prefs.chattiness,
  detail: prefs.detail,
  units: prefs.units,
});

// ---- toast ----------------------------------------------------------------

let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

// ---- map ------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let routeLayer = null;
let doneLayer = null;
let carMarker = null;
const poiLayer = L.layerGroup().addTo(map);
const markers = new Map();
let follow = true;
map.on('dragstart', () => {
  if (trip?.running) { follow = false; $('recenter').hidden = false; }
});
$('recenter').onclick = () => { follow = true; $('recenter').hidden = true; if (carMarker) map.panTo(carMarker.getLatLng()); };

function poiIcon(poi, cls = '') {
  const t = TOPIC_BY_ID[primaryTopic(poi)] || { icon: '📍', color: '#64748b' };
  return L.divIcon({
    className: '',
    html: `<div class="poi-marker ${cls}" style="background:${t.color}">${t.icon}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function primaryTopic(poi) {
  const sel = prefs.topics;
  return poi.topics.find((t) => sel.includes(t)) || poi.topics[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function addMarker(poi) {
  const m = L.marker(poi.point, { icon: poiIcon(poi), title: poi.title, keyboard: false });
  const popup = document.createElement('div');
  popup.innerHTML = `<b>${escapeHtml(poi.title)}</b>${escapeHtml(poi.description || '')}<br>`;
  const btn = document.createElement('button');
  btn.textContent = '🔊 Tell me about it';
  btn.onclick = () => { map.closePopup(); playNow(poi); };
  popup.append(btn);
  m.bindPopup(popup);
  m.addTo(poiLayer);
  markers.set(poi.id, m);
  refreshMarkerVisibility(poi);
}

function refreshMarkerVisibility(poi) {
  const m = markers.get(poi.id);
  if (!m || !trip) return;
  const visible = trip.score(poi) > 0;
  if (visible && !poiLayer.hasLayer(m)) poiLayer.addLayer(m);
  if (!visible && poiLayer.hasLayer(m)) poiLayer.removeLayer(m);
}

function setMarkerState(poi, cls) {
  markers.get(poi.id)?.setIcon(poiIcon(poi, cls));
}

// ---- topics UI ----------------------------------------------------------

function renderTopics() {
  const box = $('topics');
  box.replaceChildren();
  for (const t of TOPICS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${t.icon} ${t.label}`;
    b.setAttribute('aria-pressed', String(prefs.topics.includes(t.id)));
    b.onclick = () => {
      prefs.topics = prefs.topics.includes(t.id) ? prefs.topics.filter((x) => x !== t.id) : [...prefs.topics, t.id];
      b.setAttribute('aria-pressed', String(prefs.topics.includes(t.id)));
      save();
      onInterestsChanged();
    };
    box.append(b);
  }
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.checked = r.value === prefs.mode;
    r.onchange = () => { prefs.mode = r.value; save(); onInterestsChanged(); };
  }
}

function onInterestsChanged() {
  if (!trip) return;
  for (const p of trip.pois.values()) {
    refreshMarkerVisibility(p);
    if (!trip.narrated.has(p.id)) setMarkerState(p, '');
  }
  renderUpcoming(true);
}

// ---- settings UI ----------------------------------------------------------

const narrator = new Narrator();

function bindSelect(id, key, after) {
  const el = $(id);
  el.value = prefs[key];
  el.onchange = () => { prefs[key] = el.value; save(); after?.(); };
}
bindSelect('chattiness', 'chattiness');
bindSelect('detail', 'detail');
bindSelect('corridor', 'corridor', () => { if (trip && !trip.running) toast('Plan the route again to use the new distance.'); });
bindSelect('units', 'units', () => renderUpcoming(true));
bindSelect('lang', 'lang', () => { setWikiLanguage(prefs.lang); if (trip) toast('Plan the route again to load stories in the new language.'); });
setWikiLanguage(prefs.lang);

$('rate').value = prefs.rate;
$('rate-out').textContent = `${Number(prefs.rate).toFixed(2).replace(/0$/, '')}×`;
narrator.rate = Number(prefs.rate);
$('rate').oninput = () => {
  prefs.rate = Number($('rate').value);
  narrator.rate = prefs.rate;
  $('rate-out').textContent = `${prefs.rate.toFixed(2).replace(/0$/, '')}×`;
  save();
};
$('muted').checked = prefs.muted;
narrator.muted = prefs.muted || !narrator.available;
$('muted').onchange = () => { prefs.muted = $('muted').checked; narrator.muted = prefs.muted || !narrator.available; save(); };
if (!narrator.available) {
  $('muted').checked = true;
  $('muted').disabled = true;
  $('voice').disabled = true;
}

function fillVoices() {
  const sel = $('voice');
  const lang = prefs.lang;
  const voices = narrator.voices();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const list = matching.length ? matching : voices;
  sel.replaceChildren(new Option('Default voice', ''));
  for (const v of list) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = list.some((v) => v.voiceURI === prefs.voice) ? prefs.voice : '';
  narrator.voice = voices.find((v) => v.voiceURI === sel.value) || null;
}
fillVoices();
if (narrator.available) speechSynthesis.addEventListener?.('voiceschanged', fillVoices);
$('voice').onchange = () => {
  prefs.voice = $('voice').value;
  narrator.voice = narrator.voices().find((v) => v.voiceURI === prefs.voice) || null;
  save();
  narrator.unlock();
  narrator.speak('This is how I will sound on your drive.');
};
$('lang').addEventListener('change', fillVoices);

// ---- planning --------------------------------------------------------------

let trip = null;
let scanAbort = null;
let fromPoint = null; // set when "use my location" is used

$('from').value = prefs.from;
$('to').value = prefs.to;
$('from').addEventListener('input', () => { fromPoint = null; });

$('use-location').onclick = () => {
  if (!navigator.geolocation) return toast('Location is not available on this device.', 'error');
  $('from').value = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      fromPoint = [pos.coords.latitude, pos.coords.longitude];
      $('from').value = 'My location';
      const name = await reverseGeocode(fromPoint);
      if (fromPoint) $('from').value = name.split(',').slice(0, 3).join(',');
    },
    (err) => {
      $('from').value = '';
      if (err.code === 1) showLocationHelp();
      else toast("Couldn't find your location — try again, or type your starting point.", 'error');
    },
    { enableHighAccuracy: true, timeout: 15000 },
  );
};

$('route-form').onsubmit = async (e) => {
  e.preventDefault();
  const from = $('from').value.trim();
  const to = $('to').value.trim();
  if (!from || !to) return;
  prefs.from = fromPoint ? '' : from;
  prefs.to = to;
  save();
  await planRoute(from, to);
};

async function planRoute(fromText, toText) {
  resetTrip();
  const btn = $('plan-btn');
  btn.disabled = true;
  btn.textContent = 'Finding your route…';
  scanAbort = new AbortController();
  const { signal } = scanAbort;
  try {
    const [a, b] = await Promise.all([
      fromPoint ? { name: fromText, point: fromPoint } : geocode(fromText, { signal }),
      geocode(toText, { signal }),
    ]);
    const { route, duration, distance } = await fetchRoute([a.point, b.point], { signal });
    trip = new Trip({ route, duration, narrator, settings });
    wireTrip(trip);

    routeLayer = L.polyline(route.coords, { color: getCss('--road'), weight: 6, opacity: 0.85 }).addTo(map);
    doneLayer = L.polyline([], { color: '#94a3b8', weight: 6, opacity: 0.9 }).addTo(map);
    L.circleMarker(a.point, { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(poiLayer).bindTooltip('Start');
    L.circleMarker(b.point, { radius: 7, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 }).addTo(poiLayer).bindTooltip('Destination');
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

    $('route-summary').hidden = false;
    $('route-summary').innerHTML = `
      <div><b>${shortDistance(distance, prefs.units)}</b>distance</div>
      <div><b>${formatDuration(duration)}</b>drive time</div>
      <div><b id="poi-count">0</b>stories found</div>`;
    $('drive-card').hidden = false;
    $('upcoming-card').hidden = false;
    btn.textContent = 'Finding stories along the way…';

    const bar = $('scan-progress');
    bar.hidden = false;
    await findPoisAlongRoute(
      route,
      Number(prefs.corridor),
      (pois, progress) => {
        if (trip?.route !== route) return;
        trip.addPois(pois);
        pois.forEach(addMarker);
        bar.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
        $('poi-count').textContent = trip.pois.size;
        renderUpcoming();
      },
      { signal },
    );
    bar.hidden = true;
    if (!signal.aborted && trip?.pois.size === 0) {
      toast('No stories found near this route — try a wider search distance in settings.', 'error');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      toast(err.message || 'Something went wrong planning the route.', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Plan route';
    renderUpcoming(true);
  }
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#2563eb';
}

function resetTrip() {
  scanAbort?.abort();
  trip?.stop();
  trip = null;
  poiLayer.clearLayers();
  markers.clear();
  routeLayer?.remove();
  doneLayer?.remove();
  carMarker?.remove();
  routeLayer = doneLayer = carMarker = null;
  $('upcoming').replaceChildren();
  $('log').replaceChildren();
  $('log-card').hidden = true;
  $('now').hidden = true;
  $('np-replay').hidden = true;
  $('scan-progress').hidden = true;
  $('scan-progress').firstElementChild.style.width = '0';
  showDriving(false);
}

// ---- driving --------------------------------------------------------------

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && trip?.running) keepAwake(true);
});

function showDriving(on) {
  $('start-buttons').hidden = on;
  $('stop-trip').hidden = !on;
  $('sim-pause').hidden = !(on && trip?.mode === 'sim');
  $('sim-controls').hidden = on && trip?.mode !== 'sim';
  $('drive-status').textContent = '';
}

$('start-gps').onclick = async () => {
  if (!trip) return;
  narrator.unlock();
  if (await locationBlocked()) return showLocationHelp();
  try {
    trip.startGps();
  } catch (e) {
    return toast(e.message, 'error');
  }
  follow = true;
  showDriving(true);
  keepAwake(true);
  narrator.speak(intro());
};

$('start-sim').onclick = () => {
  if (!trip) return;
  narrator.unlock();
  trip.startSimulation(Number($('sim-speed').value));
  trip.setSimPaused(false);
  $('sim-pause').textContent = 'Pause';
  follow = true;
  showDriving(true);
  keepAwake(true);
  narrator.speak(intro());
};

function intro() {
  const sel = prefs.topics.map((t) => TOPIC_BY_ID[t].label.toLowerCase());
  const what = sel.length
    ? `I'll point out ${sel.length > 1 ? `${sel.slice(0, -1).join(', ')} and ${sel.at(-1)}` : sel[0]}${prefs.mode === 'mix' ? ', plus anything else notable,' : ''}`
    : `I'll share bits of history about the places we pass`;
  return `Let's go. ${what} along the way. Enjoy the drive, and keep your eyes on the road.`;
}

$('sim-speed').onchange = () => { if (trip) trip.simMultiplier = Number($('sim-speed').value); };
$('sim-pause').onclick = () => {
  if (!trip) return;
  const p = !trip.simPaused;
  trip.setSimPaused(p);
  $('sim-pause').textContent = p ? 'Resume' : 'Pause';
  if (p) narrator.pause(); else narrator.resume();
};

$('stop-trip').onclick = () => {
  trip?.stop();
  keepAwake(false);
  showDriving(false);
  $('now').hidden = true;
  toast('Trip ended.');
};

$('np-pause').onclick = () => {
  if (narrator.paused) narrator.resume(); else narrator.pause();
};
$('np-skip').onclick = () => trip?.skip();
$('np-replay').onclick = () => trip?.replay();
narrator.onstate = () => {
  $('np-pause').textContent = narrator.paused ? '▶' : '⏸';
  $('np-pause').setAttribute('aria-label', narrator.paused ? 'Resume' : 'Pause');
};

function playNow(poi) {
  if (!trip) return;
  narrator.unlock();
  trip.narrate(poi, { manual: true });
}

let lastRender = 0;
function wireTrip(t) {
  t.onposition = (point, along) => {
    if (!carMarker) {
      carMarker = L.marker(point, {
        icon: L.divIcon({ className: '', html: '<div class="car-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 1000,
        keyboard: false,
      }).addTo(map);
    } else carMarker.setLatLng(point);
    if (follow) {
      if (map.getZoom() < 11) map.setView(point, 12);
      else map.panTo(point, { animate: true, duration: 0.25 });
    }
    // Grey out the part of the route already driven.
    const i = t.route.segmentAt(along);
    doneLayer?.setLatLngs([...t.route.coords.slice(0, i + 1), t.route.pointAt(along)]);
    const left = t.route.length - along;
    const eta = left / Math.max(1, t.mode === 'sim' ? t.avgSpeed : t.speed);
    $('drive-status').textContent = `${shortDistance(left, prefs.units)} to go · about ${formatDuration(eta)}${t.offRoute ? ' · you seem to be off the planned route' : ''}`;
    if (performance.now() - lastRender > 1000) renderUpcoming();
  };

  t.onnarrate = (poi, script) => {
    if (!poi) {
      $('now').hidden = true;
      $('np-replay').hidden = !t.lastNarrated;
      return;
    }
    $('np-replay').hidden = true;
    for (const m of document.querySelectorAll('.poi-marker.active')) m.classList.remove('active');
    setMarkerState(poi, 'active');
    $('now').hidden = false;
    $('now-title').textContent = poi.title;
    $('now-text').textContent = script;
    $('now-link').href = poi.url;
    $('now-topics').textContent = poi.topics.slice(0, 3).map((x) => `${TOPIC_BY_ID[x].icon} ${TOPIC_BY_ID[x].label}`).join(' · ');
    const img = $('now-thumb');
    img.hidden = !poi.thumb;
    if (poi.thumb) img.src = poi.thumb;
    addToLog(poi);
    renderUpcoming(true);
    setTimeout(() => setMarkerState(poi, 'done'), 0);
  };

  t.ongpserror = () => {
    keepAwake(false);
    showDriving(false);
    $('now').hidden = true;
    showLocationHelp();
  };

  t.onstatus = (msg, kind) => { if (kind === 'error') toast(msg, 'error'); else $('drive-status').textContent = msg; };

  t.onfinish = () => {
    keepAwake(false);
    const wait = () => {
      if (narrator.speaking) return setTimeout(wait, 1000);
      narrator.speak(`You've arrived. ${t.narrated.size ? `That was ${t.narrated.size} stories along the way. ` : ''}Thanks for listening.`);
      showDriving(false);
    };
    wait();
  };
}

function addToLog(poi) {
  if ([...$('log').children].some((li) => li.dataset.id === String(poi.id))) return;
  $('log-card').hidden = false;
  $('log').prepend(poiRow(poi, false));
}

function poiRow(poi, showDistance = true) {
  const li = document.createElement('li');
  li.dataset.id = poi.id;
  const t = TOPIC_BY_ID[primaryTopic(poi)];
  const ahead = trip ? poi.along - trip.along : poi.along;
  li.innerHTML = `
    <span class="ico" title="${escapeHtml(t?.label || 'Place')}">${t?.icon || '📍'}</span>
    <span class="t"><b>${escapeHtml(poi.title)}</b><small>${escapeHtml(poi.description || poi.topics.map((x) => TOPIC_BY_ID[x].label).join(', '))}</small></span>
    ${showDistance ? `<span class="d">${ahead < 100 ? 'now' : shortDistance(ahead, prefs.units)}</span>` : ''}`;
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.textContent = '🔊';
  btn.title = 'Tell me about it now';
  btn.setAttribute('aria-label', `Tell me about ${poi.title}`);
  btn.onclick = (e) => { e.stopPropagation(); playNow(poi); };
  li.append(btn);
  li.onclick = () => {
    follow = false;
    if (trip?.running) $('recenter').hidden = false;
    map.setView(poi.point, Math.max(map.getZoom(), 13));
    markers.get(poi.id)?.openPopup();
  };
  return li;
}

function renderUpcoming(force = false) {
  if (!trip) return;
  if (!force && performance.now() - lastRender < 400) return;
  lastRender = performance.now();
  const list = trip.upcoming(40);
  $('upcoming-count').textContent = list.length ? `(${list.length}${list.length === 40 ? '+' : ''})` : '';
  $('upcoming').replaceChildren(...list.map((p) => poiRow(p)));
}

// ---- location permission help ---------------------------------------------

async function locationBlocked() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state === 'denied';
  } catch {
    return false; // Permissions API unsupported (older Safari): just try.
  }
}

function locationSteps() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const host = location.host;
  if (ios) {
    const chrome = /CriOS/.test(ua);
    const app = chrome ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : 'Safari';
    return [
      'Open the <b>Settings</b> app → <b>Privacy &amp; Security</b> → <b>Location Services</b>, and make sure it is <b>on</b>.',
      app === 'Safari'
        ? 'On that same screen, tap <b>Safari Websites</b> and choose <b>While Using the App</b> (or <b>Ask Next Time</b>).'
        : `On that same screen, tap <b>${app}</b> and choose <b>While Using the App</b>.`,
      app === 'Safari'
        ? `Back in Safari, tap the <b>aA</b> (or page settings) button in the address bar → <b>Website Settings</b> → <b>Location</b> → <b>Allow</b> (or Ask).`
        : `In ${app}, reload this page and tap <b>Allow</b> when asked.`,
      'Reload this page and tap <b>Start driving</b> again.',
    ];
  }
  if (android) {
    return [
      'Make sure the phone\'s <b>Location</b> is on (swipe down from the top of the screen).',
      `In Chrome, tap the icon to the left of <b>${host}</b> in the address bar → <b>Permissions</b> (or <b>Site settings</b>) → <b>Location</b> → <b>Allow</b>.`,
      'If Chrome itself isn\'t allowed: phone <b>Settings</b> → <b>Apps</b> → <b>Chrome</b> → <b>Permissions</b> → <b>Location</b> → <b>Allow only while using the app</b>.',
      'Reload this page and tap <b>Start driving</b> again.',
    ];
  }
  return [
    `Click the icon to the left of <b>${host}</b> in the address bar and set <b>Location</b> to <b>Allow</b>.`,
    'On a Mac, also check System Settings → Privacy &amp; Security → Location Services for your browser.',
    'Reload this page and try again.',
  ];
}

function showLocationHelp() {
  $('geo-help-steps').innerHTML = locationSteps().map((x) => `<li>${x}</li>`).join('');
  const d = $('geo-help');
  if (d.showModal) d.showModal();
  else d.setAttribute('open', '');
}
$('geo-help-close').onclick = () => $('geo-help').close();
$('geo-help-sim').onclick = () => {
  $('geo-help').close();
  if (trip) $('start-sim').click();
  else toast('Plan a route first, then tap “Simulate the drive”.');
};

// ---- boot -----------------------------------------------------------------

renderTopics();
if (!narrator.available) toast("This browser can't speak, so stories will be shown as text.");
