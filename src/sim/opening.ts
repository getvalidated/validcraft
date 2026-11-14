import type { ArtifactKind, RegionTotals, ResourceType } from '../schema';
import type { CounterState, TrophyState } from '../seam';

type Money = Record<string, number>;

const add = (a: Money, b: Money | undefined) => {
  if (!b) return a;
  const out = { ...a };
  for (const key in b) out[key] = (out[key] ?? 0) + b[key];
  return out;
};

const addAll = (a: Record<string, Money> | undefined, b: Record<string, Money> | undefined) => {
  const out = { ...a };
  for (const label in b ?? {}) out[label] = add(out[label] ?? {}, b![label]);
  return out;
};

const keptAll = (books: Record<string, Money> | undefined) => {
  const out: Record<string, Money> = {};
  for (const label in books ?? {}) {
    const m = kept(books![label]);
    if (m) out[label] = m;
  }
  return Object.keys(out).length ? out : undefined;
};

function kept(m: Money, k = 100) {
  const out: Money = {};
  for (const key in m) {
    const v = Math.round(m[key] * k) / k;
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function plus(c: CounterState, o: RegionTotals | undefined): CounterState {
  if (!o) return c;
  const expenses = addAll(c.expenses, o.expenses);
  const made = { ...c.made };
  for (const type in o.made ?? {}) made[type as ResourceType] += o.made![type as ResourceType]!;
  return {
    ...c,
    adSpend: add(c.adSpend, o.adSpend),
    ownSpend: add(c.ownSpend, o.ownSpend),
    feeRevenue: add(c.feeRevenue, o.feeRevenue),
    clientRevenue: add(c.clientRevenue, o.clientRevenue),
    conversions: add(c.conversions, o.conversions),
    expenses,
    ...(c.usage || o.usage ? { usage: addAll(c.usage, o.usage) } : {}),
    tokens: c.tokens + (o.tokens ?? 0),
    made,
  };
}

export function sumTotals(weeks: RegionTotals[][]): RegionTotals[] {
  const out = new Map<string, RegionTotals>();
  for (const week of weeks) {
    for (const o of week) {
      const r = out.get(o.region) ?? { region: o.region };
      const expenses = addAll(r.expenses, o.expenses);
      const usage = addAll(r.usage, o.usage);
      const made = { ...r.made };
      for (const type in o.made ?? {}) made[type as ResourceType] = (made[type as ResourceType] ?? 0) + o.made![type as ResourceType]!;
      out.set(o.region, {
        region: o.region,
        adSpend: add(r.adSpend ?? {}, o.adSpend),
        ownSpend: add(r.ownSpend ?? {}, o.ownSpend),
        feeRevenue: add(r.feeRevenue ?? {}, o.feeRevenue),
        clientRevenue: add(r.clientRevenue ?? {}, o.clientRevenue),
        conversions: add(r.conversions ?? {}, o.conversions),
        expenses,
        ...(Object.keys(usage).length ? { usage } : {}),
        tokens: (r.tokens ?? 0) + (o.tokens ?? 0),
        made,
        wins: (r.wins ?? 0) + (o.wins ?? 0),
        launches: (r.launches ?? 0) + (o.launches ?? 0),
        clientWins: (r.clientWins ?? 0) + (o.clientWins ?? 0),
      });
    }
  }
  return [...out.values()];
}

export function toTotals(counters: CounterState[], trophies: { region: string | null; kind: ArtifactKind }[]): RegionTotals[] {
  const out = new Map<string, RegionTotals>();
  for (const c of counters) {
    const made: Partial<Record<ResourceType, number>> = {};
    for (const type in c.made) if (c.made[type as ResourceType]) made[type as ResourceType] = c.made[type as ResourceType];
    const tokens = Math.round(c.tokens);
    const entry: RegionTotals = { region: c.region };
    const set = <K extends keyof RegionTotals>(key: K, value: RegionTotals[K] | undefined) => {
      if (value !== undefined) entry[key] = value;
    };
    set('adSpend', kept(c.adSpend));
    set('ownSpend', kept(c.ownSpend));
    set('feeRevenue', kept(c.feeRevenue));
    set('clientRevenue', kept(c.clientRevenue));
    set('conversions', kept(c.conversions));
    set('expenses', keptAll(c.expenses));
    set('usage', keptAll(c.usage));
    set('tokens', tokens || undefined);
    set('made', Object.keys(made).length ? made : undefined);
    out.set(c.region, entry);
  }
  for (const t of trophies) {
    if (!t.region) continue;
    const entry = out.get(t.region) ?? { region: t.region };
    if (t.kind === 'winning_ad') entry.wins = (entry.wins ?? 0) + 1;
    else if (t.kind === 'client_winner') entry.clientWins = (entry.clientWins ?? 0) + 1;
    else entry.launches = (entry.launches ?? 0) + 1;
    out.set(t.region, entry);
  }
  return [...out.values()].filter((o) => Object.keys(o).length > 1);
}

export function openingTrophies(opening: RegionTotals[]): TrophyState[] {
  return opening.flatMap((o) =>
    (
      [
        ['winning_ad', o.wins],
        ['creative', o.launches],
        ['client_winner', o.clientWins],
      ] as [ArtifactKind, number | undefined][]
    )
      .filter(([, count]) => !!count)
      .map(([kind, count]) => ({ id: `opening:${o.region}:${kind}`, kind, name: '', region: o.region, unit: null, ageMs: Infinity, count })),
  );
}
