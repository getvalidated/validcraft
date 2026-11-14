import type { RegionTotals, Replay, ResourceStatus, ResourceType, Session } from '../schema';
import type { CounterState } from '../seam';
import { RESOURCES, perResource } from './holdings';
import { plus } from './opening';
import { upperBound } from './search';

interface Span {
  start: number;
  end: number;
  value: number;
}

type Ramp = (t: number) => number;

function createRamp(spans: Span[], origin: number): Ramp {
  const marks: { t: number; rate: number; jump: number; open: number }[] = [];
  for (const { start, end, value } of spans) {
    if (end > start) {
      const from = Math.max(start, origin);
      if (end <= from) continue;
      const rate = value / (end - start);
      marks.push({ t: from - origin, rate, jump: 0, open: 1 }, { t: end - origin, rate: -rate, jump: 0, open: -1 });
    } else if (start > origin) {
      marks.push({ t: start - origin, rate: 0, jump: value, open: 0 });
    }
  }
  marks.sort((a, b) => a.t - b.t);

  const times = new Float64Array(marks.length);
  const bases = new Float64Array(marks.length);
  const slopes = new Float64Array(marks.length);
  let value = 0;
  let slope = 0;
  let open = 0;
  let last = 0;
  marks.forEach((mark, i) => {
    value += slope * (mark.t - last) + mark.jump;
    last = mark.t;
    open += mark.open;
    slope = open ? slope + mark.rate : 0;
    times[i] = mark.t;
    bases[i] = value;
    slopes[i] = slope;
  });

  return (t) => {
    const x = t - origin;
    const i = upperBound(times, x) - 1;
    return i < 0 ? 0 : bases[i] + slopes[i] * (x - times[i]);
  };
}

