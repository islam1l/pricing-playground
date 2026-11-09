export const DEFAULT_TIERS = [
  { up_to_km: 5, price_per_km: 3.5 },
  { up_to_km: 10, price_per_km: 4 },
  { up_to_km: 15, price_per_km: 5 },
  { up_to_km: 50, price_per_km: 6 },
];

export const PARAMS = [
  { key: 'base_fee', label: 'رسوم فتح الطلب', default: 20, unit: 'ج.م' },
  { key: 'approach_tier_km', label: 'شريحة الوصول: أول', default: 5, unit: 'كم' },
  { key: 'approach_price_per_km', label: 'شريحة الوصول: سعر الكيلو', default: 2.5, unit: 'ج.م/كم' },
  { key: 'included_km', label: 'كيلومترات مشمولة (من أول الرحلة)', default: 1, unit: 'كم' },
  { key: 'distance_tiers', label: 'شرائح الرحلة (+ الزيادة عن شريحة الوصول)', type: 'tiers', default: DEFAULT_TIERS },
  { key: 'per_extra_stop', label: 'سعر كل محطة إضافية', default: 7, unit: 'ج.م' },
  { key: 'min_fare', label: 'الحد الأدنى للسعر', default: 25, unit: 'ج.م' },
  { key: 'rounding_step', label: 'التقريب لأعلى لأقرب', default: 1, unit: 'ج.م' },
];

const cloneTiers = (tiers) => tiers.map(({ up_to_km, price_per_km }) => ({ up_to_km, price_per_km }));

export function defaultParams() {
  return Object.fromEntries(PARAMS.map((param) => [
    param.key,
    param.type === 'tiers' ? cloneTiers(param.default) : param.default,
  ]));
}

export function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return 'لازم شريحة واحدة على الأقل.';
  }
  let previous = 0;
  for (const [index, tier] of tiers.entries()) {
    const limit = Number(tier?.up_to_km);
    const price = Number(tier?.price_per_km);
    if (!Number.isFinite(limit) || !Number.isFinite(price) || limit <= 0 || price <= 0) {
      return `الشريحة ${index + 1}: كل القيم لازم تكون أرقام أكبر من صفر.`;
    }
    if (limit <= previous) {
      return `الشريحة ${index + 1}: الحد (${limit} كم) لازم يكون أكبر من الشريحة اللي قبلها (${previous} كم).`;
    }
    previous = limit;
  }
  return null;
}

export function normalizeParams(input) {
  const params = defaultParams();
  if (!input || typeof input !== 'object') {
    return params;
  }
  for (const param of PARAMS) {
    if (!(param.key in input)) {
      continue;
    }
    if (param.type === 'tiers') {
      if (validateTiers(input[param.key]) === null) {
        params[param.key] = input[param.key].map((tier) => ({
          up_to_km: Number(tier.up_to_km),
          price_per_km: Number(tier.price_per_km),
        }));
      }
      continue;
    }
    const value = Number(input[param.key]);
    if (input[param.key] !== '' && Number.isFinite(value)) {
      params[param.key] = value;
    }
  }
  return params;
}

const round2 = (value) => Math.round(value * 100) / 100;
const show = (value) => String(round2(value));

export function distanceTierLines(distanceKm, inputParams) {
  const p = normalizeParams(inputParams);
  const tiers = p.distance_tiers;
  const maxKm = tiers[tiers.length - 1].up_to_km;
  if (round2(distanceKm) > maxKm) {
    return { overLimit: true, maxKm, lines: [], total: null };
  }

  const lines = [];
  let previousLimit = 0;
  for (const [index, tier] of tiers.entries()) {
    const from = Math.max(previousLimit, p.included_km);
    const to = Math.min(tier.up_to_km, distanceKm);
    if (to > from) {
      const km = to - from;
      lines.push({
        tier: index + 1,
        from,
        to,
        km,
        pricePerKm: tier.price_per_km,
        amount: round2(km * tier.price_per_km),
      });
    }
    previousLimit = tier.up_to_km;
  }
  return {
    overLimit: false,
    maxKm,
    lines,
    total: round2(lines.reduce((sum, line) => sum + line.amount, 0)),
  };
}

export function calculatePrice(summary, inputParams) {
  const p = normalizeParams(inputParams);

  const approachKm = summary.approach.distance / 1000;
  const tripKm = summary.trip.distance / 1000;
  const totalKm = approachKm + tripKm;
  const extraStops = Math.max(0, summary.stopsCount - 1 - (summary.hasDelivery === false ? 1 : 0));
  const approachTierKm = Math.min(approachKm, Math.max(0, p.approach_tier_km));
  const approachExtraKm = approachKm - approachTierKm;
  const tieredKm = tripKm + approachExtraKm;
  const inputs = { approachKm, tripKm, totalKm, extraStops, approachTierKm, approachExtraKm, tieredKm };

  const warnings = [];

  const maxKm = p.distance_tiers[p.distance_tiers.length - 1].up_to_km;
  if (round2(totalKm) > maxKm) {
    return {
      inputs,
      overLimit: true,
      overLimitMessage: `المسافة الكلية ${show(totalKm)} كم (وصول ${show(approachKm)} + رحلة ${show(tripKm)}) أكبر من آخر شريحة (${maxKm} كم).`,
      components: [],
      raw: null,
      minFare: p.min_fare,
      afterMinFare: null,
      roundingStep: p.rounding_step > 0 ? p.rounding_step : 0,
      final: null,
      warnings,
    };
  }

  const distance = distanceTierLines(tieredKm, p);
  const components = [
    { key: 'base_fee', label: 'رسوم فتح الطلب', amount: p.base_fee, detail: '' },
    ...(approachTierKm > 0
      ? [{
        key: 'approach_tier',
        label: `الوصول (أول ${show(p.approach_tier_km)} كم بسعر الوصول)`,
        amount: approachTierKm * p.approach_price_per_km,
        detail: `${show(approachTierKm)} كم × ${p.approach_price_per_km} = ${show(approachTierKm * p.approach_price_per_km)}`,
      }]
      : []),
    ...(p.included_km > 0
      ? [{ key: 'included_km', label: `أول ${show(p.included_km)} كم من الرحلة`, amount: 0, detail: '', amountText: 'ضمن الأساسي' }]
      : []),
    ...distance.lines.map((line, index) => ({
      key: `distance_tier_${index + 1}`,
      label: `شريحة ${line.tier}: من ${show(line.from)} إلى ${show(line.to)} كم`,
      amount: line.amount,
      detail: `${show(line.km)} كم × ${line.pricePerKm} = ${show(line.amount)}`,
    })),
    {
      key: 'stop_fee',
      label: 'رسوم المحطات الإضافية',
      amount: p.per_extra_stop * extraStops,
      detail: `${extraStops} × ${p.per_extra_stop}`,
    },
  ].map((component) => ({ ...component, amount: round2(component.amount) }));

  const raw = round2(components.reduce((sum, component) => sum + component.amount, 0));
  const afterMinFare = round2(Math.max(p.min_fare, raw));
  const step = p.rounding_step > 0 ? p.rounding_step : 0;
  const final = step
    ? round2(Math.ceil(Math.round((afterMinFare / step) * 1e6) / 1e6) * step)
    : afterMinFare;

  return {
    inputs,
    overLimit: false,
    components,
    raw,
    minFare: p.min_fare,
    afterMinFare,
    roundingStep: step,
    final,
    warnings,
  };
}
