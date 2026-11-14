const TZ = 'America/Los_Angeles';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', day: 'numeric' });
const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const whenFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const fmtClock = (t: number) => `${clockFormat.format(t)} PT`;
export const fmtDay = (t: number) => dayFormat.format(t);
export const fmtWeekday = (t: number) => weekdayFormat.format(t);
export const fmtDate = (t: number) => dateFormat.format(t);
export const fmtWhen = (t: number) => whenFormat.format(t);

export function fmtDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const fmtPct = (x: number) => `${Math.round(x * 100)}%`;

const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const moneyFormats = new Map<string, Intl.NumberFormat>();

export const fmtCompact = (n: number) => compactFormat.format(n);

export function fmtMoney(value: number, currency: string) {
  if (!moneyFormats.has(currency)) {
    let format: Intl.NumberFormat;
    try {
      format = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
    } catch {
      format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    }
    moneyFormats.set(currency, format);
  }
  return moneyFormats.get(currency)!.format(Math.round(value));
}

const compactMoneyFormats = new Map<string, Intl.NumberFormat>();

export function fmtMoneyCompact(value: number, currency: string) {
  if (!compactMoneyFormats.has(currency)) {
    let format: Intl.NumberFormat;
    try {
      format = new Intl.NumberFormat('en-US', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
    } catch {
      format = compactFormat;
    }
    compactMoneyFormats.set(currency, format);
  }
  return compactMoneyFormats.get(currency)!.format(Math.abs(value) < 1000 ? Math.round(value) : value);
}

const costFormats = new Map<string, Intl.NumberFormat>();

export function fmtCost(value: number, currency: string) {
  return Math.abs(value) >= 100 ? fmtMoney(value, currency) : fmtExact(value, currency);
}

export function fmtExact(value: number, currency: string) {
  if (!costFormats.has(currency)) {
    let format: Intl.NumberFormat;
    try {
      format = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    costFormats.set(currency, format);
  }
  return costFormats.get(currency)!.format(value);
}

export function fmtCostPer(
  spend: Record<string, number>,
  conversions: Record<string, number>,
  target: number | null,
) {
  const currencies = Object.keys(spend)
    .filter((currency) => conversions[currency] > 0)
    .sort((a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)));
  if (!currencies.length) return '';
  const costs = currencies.map((currency) => fmtCost(spend[currency] / conversions[currency], currency));
  if (target !== null) costs[0] += ` / ${fmtCost(target, currencies[0])}`;
  return costs.join(' · ');
}

export function costLabel(metric: string) {
  const words = metric.replace(/_/g, ' ').trim().replace(/s$/, '');
  return `Cost per ${words.split(' ').map((w) => (/^[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')}`;
}

export function esc(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function sincePacificMidnight(t: number) {
  const parts = Object.fromEntries(partsFormat.formatToParts(t).map((p) => [p.type, Number(p.value)]));
  return parts.hour * HOUR + parts.minute * 60_000 + parts.second * 1000 + (((t % 1000) + 1000) % 1000);
}

export const pacificHour = (t: number) => sincePacificMidnight(t) / HOUR;

function snapToMidnight(t: number) {
  const elapsed = sincePacificMidnight(t);
  if (elapsed === 0) return t;
  return elapsed < DAY / 2 ? t - elapsed : t + (DAY - elapsed);
}

export function pacificMidnights(start: number, end: number) {
  const out: number[] = [];
  let t = snapToMidnight(start - sincePacificMidnight(start));
  while (t < end) {
    if (t > start) out.push(t);
    t = snapToMidnight(t + DAY);
  }
  return out;
}