export function createCounters(
  replay: Replay,
  sessions: Session[],
  place: (region: string | null, unit: string | null) => string | null,
  opening: RegionTotals[] = [],
) {
  const origin = replay.window.start;
  const spans = new Map<
    string,
    { adSpend: Map<string, Span[]>; ownSpend: Map<string, Span[]>; feeRevenue: Map<string, Span[]>; clientRevenue: Map<string, Span[]>; conversions: Map<string, Span[]>; expenses: Map<string, Map<string, Span[]>>; usage: Map<string, Map<string, Span[]>>; tokens: Span[]; levels: Map<number, { base: number; times: number[]; sums: number[] }>; made: Map<number, { times: number[]; sums: number[] }> }
  >();
  const at = (region: string) => {
    let entry = spans.get(region);
    if (!entry) spans.set(region, (entry = { adSpend: new Map(), ownSpend: new Map(), feeRevenue: new Map(), clientRevenue: new Map(), conversions: new Map(), expenses: new Map(), usage: new Map(), tokens: [], levels: new Map(), made: new Map() }));
    return entry;
  };
  const level = (region: string, resource: ResourceType, status: ResourceStatus) => {
    const levels = at(region).levels;
    const cell = RESOURCES.indexOf(resource) * 2 + (status === 'active' ? 0 : 1);
    let entry = levels.get(cell);
    if (!entry) levels.set(cell, (entry = { base: 0, times: [], sums: [] }));
    return entry;
  };
  const shift = (entry: { times: number[]; sums: number[] }, t: number, delta: number) => {
    entry.times.push(t);
    entry.sums.push((entry.sums.length ? entry.sums[entry.sums.length - 1] : 0) + delta);
  };

  for (const s of replay.stock ?? []) {
    const region = place(s.region, null);
    if (region) level(region, s.resource, s.status).base += s.count;
  }
  for (const e of [...replay.events].sort((a, b) => a.t - b.t)) {
    if (!e.resource || (e.kind !== 'create' && e.kind !== 'status')) continue;
    const region = place(e.region, e.actor);
    if (!region) continue;
    if (e.kind === 'create') {
      const made = at(region).made;
      const type = RESOURCES.indexOf(e.resource);
      if (!made.has(type)) made.set(type, { times: [], sums: [] });
      shift(made.get(type)!, e.t, e.count);
    }
    if (!e.status) continue;
    shift(level(region, e.resource, e.status), e.t, e.count);
    if (e.kind === 'status') shift(level(region, e.resource, e.status === 'active' ? 'inactive' : 'active'), e.t, -e.count);
  }

  for (const m of replay.measures) {
    const region = place(m.region, m.unit);
    if (!region) continue;
    const span = { start: m.start, end: m.end, value: m.value };
    if (m.name === 'tokens') {
      at(region).tokens.push(span);
      continue;
    }
    const currency = m.currency ?? '';
    if (m.name === 'expense' && m.paidBy) {
      const usage = at(region).usage;
      const label = m.label ?? m.paidBy;
      if (!usage.has(label)) usage.set(label, new Map());
      const book = usage.get(label)!;
      if (!book.has(currency)) book.set(currency, []);
      book.get(currency)!.push(span);
      continue;
    }
    let money = m.name === 'ad_spend' ? at(region).adSpend : m.name === 'own_spend' ? at(region).ownSpend : m.name === 'conversions' ? at(region).conversions : m.name === 'client_revenue' ? at(region).clientRevenue : at(region).feeRevenue;
    if (m.name === 'expense') {
      const label = m.label ?? 'Other';
      if (!at(region).expenses.has(label)) at(region).expenses.set(label, new Map());
      money = at(region).expenses.get(label)!;
    }
    if (!money.has(currency)) money.set(currency, []);
    money.get(currency)!.push(span);
  }

  for (const s of sessions) {
    if (!s.tokens) continue;
    const region = place(null, s.owner);
    if (!region) continue;
    const total = s.active.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
    if (total <= 0) {
      at(region).tokens.push({ start: s.start, end: s.end, value: s.tokens });
      continue;
    }
    for (const [from, to] of s.active) {
      if (to > from) at(region).tokens.push({ start: from, end: to, value: (s.tokens * (to - from)) / total });
    }
  }

  for (const o of opening) at(o.region);
  const goals = new Map<string, { metric: string; target: number | null }>();
  for (const g of replay.goals ?? []) {
    const region = place(g.region, null);
    if (region && !goals.has(region)) goals.set(region, { metric: g.metric, target: g.target });
  }

  const ramps = [...spans].map(([region, entry]) => ({
    region,
    adSpend: [...entry.adSpend].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })),
    ownSpend: [...entry.ownSpend].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })),
    feeRevenue: [...entry.feeRevenue].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })),
    clientRevenue: [...entry.clientRevenue].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })),
    conversions: [...entry.conversions].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })),
    expenses: [...entry.expenses].map(([label, money]) => ({ label, series: [...money].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })) })),
    usage: [...entry.usage].map(([label, money]) => ({ label, series: [...money].map(([currency, list]) => ({ currency, ramp: createRamp(list, origin) })) })),
    goal: goals.get(region) ?? null,
    tokens: createRamp(entry.tokens, origin),
    levels: [...entry.levels],
    made: [...entry.made],
  }));
  const counts = new Array<number>(RESOURCES.length * 2);
  const made = new Array<number>(RESOURCES.length);

  const totals = (series: { currency: string; ramp: Ramp }[], t: number) => {
    const out: Record<string, number> = {};
    for (const { currency, ramp } of series) {
      const value = ramp(t);
      if (value !== 0) out[currency] = value;
    }
    return out;
  };

  const now = (t: number): CounterState[] =>
    ramps.map((r) => {
      counts.fill(0);
      for (const [cell, entry] of r.levels) {
        const i = upperBound(entry.times, t);
        counts[cell] = Math.max(0, entry.base + (i ? entry.sums[i - 1] : 0));
      }
      made.fill(0);
      for (const [type, entry] of r.made) {
        const i = upperBound(entry.times, t);
        made[type] = i ? entry.sums[i - 1] : 0;
      }
      return {
        region: r.region,
        adSpend: totals(r.adSpend, t),
        ownSpend: totals(r.ownSpend, t),
        feeRevenue: totals(r.feeRevenue, t),
        clientRevenue: totals(r.clientRevenue, t),
        conversions: totals(r.conversions, t),
        expenses: Object.fromEntries(r.expenses.map(({ label, series }) => [label, totals(series, t)])),
        usage: Object.fromEntries(r.usage.map(({ label, series }) => [label, totals(series, t)])),
        goal: r.goal,
        tokens: r.tokens(t),
        active: perResource(counts.filter((_, i) => i % 2 === 0)),
        inactive: perResource(counts.filter((_, i) => i % 2 === 1)),
        made: perResource(made),
      };
    });
  const open = new Map(opening.map((o) => [o.region, o]));
  return (t: number) => (open.size ? now(t).map((c) => plus(c, open.get(c.region))) : now(t));
}
