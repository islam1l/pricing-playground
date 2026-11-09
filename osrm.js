export const DEFAULT_BASE_URL = 'https://router.project-osrm.org';
export const LOCAL_BASE_URL = 'http://localhost:5000';

const PROFILE = 'driving';
const MIN_GAP_MS = 1100;
const TIMEOUT_MS = 15000;

const MESSAGES = {
  NoRoute: 'لا يوجد طريق بالسيارة بين هذه النقاط.',
  NoSegment: 'نقطة أو أكثر بعيدة جدًا عن أي طريق. حرّك الدبوس لأقرب شارع.',
  NoTable: 'تعذر حساب جدول المسافات بين النقاط.',
  TooBig: 'عدد النقاط أكبر من المسموح على هذا السيرفر.',
  InvalidUrl: 'رابط الطلب غير صالح.',
  InvalidService: 'الخدمة غير موجودة على هذا السيرفر.',
  InvalidVersion: 'إصدار الـ API غير مدعوم على هذا السيرفر.',
  InvalidOptions: 'خيارات الطلب غير صالحة.',
  InvalidQuery: 'الطلب غير صالح.',
  InvalidValue: 'قيمة غير صالحة في الطلب.',
  RateLimited: 'السيرفر رفض الطلب بسبب كثرة الطلبات. انتظر قليلًا ثم أعد المحاولة.',
  Network: 'تعذر الاتصال بسيرفر OSRM. تأكد من الرابط وأن السيرفر يعمل ويسمح بـ CORS.',
  LocalDown: 'سيرفر OSRM المحلي غير شغال. شغّله بالأمر: docker start osrm-egypt (أو اتبع خطوات README أول مرة).',
  Timeout: `انتهت مهلة الطلب (${TIMEOUT_MS / 1000} ثانية) دون رد من السيرفر.`,
  BadResponse: 'رد غير متوقع من السيرفر.',
  Cancelled: 'تم إلغاء الطلب.',
};

export class OsrmError extends Error {
  constructor(code, detail = '') {
    const base = MESSAGES[code] ?? 'خطأ من سيرفر OSRM.';
    super(detail ? `${base} (${code}: ${detail})` : `${base} (${code})`);
    this.code = code;
  }
}

let baseUrl = DEFAULT_BASE_URL;

export function setBaseUrl(url) {
  baseUrl = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

export function getBaseUrl() {
  return baseUrl;
}

function isLocal() {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function toOsrm(point) {
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
}

export function fromOsrm([lng, lat]) {
  return [lat, lng];
}

let queueTail = Promise.resolve();
let lastFinishedAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueue(task) {
  const run = queueTail.then(async () => {
    const wait = isLocal() ? 0 : lastFinishedAt + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    try {
      return await task();
    } finally {
      lastFinishedAt = Date.now();
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function request(service, points, query, { isCancelled } = {}) {
  return enqueue(async () => {
    if (isCancelled?.()) {
      throw new OsrmError('Cancelled');
    }

    const hints = points.every((point) => point.hint) ? `&hints=${points.map((point) => point.hint).join(';')}` : '';
    const url = `${baseUrl}/${service}/v1/${PROFILE}/${points.map(toOsrm).join(';')}?${query}${hints}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    let body;
    try {
      response = await fetch(url, { signal: controller.signal });
      body = await response.json().catch(() => null);
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new OsrmError('Timeout');
      }
      throw new OsrmError(isLocal() ? 'LocalDown' : 'Network');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new OsrmError('RateLimited');
    }
    if (!body) {
      throw new OsrmError('BadResponse', `HTTP ${response.status}`);
    }
    if (body.code !== 'Ok') {
      throw new OsrmError(body.code ?? 'BadResponse', body.message ?? `HTTP ${response.status}`);
    }
    return body;
  });
}

export async function table(points, options) {
  const body = await request('table', points, 'annotations=distance,duration', options);
  return {
    distances: body.distances ?? null,
    durations: body.durations ?? null,
    snaps: (body.sources ?? []).map((waypoint) => waypoint.distance ?? 0),
  };
}

export async function nearest(point, number, options) {
  const body = await request('nearest', [point], `number=${number}`, options);
  return (body.waypoints ?? []).map((waypoint) => {
    const [lat, lng] = fromOsrm(waypoint.location);
    return { lat, lng, distance: waypoint.distance ?? 0, name: waypoint.name ?? '', hint: waypoint.hint ?? null };
  });
}

export async function route(points, options) {
  const body = await request('route', points, 'overview=full&geometries=geojson&steps=false', options);
  const best = body.routes?.[0];
  if (!best) {
    throw new OsrmError('NoRoute');
  }
  const waypoints = body.waypoints ?? [];
  return {
    distance: best.distance,
    duration: best.duration,
    legs: best.legs.map((leg) => ({ distance: leg.distance, duration: leg.duration })),
    latLngs: (best.geometry?.coordinates ?? []).map(fromOsrm),
    snaps: waypoints.map((waypoint) => waypoint.distance ?? 0),
    snapped: waypoints.map((waypoint) => fromOsrm(waypoint.location)),
    snapNames: waypoints.map((waypoint) => waypoint.name ?? ''),
  };
}
