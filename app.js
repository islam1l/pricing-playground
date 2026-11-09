import { PARAMS, calculatePrice, defaultParams, normalizeParams, validateTiers } from './pricing.js';
import * as osrm from './osrm.js';

const MAX_STOPS = 8;
const DEBOUNCE_MS = 800;
const CENTER = { lat: 30.5965, lng: 32.2715 };
const FAR_FROM_CENTER_KM = 150;

const STORAGE = {
  params: 'pricing-playground.params',
  settings: 'pricing-playground.settings',
  points: 'pricing-playground.points',
  cases: 'pricing-playground.cases',
};

const DEFAULT_SETTINGS = {
  baseUrl: osrm.DEFAULT_BASE_URL,
  snapThreshold: 300,
  criterion: 'distance',
  enteredOrder: true,
  tolerance: 2,
  snapTolerance: 30,
};

const DEFAULT_POINTS = {
  hub: { id: '8s1a6h67mw6afh5f', lat: 30.604481, lng: 32.273681, name: 'نقطة التجمع' },
  stops: [{ id: 'u3svxoj0mw8heibv', lat: 30.591524, lng: 32.30195, name: 'محطة 1' }],
  delivery: { id: 's9pgpq8cmw8hhjou', lat: 30.617158, lng: 32.292337, name: 'التسليم' },
};

const storedPoints = load(STORAGE.points) ?? structuredClone(DEFAULT_POINTS);

const state = {
  mode: 'stop',
  hub: storedPoints.hub ?? null,
  stops: Array.isArray(storedPoints.stops) ? storedPoints.stops.slice(0, MAX_STOPS) : [],
  delivery: storedPoints.delivery ?? null,
  params: normalizeParams(load(STORAGE.params)),
  settings: { ...DEFAULT_SETTINGS, ...(load(STORAGE.settings) ?? {}) },
  route: null,
  status: { kind: 'idle', message: '' },
  cases: Array.isArray(load(STORAGE.cases)) ? load(STORAGE.cases) : [],
  reroutingCases: false,
  tiersDraft: [],
  tiersError: null,
};

delete state.settings.smartSnap;
delete state.settings.snapRadius;
osrm.setBaseUrl(state.settings.baseUrl);

const $ = (id) => document.getElementById(id);

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const savePoints = () => save(STORAGE.points, { hub: state.hub, stops: state.stops, delivery: state.delivery });
const saveCases = () => save(STORAGE.cases, state.cases);
const saveSettings = () => save(STORAGE.settings, state.settings);
const saveParams = () => save(STORAGE.params, state.params);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const clone = (value) => JSON.parse(JSON.stringify(value));
const km = (meters) => (meters / 1000).toFixed(2);
const minutes = (seconds) => (seconds / 60).toFixed(1);
const money = (value) => `${Number(value).toLocaleString('en', { maximumFractionDigits: 2 })} ج.م`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

let toastTimer = null;
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 3500);
}

function haversineKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const map = L.map('map').setView([CENTER.lat, CENTER.lng], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.attributionControl.addAttribution('Routing &copy; <a href="https://project-osrm.org/">OSRM</a>');

const markersLayer = L.layerGroup().addTo(map);
const snapLayer = L.layerGroup().addTo(map);
let routeLine = null;

map.on('click', (event) => {
  if (state.mode !== 'none') {
    addPoint(state.mode, event.latlng.lat, event.latlng.lng);
  }
});

function orderPoints() {
  return { hub: state.hub, stops: state.stops, delivery: state.delivery };
}

function findPoint(id) {
  if (state.hub?.id === id) {
    return state.hub;
  }
  if (state.delivery?.id === id) {
    return state.delivery;
  }
  return state.stops.find((stop) => stop.id === id) ?? null;
}

function addPoint(kind, lat, lng) {
  const point = { id: uid(), lat: round6(lat), lng: round6(lng) };
  if (kind === 'hub') {
    state.hub = { ...point, name: 'نقطة التجمع' };
  } else if (kind === 'delivery') {
    state.delivery = { ...point, name: 'التسليم' };
  } else {
    if (state.stops.length >= MAX_STOPS) {
      toast(`الحد الأقصى ${MAX_STOPS} محطات.`);
      return;
    }
    state.stops.push({ ...point, name: `محطة ${state.stops.length + 1}` });
  }
  if (haversineKm(CENTER, point) > FAR_FROM_CENTER_KM) {
    toast('النقطة بعيدة جدًا عن الإسماعيلية. تأكد أن الترتيب lat, lng.');
  }
  pointsChanged();
}

function removePoint(id) {
  if (state.hub?.id === id) {
    state.hub = null;
  } else if (state.delivery?.id === id) {
    state.delivery = null;
  } else {
    state.stops = state.stops.filter((stop) => stop.id !== id);
  }
  pointsChanged();
}

function moveStop(id, offset) {
  const index = state.stops.findIndex((stop) => stop.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= state.stops.length) {
    return;
  }
  [state.stops[index], state.stops[target]] = [state.stops[target], state.stops[index]];
  pointsChanged();
}

const DELIVERY_NAME = 'التسليم';
const isDefaultStopName = (name) => /^محطة \d+$/.test(name);

function swapWithDelivery(id) {
  const stop = state.stops.find((candidate) => candidate.id === id);
  const delivery = state.delivery;
  if (!stop || !delivery) {
    return;
  }
  [stop.lat, delivery.lat] = [delivery.lat, stop.lat];
  [stop.lng, delivery.lng] = [delivery.lng, stop.lng];
  const stopName = stop.name;
  const deliveryName = delivery.name;
  const stopIndex = state.stops.indexOf(stop) + 1;
  stop.name = deliveryName === DELIVERY_NAME ? `محطة ${stopIndex}` : deliveryName;
  delivery.name = isDefaultStopName(stopName) ? DELIVERY_NAME : stopName;
  pointsChanged();
}

function pointsChanged() {
  savePoints();
  renderMarkers();
  renderPoints();
  scheduleRecalc();
}

function snapWarnings(route = state.route) {
  if (!route) {
    return [];
  }
  return route.snaps.filter((snap) => snap.distance > state.settings.snapThreshold);
}

function renderMarkers() {
  markersLayer.clearLayers();
  const warned = new Set(snapWarnings().map((snap) => snap.id));

  const addMarker = (point, kind, label) => {
    const icon = L.divIcon({
      className: 'pin-icon',
      html: `<div class="pin pin-${kind}${warned.has(point.id) ? ' pin-warn' : ''}">${label}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([point.lat, point.lng], { icon, draggable: true, keyboard: false });
    marker.bindTooltip(esc(point.name), { direction: 'top', offset: [0, -14] });
    marker.on('dragend', () => {
      const position = marker.getLatLng();
      point.lat = round6(position.lat);
      point.lng = round6(position.lng);
      pointsChanged();
    });
    marker.addTo(markersLayer);
  };

  if (state.hub) {
    addMarker(state.hub, 'hub', '★');
  }
  state.stops.forEach((stop, index) => addMarker(stop, 'stop', String(index + 1)));
  if (state.delivery) {
    addMarker(state.delivery, 'delivery', '⚑');
  }
}

function pointRow(point, kind, label, index) {
  const warned = snapWarnings().some((snap) => snap.id === point.id);
  const moveButtons = kind === 'stop'
    ? `<button type="button" data-action="up" data-id="${point.id}" ${index === 0 ? 'disabled' : ''} title="لأعلى">▲</button>
       <button type="button" data-action="down" data-id="${point.id}" ${index === state.stops.length - 1 ? 'disabled' : ''} title="لأسفل">▼</button>
       <button type="button" data-action="swap" data-id="${point.id}" ${state.delivery ? '' : 'disabled'} title="بدّل مع نقطة التسليم">⇄</button>`
    : '';
  return `
    <div class="point-row${warned ? ' has-warning' : ''}">
      <span class="badge badge-${kind}">${label}</span>
      <div class="point-fields">
        <input class="name" data-id="${point.id}" data-field="name" value="${esc(point.name)}">
        <div class="coords">
          <input class="ltr-input" dir="ltr" data-id="${point.id}" data-field="lat" value="${point.lat}" title="lat">
          <input class="ltr-input" dir="ltr" data-id="${point.id}" data-field="lng" value="${point.lng}" title="lng">
        </div>
      </div>
      <div class="point-actions">
        ${moveButtons}
        <button type="button" data-action="delete" data-id="${point.id}" title="حذف">✕</button>
      </div>
    </div>`;
}

function renderPoints() {
  const rows = [];
  if (state.hub) {
    rows.push(pointRow(state.hub, 'hub', '★'));
  } else {
    rows.push('<p class="notice notice-info">لم تُحدَّد نقطة التجمع، فمسافة الوصول = 0.</p>');
  }
  state.stops.forEach((stop, index) => rows.push(pointRow(stop, 'stop', String(index + 1), index)));
  if (state.stops.length === 0) {
    rows.push('<p class="empty">لا توجد محطات بعد.</p>');
  }
  if (state.delivery) {
    rows.push(pointRow(state.delivery, 'delivery', '⚑'));
  } else {
    rows.push('<p class="notice notice-info">بدون نقطة تسليم: المسار بينتهي عند آخر محطة، وآخر محطة مش بتتحسب محطة إضافية.</p>');
  }
  $('points-list').innerHTML = rows.join('');
}

$('points-list').addEventListener('change', (event) => {
  const { id, field } = event.target.dataset;
  const point = id && findPoint(id);
  if (!point) {
    return;
  }
  if (field === 'name') {
    point.name = event.target.value.trim() || point.name;
    savePoints();
    renderMarkers();
    renderRouteInfo();
    return;
  }
  const value = Number(event.target.value);
  const limit = field === 'lat' ? 90 : 180;
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    toast('قيمة إحداثيات غير صالحة.');
    event.target.value = point[field];
    return;
  }
  point[field] = round6(value);
  pointsChanged();
});

$('points-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }
  const { action, id } = button.dataset;
  if (action === 'delete') {
    removePoint(id);
  } else if (action === 'up') {
    moveStop(id, -1);
  } else if (action === 'down') {
    moveStop(id, 1);
  } else if (action === 'swap') {
    swapWithDelivery(id);
  }
});

function renderModes() {
  for (const button of $('mode-buttons').querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.mode === state.mode);
  }
  document.querySelector('.map-wrap').classList.toggle('is-adding', state.mode !== 'none');
}

$('mode-buttons').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (button) {
    state.mode = button.dataset.mode;
    renderModes();
  }
});

function parseLatLng(text) {
  const match = String(text).match(/(-?\d+(?:\.\d+)?)\s*[,،\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

document.querySelectorAll('[data-paste]').forEach((button) => {
  button.addEventListener('click', () => {
    const position = parseLatLng($('paste-input').value);
    if (!position) {
      toast('اكتب الإحداثيات بالشكل: 30.5965, 32.2715');
      return;
    }
    addPoint(button.dataset.paste, position.lat, position.lng);
    $('paste-input').value = '';
    map.panTo([position.lat, position.lng]);
  });
});

$('btn-clear').addEventListener('click', () => {
  state.stops = [];
  state.delivery = null;
  pointsChanged();
});

let debounceTimer = null;
let recalcToken = 0;

function scheduleRecalc() {
  clearTimeout(debounceTimer);
  recalcToken += 1;
  const routable = state.stops.length > 0 && Boolean(state.delivery || state.hub || state.stops.length > 1);
  if (!routable) {
    state.route = null;
    setStatus('idle', '');
    renderRouteAndPrice();
    return;
  }
  setStatus('loading', 'بانتظار توقف التعديل…');
  debounceTimer = setTimeout(recalc, DEBOUNCE_MS);
}

async function recalc() {
  const token = ++recalcToken;
  const isCancelled = () => token !== recalcToken;
  setStatus('loading', 'جاري حساب المسار…');
  try {
    const route = await computeRoute(orderPoints(), isCancelled, (message) => {
      if (!isCancelled()) {
        setStatus('loading', message);
      }
    });
    if (isCancelled()) {
      return;
    }
    state.route = route;
    setStatus('loading', 'جاري رسم المسار…');
  } catch (error) {
    if (isCancelled() || error.code === 'Cancelled') {
      return;
    }
    state.route = null;
    setStatus('error', error.message);
    renderRouteAndPrice();
    return;
  }
  renderRouteAndPrice();

  const route = state.route;
  try {
    await fetchGeometry(route, isCancelled, (message) => {
      if (!isCancelled()) {
        setStatus('loading', message);
      }
    }, () => {
      if (!isCancelled()) {
        renderRouteLine();
      }
    });
    if (!isCancelled()) {
      setStatus('ok', '');
    }
  } catch (error) {
    if (!isCancelled() && error.code !== 'Cancelled') {
      setStatus('error', `السعر محسوب، لكن تعذر رسم المسار على الخريطة: ${error.message}`);
    }
  }
}

function setStatus(kind, message) {
  state.status = { kind, message };
  const element = $('map-status');
  element.hidden = !message;
  element.textContent = message;
  element.className = `map-status${kind === 'error' ? ' is-error' : ''}${kind === 'loading' ? ' is-loading' : ''}`;
}

function* permutations(items) {
  const values = [...items];
  const counters = new Array(values.length).fill(0);
  yield values;
  let i = 1;
  while (i < values.length) {
    if (counters[i] < i) {
      const j = i % 2 ? counters[i] : 0;
      [values[j], values[i]] = [values[i], values[j]];
      yield values;
      counters[i] += 1;
      i = 1;
    } else {
      counters[i] = 0;
      i += 1;
    }
  }
}

const NEAREST_COUNT = 10;
const MAX_CANDIDATES = 8;
const MAX_TABLE_SIZE = 100;
const DUPLICATE_METERS = 1;
const nearestCache = new Map();
const geometryCache = new Map();

const pointKey = (point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

function filterCandidates(raw, point, limit) {
  const kept = [];
  for (const candidate of raw) {
    if (candidate.distance > state.settings.snapTolerance || kept.length === limit) {
      break;
    }
    if (kept.some((other) => haversineKm(other, candidate) * 1000 < DUPLICATE_METERS)) {
      continue;
    }
    kept.push({ ...candidate, fallback: false });
  }
  if (kept.length) {
    return kept;
  }
  if (raw.length) {
    return [{ ...raw[0], fallback: true }];
  }
  return [{ lat: point.lat, lng: point.lng, distance: null, name: '', hint: null, fallback: true }];
}

async function snapCandidates(nodes, isCancelled, onProgress) {
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(MAX_TABLE_SIZE / nodes.length)));
  const result = [];
  for (const [index, node] of nodes.entries()) {
    const key = `${osrm.getBaseUrl()}|${pointKey(node)}`;
    if (!nearestCache.has(key)) {
      onProgress?.(`جاري البحث عن الطرق القريبة (${index + 1}/${nodes.length})…`);
      nearestCache.set(key, await osrm.nearest(node, NEAREST_COUNT, { isCancelled }));
    }
    result.push(filterCandidates(nearestCache.get(key), node, limit));
  }
  return result;
}

function bestLegs(table, groups, criterion) {
  const metric = criterion === 'duration' ? table.durations : table.distances;
  return groups.map((fromGroup) => groups.map((toGroup) => {
    let best = null;
    for (const [fromPick, source] of fromGroup.entries()) {
      for (const [toPick, target] of toGroup.entries()) {
        const cost = metric[source]?.[target];
        const distance = table.distances[source]?.[target];
        if (cost === null || cost === undefined || distance === null || distance === undefined) {
          continue;
        }
        if (!best || cost < best.cost) {
          best = { cost, distance, duration: table.durations?.[source]?.[target] ?? 0, fromPick, toPick };
        }
      }
    }
    return best;
  }));
}

function sequenceCost(legs, sequence) {
  let cost = 0;
  for (let step = 1; step < sequence.length; step += 1) {
    const leg = legs[sequence[step - 1]][sequence[step]];
    if (!leg) {
      return Infinity;
    }
    cost += leg.cost;
  }
  return cost;
}

const snapInfo = (candidate, role) => ({
  role,
  lat: candidate.lat,
  lng: candidate.lng,
  name: candidate.name ?? '',
  distance: candidate.distance,
});

async function computeRoute({ hub, stops, delivery }, isCancelled, onProgress) {
  const withHub = Boolean(hub);
  const withDelivery = Boolean(delivery);
  const nodes = [...(withHub ? [hub] : []), ...stops, ...(withDelivery ? [delivery] : [])];
  const offset = withHub ? 1 : 0;
  const endIndex = nodes.length - 1;
  const freeCount = withDelivery ? stops.length : stops.length - 1;
  const fixedTail = withDelivery ? [] : [stops.length - 1];
  const criterion = state.settings.criterion;

  const candidates = await snapCandidates(nodes, isCancelled, onProgress);
  const flat = [];
  const groups = candidates.map((list) => list.map((candidate) => flat.push(candidate) - 1));

  onProgress?.('جاري حساب جدول المسافات…');
  const table = await osrm.table(flat, { isCancelled });
  if (!table.distances) {
    throw new osrm.OsrmError('NoTable', 'distances');
  }
  const legs = bestLegs(table, groups, criterion);

  const sequenceFor = (permutation) => [...(withHub ? [0] : []), ...permutation.map((index) => offset + index), endIndex];
  const enteredOrder = Array.from({ length: freeCount }, (_, index) => index);
  const optimize = !state.settings.enteredOrder && freeCount > 1;
  const enteredCost = sequenceCost(legs, sequenceFor(enteredOrder));
  let best = { order: enteredOrder, cost: enteredCost };
  if (optimize) {
    for (const permutation of permutations(enteredOrder)) {
      const cost = sequenceCost(legs, sequenceFor(permutation));
      if (cost < best.cost) {
        best = { order: [...permutation], cost };
      }
    }
  }
  if (!Number.isFinite(best.cost)) {
    throw new osrm.OsrmError('NoRoute');
  }

  const order = [...best.order, ...fixedTail];
  const sequence = sequenceFor(best.order);
  const ordered = sequence.map((nodeIndex) => nodes[nodeIndex]);
  const chosenLegs = sequence.slice(1).map((nodeIndex, step) => {
    const leg = legs[sequence[step]][nodeIndex];
    return {
      ...leg,
      from: candidates[sequence[step]][leg.fromPick],
      to: candidates[nodeIndex][leg.toPick],
    };
  });

  const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
  const approachLegs = withHub ? chosenLegs.slice(0, 1) : [];
  const tripLegs = withHub ? chosenLegs.slice(1) : chosenLegs;
  const approach = { distance: sum(approachLegs, 'distance'), duration: sum(approachLegs, 'duration') };
  const trip = { distance: sum(tripLegs, 'distance'), duration: sum(tripLegs, 'duration') };

  const orderedPoints = ordered.map(({ id, name, lat, lng }, step) => {
    const used = [];
    if (step > 0) {
      used.push(snapInfo(chosenLegs[step - 1].to, 'arrive'));
    }
    if (step < chosenLegs.length) {
      used.push(snapInfo(chosenLegs[step].from, 'depart'));
    }
    const snaps = used.filter((snap, index) => index === 0 || haversineKm(snap, used[0]) * 1000 >= DUPLICATE_METERS);
    const group = candidates[sequence[step]];
    return { id, name, lat, lng, snaps, candidates: group.length, fallback: group[0].fallback };
  });

  return {
    summary: {
      approach,
      trip,
      totalDistance: approach.distance + trip.distance,
      totalDuration: approach.duration + trip.duration,
      stopsCount: stops.length,
      hasHub: withHub,
      hasDelivery: withDelivery,
      order,
      legs: chosenLegs.map((leg, index) => ({
        fromId: ordered[index].id,
        toId: ordered[index + 1].id,
        distance: leg.distance,
        duration: leg.duration,
      })),
    },
    orderedPoints,
    legEnds: chosenLegs.map(({ from, to }) => [
      { lat: from.lat, lng: from.lng, hint: from.hint ?? null },
      { lat: to.lat, lng: to.lng, hint: to.hint ?? null },
    ]),
    geometry: [],
    snaps: orderedPoints.map((point) => ({
      id: point.id,
      name: point.name,
      distance: Math.max(0, ...point.snaps.map((snap) => snap.distance ?? 0)),
    })),
    comparison: optimize ? { metric: criterion === 'duration' ? 'duration' : 'distance', best: best.cost, entered: enteredCost } : null,
    settings: {
      criterion,
      enteredOrder: state.settings.enteredOrder,
      snapTolerance: state.settings.snapTolerance,
      baseUrl: osrm.getBaseUrl(),
    },
  };
}

async function fetchGeometry(route, isCancelled, onProgress, onLeg) {
  const baseUrl = route.settings.baseUrl;
  const geometry = [];
  for (const [index, ends] of route.legEnds.entries()) {
    const key = `${baseUrl}|${ends.map(pointKey).join('|')}`;
    if (!geometryCache.has(key)) {
      onProgress?.(`جاري رسم المسار (${index + 1}/${route.legEnds.length})…`);
      geometryCache.set(key, (await osrm.route(ends, { isCancelled })).latLngs);
    }
    geometry.push(geometryCache.get(key));
    route.geometry = [...geometry];
    onLeg?.();
  }
  return route;
}

function nameOf(route, id) {
  return findPoint(id)?.name ?? route.orderedPoints.find((point) => point.id === id)?.name ?? '؟';
}

function kindOf(route, id, index) {
  if (index === route.orderedPoints.length - 1 && route.summary.hasDelivery !== false) {
    return 'delivery';
  }
  if (route.summary.hasHub && index === 0) {
    return 'hub';
  }
  return 'stop';
}

function googleMapsUrl(route) {
  return `https://www.google.com/maps/dir/${route.orderedPoints.map((point) => `${point.lat},${point.lng}`).join('/')}`;
}

function renderRouteLine() {
  if (routeLine) {
    routeLine.remove();
    routeLine = null;
  }
  snapLayer.clearLayers();
  if (state.route?.geometry?.length) {
    routeLine = L.polyline(state.route.geometry, { color: '#2563eb', weight: 5, opacity: 0.75 }).addTo(map);
  }
  for (const point of state.route?.orderedPoints ?? []) {
    for (const snap of pointSnaps(point)) {
      if (haversineKm(point, snap) * 1000 < 3) {
        continue;
      }
      L.polyline([[point.lat, point.lng], [snap.lat, snap.lng]], { color: '#d97706', weight: 2, dashArray: '5 5' }).addTo(snapLayer);
      L.circleMarker([snap.lat, snap.lng], { radius: 5, color: '#d97706', weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${SNAP_ROLES[snap.role]}: ${esc(snap.name || 'طريق بدون اسم')}`)
        .addTo(snapLayer);
    }
  }
}

const SNAP_ROLES = { arrive: 'وصول', depart: 'مغادرة', both: 'على الطريق' };

function pointSnaps(point) {
  if (Array.isArray(point.snaps)) {
    return point.snaps.length === 1 ? [{ ...point.snaps[0], role: 'both' }] : point.snaps;
  }
  if (point.snapLat === undefined) {
    return [];
  }
  return [{ role: 'both', lat: point.snapLat, lng: point.snapLng, name: point.snapName, distance: null }];
}

function snapLine(route, point) {
  const snaps = pointSnaps(point);
  if (!snaps.length) {
    return '';
  }
  const describe = (snap) => {
    const meters = Math.round(snap.distance ?? haversineKm(point, snap) * 1000);
    return `${snaps.length > 1 ? `${SNAP_ROLES[snap.role]} ` : ''}«${esc(snap.name || 'طريق بدون اسم')}» على بعد ${meters} م`;
  };
  const fallback = point.fallback && route.settings?.snapTolerance !== undefined
    ? ` <span class="snap-fallback">(مفيش طريق في نطاق ${route.settings.snapTolerance} م، اتاخد أقرب طريق)</span>`
    : '';
  return `<li><b>${esc(nameOf(route, point.id))}</b>: ${snaps.map(describe).join(' · ')}${fallback}</li>`;
}

function renderRouteInfo() {
  const container = $('route-info');
  const route = state.route;
  if (!route) {
    container.innerHTML = state.status.kind === 'error'
      ? `<p class="notice notice-error">${esc(state.status.message)}</p>`
      : '<p class="empty">أضف محطة واحدة على الأقل، ومعاها نقطة تجمع أو نقطة تسليم أو محطة تانية.</p>';
    return;
  }

  const { summary } = route;
  const chips = route.orderedPoints.map((point, index) => {
    const kind = kindOf(route, point.id, index);
    return `<span class="chip chip-${kind}">${esc(nameOf(route, point.id))}</span>`;
  }).join('<span class="arrow">←</span>');

  const legs = summary.legs.map((leg, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(nameOf(route, leg.fromId))} ← ${esc(nameOf(route, leg.toId))}</td>
      <td class="num">${km(leg.distance)}</td>
      <td class="num">${minutes(leg.duration)}</td>
    </tr>`).join('');

  const notices = [];
  if (route.settings?.enteredOrder) {
    notices.push('<p class="notice notice-info">التسعير بالترتيب المدخل (بدون تحسين).</p>');
  } else if (route.comparison) {
    const { metric, best, entered } = route.comparison;
    const format = metric === 'distance' ? (value) => `${km(value)} كم` : (value) => `${minutes(value)} د`;
    const saved = entered - best;
    notices.push(`<p class="notice notice-info">الترتيب الأمثل (${metric === 'distance' ? 'مسافة' : 'وقت'}): ${format(best)} مقابل ${format(entered)} بالترتيب المدخل${saved > 0 ? `، توفير ${format(saved)}` : ''}.</p>`);
  }
  const snapLines = route.orderedPoints.map((point) => snapLine(route, point)).join('');
  if (snapLines) {
    notices.push(`<div class="notice notice-info snap-list">الالتقاط على الطريق (الخط البرتقالي المتقطع):<ul>${snapLines}</ul></div>`);
  }
  for (const snap of snapWarnings(route)) {
    notices.push(`<p class="notice notice-warn">⚠ "${esc(nameOf(route, snap.id))}" تبعد ${Math.round(snap.distance)} م عن أقرب طريق. غالبًا الدبوس خارج الطريق أو المنطقة غير مرسومة جيدًا.</p>`);
  }

  container.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="stat-label">المسافة الكلية</div><div class="stat-value">${km(summary.totalDistance)} كم</div></div>
      <div class="stat"><div class="stat-label">الوقت الكلي</div><div class="stat-value">${minutes(summary.totalDuration)} د</div></div>
      <div class="stat"><div class="stat-label">الوصول (من نقطة التجمع)</div><div class="stat-value">${km(summary.approach.distance)} كم · ${minutes(summary.approach.duration)} د</div></div>
      <div class="stat"><div class="stat-label">الرحلة (بعد أول محطة)</div><div class="stat-value">${km(summary.trip.distance)} كم · ${minutes(summary.trip.duration)} د</div></div>
    </div>
    <div class="order-chips">${chips}</div>
    ${notices.join('')}
    <table>
      <thead><tr><th>#</th><th>المرحلة</th><th class="num">كم</th><th class="num">دقيقة</th></tr></thead>
      <tbody>${legs}</tbody>
    </table>
    <a class="gmaps-link" href="${googleMapsUrl(route)}" target="_blank" rel="noopener">افتح في Google Maps ↗</a>`;
}

function renderPrice() {
  const container = $('price');
  const route = state.route;
  $('validation').hidden = !route;
  if (!route) {
    container.innerHTML = '<p class="empty">السعر يظهر بعد حساب المسار.</p>';
    return;
  }

  const price = calculatePrice(route.summary, state.params);
  const warnings = [
    ...(state.tiersError ? ['شرائح المسافة فيها خطأ، والسعر المعروض محسوب بآخر شرائح صحيحة.'] : []),
    ...price.warnings,
  ].map((warning) => `<p class="notice notice-warn">⚠ ${esc(warning)}</p>`).join('');
  $('btn-correct').disabled = price.overLimit;

  if (price.overLimit) {
    container.innerHTML = `
      <p class="final-price over-limit">خارج الحد الأقصى — تسعير يدوي</p>
      <p class="notice notice-error">${esc(price.overLimitMessage)}</p>
      ${warnings}`;
    return;
  }

  const rows = price.components.map((component) => `
    <tr>
      <td>${esc(component.label)}${component.detail ? `<div class="detail">${esc(component.detail)}</div>` : ''}</td>
      <td class="num">${component.amountText ? esc(component.amountText) : money(component.amount)}</td>
    </tr>`).join('');

  const { approachKm, tripKm, totalKm, approachTierKm, approachExtraKm, tieredKm } = price.inputs;
  const tieredSplit = approachExtraKm > 0.005
    ? `رحلة ${tripKm.toFixed(2)} + زيادة الوصول ${approachExtraKm.toFixed(2)}`
    : `رحلة ${tripKm.toFixed(2)}`;
  container.innerHTML = `
    <p class="final-price">${money(price.final)}</p>
    <p class="detail">المسافة الكلية ${totalKm.toFixed(2)} كم = وصول ${approachKm.toFixed(2)} + رحلة ${tripKm.toFixed(2)}<br>
      بسعر الوصول ${approachTierKm.toFixed(2)} كم · على الشرائح ${tieredKm.toFixed(2)} كم (${tieredSplit})</p>
    ${warnings}
    <table>
      <tbody>
        ${rows}
        <tr class="subtotal"><td>الإجمالي الخام</td><td class="num">${money(price.raw)}</td></tr>
        <tr><td>بعد الحد الأدنى (${money(price.minFare)})</td><td class="num">${money(price.afterMinFare)}</td></tr>
        <tr class="total"><td>السعر النهائي${price.roundingStep ? `<div class="detail">تقريب لأعلى لأقرب ${price.roundingStep} ج.م</div>` : ''}</td><td class="num">${money(price.final)}</td></tr>
      </tbody>
    </table>`;
}

function renderRouteAndPrice() {
  renderRouteLine();
  renderRouteInfo();
  renderMarkers();
  renderPoints();
  renderPrice();
}

function resetValidationForm() {
  $('case-name').value = '';
  $('case-note').value = '';
  $('case-expected').value = '';
  $('wrong-form').hidden = true;
}

function saveCase(verdict, expected) {
  const route = state.route;
  if (!route) {
    return;
  }
  const computed = calculatePrice(route.summary, state.params).final;
  state.cases.unshift({
    id: uid(),
    name: $('case-name').value.trim() || `حالة ${state.cases.length + 1}`,
    note: $('case-note').value.trim(),
    createdAt: new Date().toISOString(),
    verdict,
    expected,
    computedAtSave: computed,
    paramsAtSave: clone(state.params),
    points: clone(orderPoints()),
    stopsCount: route.summary.stopsCount,
    distance: route.summary.totalDistance,
    duration: route.summary.totalDuration,
    route: clone(route),
  });
  saveCases();
  resetValidationForm();
  renderCases();
  toast('تم حفظ الحالة.');
}

$('btn-correct').addEventListener('click', () => {
  const price = state.route && calculatePrice(state.route.summary, state.params);
  if (price && !price.overLimit) {
    saveCase('correct', price.final);
  }
});

$('btn-wrong').addEventListener('click', () => {
  $('wrong-form').hidden = false;
  $('case-expected').focus();
});

$('btn-save-wrong').addEventListener('click', () => {
  const expected = Number($('case-expected').value);
  if ($('case-expected').value === '' || !Number.isFinite(expected) || expected < 0) {
    toast('اكتب السعر الصحيح.');
    return;
  }
  saveCase('wrong', expected);
});

function scalarParamRow(param) {
  return `
    <label class="param-row">
      <span>${esc(param.label)}</span>
      <input type="number" step="any" data-param="${param.key}" value="${state.params[param.key]}">
      <span class="param-unit">${esc(param.unit)}</span>
    </label>`;
}

function tiersEditor(param) {
  return `
    <div class="tiers" id="tiers-editor">
      <div class="tiers-title">${esc(param.label)}</div>
      <table class="tiers-table">
        <thead><tr><th>حتى (كم)</th><th>سعر الكيلو</th><th></th></tr></thead>
        <tbody id="tier-rows"></tbody>
      </table>
      <button type="button" class="btn-ghost" data-tier-add>+ إضافة شريحة</button>
      <p id="tiers-error" class="notice notice-error" hidden></p>
      <p class="hint">الشرائح على كيلومترات الرحلة، ومعاها أي كيلومترات وصول زيادة عن شريحة الوصول، وبتبدأ من أول شريحة. كل شريحة بتحسب الكيلومترات اللي جواها بس. آخر حد هو أقصى مسافة كلية (وصول + رحلة)، وبعده التسعير يدوي.</p>
    </div>`;
}

function renderTierRows() {
  const single = state.tiersDraft.length === 1;
  $('tier-rows').innerHTML = state.tiersDraft.map((tier, index) => `
    <tr>
      <td><input type="number" step="any" min="0" dir="ltr" data-tier="${index}" data-tier-field="up_to_km" value="${Number.isFinite(tier.up_to_km) ? tier.up_to_km : ''}"></td>
      <td><input type="number" step="any" min="0" dir="ltr" data-tier="${index}" data-tier-field="price_per_km" value="${Number.isFinite(tier.price_per_km) ? tier.price_per_km : ''}"></td>
      <td><button type="button" class="case-delete" data-tier-delete="${index}" ${single ? 'disabled' : ''} title="حذف">✕</button></td>
    </tr>`).join('');
}

function renderParamsForm() {
  state.tiersDraft = clone(state.params.distance_tiers);
  state.tiersError = null;
  $('params-form').innerHTML = PARAMS.map((param) => (param.type === 'tiers' ? tiersEditor(param) : scalarParamRow(param))).join('');
  renderTierRows();
}

function applyTiersDraft() {
  state.tiersError = validateTiers(state.tiersDraft);
  $('tiers-error').hidden = !state.tiersError;
  $('tiers-error').textContent = state.tiersError ?? '';
  $('tiers-editor').classList.toggle('is-invalid', Boolean(state.tiersError));
  if (!state.tiersError) {
    state.params.distance_tiers = clone(state.tiersDraft);
    saveParams();
  }
  renderPrice();
  if (!state.tiersError) {
    renderCases();
  }
}

$('params-form').addEventListener('input', (event) => {
  const { tier, tierField, param } = event.target.dataset;
  if (tier !== undefined) {
    state.tiersDraft[Number(tier)][tierField] = event.target.value === '' ? NaN : Number(event.target.value);
    applyTiersDraft();
    return;
  }
  const value = Number(event.target.value);
  if (!param || event.target.value === '' || !Number.isFinite(value)) {
    return;
  }
  state.params[param] = value;
  saveParams();
  if (!state.tiersError) {
    renderPrice();
    renderCases();
  }
});

$('params-form').addEventListener('click', (event) => {
  if (event.target.closest('[data-tier-add]')) {
    const last = state.tiersDraft[state.tiersDraft.length - 1];
    state.tiersDraft.push({
      up_to_km: Number.isFinite(last?.up_to_km) ? last.up_to_km + 5 : 5,
      price_per_km: Number.isFinite(last?.price_per_km) ? last.price_per_km : 1,
    });
  } else {
    const deleteButton = event.target.closest('[data-tier-delete]');
    if (!deleteButton || state.tiersDraft.length === 1) {
      return;
    }
    state.tiersDraft.splice(Number(deleteButton.dataset.tierDelete), 1);
  }
  renderTierRows();
  applyTiersDraft();
});

$('btn-params-reset').addEventListener('click', () => {
  state.params = defaultParams();
  saveParams();
  renderParamsForm();
  renderPrice();
  renderCases();
});

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function readJsonFile(input, onData) {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    try {
      onData(JSON.parse(await file.text()));
    } catch {
      toast('الملف ليس JSON صالحًا.');
    }
  });
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

$('btn-params-export').addEventListener('click', () => download(`pricing-params-${stamp()}.json`, state.params));
$('btn-params-import').addEventListener('click', () => $('file-params').click());
readJsonFile($('file-params'), (data) => {
  state.params = normalizeParams(data?.params ?? data);
  saveParams();
  renderParamsForm();
  renderPrice();
  renderCases();
  toast('تم استيراد المعاملات.');
});

$('btn-export-all').addEventListener('click', () => download(`pricing-all-${stamp()}.json`, {
  exportedAt: new Date().toISOString(),
  params: state.params,
  settings: state.settings,
  points: orderPoints(),
}));

$('btn-cases-export').addEventListener('click', () => download(`pricing-cases-${stamp()}.json`, state.cases));
$('btn-cases-import').addEventListener('click', () => $('file-cases').click());
readJsonFile($('file-cases'), (data) => {
  const incoming = Array.isArray(data) ? data : data?.cases;
  const valid = (incoming ?? []).filter((item) => item?.route?.summary && item?.points?.stops?.length && Number.isFinite(Number(item.expected)));
  if (valid.length === 0) {
    toast('لا توجد حالات صالحة في الملف.');
    return;
  }
  const byId = new Map(state.cases.map((item) => [item.id, item]));
  for (const item of valid) {
    byId.set(item.id ?? uid(), { ...item, id: item.id ?? uid() });
  }
  state.cases = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  saveCases();
  renderCases();
  toast(`تم استيراد ${valid.length} حالة.`);
});

function evaluateCase(item) {
  const current = calculatePrice(item.route.summary, state.params).final;
  if (current === null) {
    return { current, diff: null, matches: false };
  }
  const diff = Math.round((current - Number(item.expected)) * 100) / 100;
  return { current, diff, matches: Math.abs(diff) <= state.settings.tolerance };
}

function renderCases() {
  const container = $('cases');
  if (state.cases.length === 0) {
    container.innerHTML = '<p class="empty">لا توجد حالات محفوظة بعد. احسب مسارًا ثم اضغط "صح" أو "غلط".</p>';
    $('cases-summary').textContent = '';
    return;
  }

  const results = state.cases.map((item) => ({ item, ...evaluateCase(item) }));
  const matched = results.filter((result) => result.matches).length;
  const priced = results.filter((result) => result.current !== null);
  const overLimit = results.length - priced.length;
  const meanAbsError = priced.length ? priced.reduce((sum, result) => sum + Math.abs(result.diff), 0) / priced.length : 0;
  $('cases-summary').textContent = `${matched} من ${results.length} مطابقة (±${state.settings.tolerance} ج.م) · متوسط الفرق ${meanAbsError.toFixed(1)} ج.م${overLimit ? ` · ${overLimit} خارج الحد (تسعير يدوي)` : ''}`;

  container.innerHTML = `
    <table>
      <thead><tr><th>الحالة</th><th class="num">المتوقع</th><th class="num">الحالي</th><th class="num">الفرق</th><th></th></tr></thead>
      <tbody>
        ${results.map(({ item, current, diff, matches }) => `
          <tr data-case="${item.id}" class="${matches ? 'is-match' : 'is-mismatch'}">
            <td>
              <div class="case-name">${item.error ? '⚠ ' : ''}${esc(item.name)}</div>
              <div class="case-meta">${item.stopsCount} محطة · ${km(item.route.summary.totalDistance)} كم · ${item.verdict === 'correct' ? '✓' : '✗'}${item.note ? ` · ${esc(item.note)}` : ''}</div>
              ${item.error ? `<div class="case-meta">${esc(item.error)}</div>` : ''}
            </td>
            <td class="num">${Number(item.expected)}</td>
            <td class="num">${current === null ? 'يدوي' : current}</td>
            <td class="num diff">${diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff}`}</td>
            <td><button type="button" class="case-delete" data-delete-case="${item.id}" title="حذف">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

$('cases').addEventListener('click', (event) => {
  const deleteButton = event.target.closest('[data-delete-case]');
  if (deleteButton) {
    state.cases = state.cases.filter((item) => item.id !== deleteButton.dataset.deleteCase);
    saveCases();
    renderCases();
    return;
  }
  const row = event.target.closest('tr[data-case]');
  const item = row && state.cases.find((candidate) => candidate.id === row.dataset.case);
  if (item) {
    loadCase(item);
  }
});

function loadCase(item) {
  clearTimeout(debounceTimer);
  recalcToken += 1;
  const points = clone(item.points);
  state.hub = points.hub ?? null;
  state.stops = points.stops ?? [];
  state.delivery = points.delivery ?? null;
  state.route = clone(item.route);
  savePoints();
  setStatus('ok', '');
  renderRouteAndPrice();
  fitToPoints();
  toast(`تم تحميل "${item.name}" من البيانات المحفوظة.`);
}

$('btn-reprice-all').addEventListener('click', () => {
  renderCases();
  toast('تمت إعادة تسعير كل الحالات بالمعاملات الحالية.');
});

$('btn-reroute-all').addEventListener('click', async () => {
  if (state.reroutingCases || state.cases.length === 0) {
    return;
  }
  state.reroutingCases = true;
  const button = $('btn-reroute-all');
  button.disabled = true;
  let failures = 0;
  for (const [index, item] of state.cases.entries()) {
    button.textContent = `جاري ${index + 1} / ${state.cases.length}…`;
    try {
      const route = await fetchGeometry(await computeRoute(clone(item.points), () => false), () => false);
      item.route = route;
      item.distance = route.summary.totalDistance;
      item.duration = route.summary.totalDuration;
      item.stopsCount = route.summary.stopsCount;
      item.error = null;
    } catch (error) {
      item.error = error.message;
      failures += 1;
    }
    saveCases();
    renderCases();
  }
  button.textContent = 'إعادة حساب المسارات';
  button.disabled = false;
  state.reroutingCases = false;
  toast(failures ? `انتهى، مع ${failures} حالة فشلت.` : 'تمت إعادة حساب كل المسارات.');
});

function renderSettings() {
  $('osrm-url').value = state.settings.baseUrl;
  $('criterion').value = state.settings.criterion;
  $('entered-order').checked = state.settings.enteredOrder;
  $('snap-threshold').value = state.settings.snapThreshold;
  $('tolerance').value = state.settings.tolerance;
  $('snap-tolerance').value = state.settings.snapTolerance;
}

$('snap-tolerance').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  if (event.target.value !== '' && Number.isFinite(value) && value >= 0) {
    state.settings.snapTolerance = value;
    saveSettings();
    scheduleRecalc();
  }
});

function setBaseUrl(url) {
  osrm.setBaseUrl(url);
  state.settings.baseUrl = osrm.getBaseUrl();
  $('osrm-url').value = state.settings.baseUrl;
  saveSettings();
  scheduleRecalc();
}

$('osrm-url').addEventListener('change', (event) => setBaseUrl(event.target.value));
document.querySelectorAll('[data-osrm]').forEach((button) => {
  button.addEventListener('click', () => setBaseUrl(button.dataset.osrm === 'local' ? osrm.LOCAL_BASE_URL : osrm.DEFAULT_BASE_URL));
});

$('criterion').addEventListener('change', (event) => {
  state.settings.criterion = event.target.value;
  saveSettings();
  scheduleRecalc();
});

$('entered-order').addEventListener('change', (event) => {
  state.settings.enteredOrder = event.target.checked;
  saveSettings();
  scheduleRecalc();
});

$('snap-threshold').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  if (event.target.value !== '' && Number.isFinite(value) && value >= 0) {
    state.settings.snapThreshold = value;
    saveSettings();
    renderRouteInfo();
    renderMarkers();
    renderPoints();
  }
});

$('tolerance').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  if (event.target.value !== '' && Number.isFinite(value) && value >= 0) {
    state.settings.tolerance = value;
    saveSettings();
    renderCases();
  }
});

function fitToPoints() {
  const points = [state.hub, ...state.stops, state.delivery].filter(Boolean);
  if (points.length > 1) {
    map.fitBounds(points.map((point) => [point.lat, point.lng]), { padding: [40, 40] });
  } else if (points.length === 1) {
    map.setView([points[0].lat, points[0].lng], 14);
  }
}

renderModes();
const isLocalPage = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
document.querySelector('[data-osrm="local"]').hidden = !isLocalPage;
renderSettings();
renderParamsForm();
renderCases();
renderMarkers();
renderPoints();
renderRouteAndPrice();
fitToPoints();
scheduleRecalc();
