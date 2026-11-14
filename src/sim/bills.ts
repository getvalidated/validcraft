import type { Replay, ReplayEvent, SourceName, WeekClosing } from '../schema';
import { upperBound } from './search';

export type Money = Record<string, number>;

interface Ledger {
  source: SourceName;
  times: number[];
  sums: Money[];
  bills: ReplayEvent[];
}

const cache = new WeakMap<Replay, Map<string, Ledger>>();

function ledgers(replay: Replay) {
  const cached = cache.get(replay);
  if (cached) return cached;
  const out = new Map<string, Ledger>();
  for (const e of replay.events.filter((e) => e.building && e.amount !== undefined).sort((a, b) => a.t - b.t)) {
    let ledger = out.get(e.building!);
    if (!ledger) out.set(e.building!, (ledger = { source: e.source, times: [], sums: [], bills: [] }));
    const last = ledger.sums[ledger.sums.length - 1] ?? {};
    const currency = e.currency ?? '';
    ledger.times.push(e.t);
    ledger.sums.push({ ...last, [currency]: (last[currency] ?? 0) + e.amount! });
    ledger.bills.push(e);
  }
  cache.set(replay, out);
  return out;
}

export const addMoney = (into: Money, currency: string, value: number) => {
  into[currency] = (into[currency] ?? 0) + value;
  return into;
};

export function billsOf(replay: Replay, opening: NonNullable<WeekClosing['bills']> = {}) {
  const all = ledgers(replay);
  const plus = (building: string, now: Money): Money => {
    const before = opening[building]?.sums;
    if (!before) return now;
    const out = { ...before };
    for (const currency in now) out[currency] = (out[currency] ?? 0) + now[currency];
    return out;
  };
  const upTo = (ledger: Ledger | undefined, t: number) => (ledger ? upperBound(ledger.times, t) : 0);
  return {
    has: (building: string) => all.has(building) || !!opening[building],
    income: (building: string) => building === 'client-billing',
    source: (building: string) => all.get(building)?.source ?? opening[building]?.source ?? null,
    total(building: string, t: number): Money {
      const ledger = all.get(building);
      const i = upTo(ledger, t);
      return plus(building, i ? ledger!.sums[i - 1] : ledger ? { [ledger.bills[0].currency ?? '']: 0 } : {});
    },
    landed(building: string, t: number): ReplayEvent[] {
      const ledger = all.get(building);
      return ledger ? ledger.bills.slice(0, upTo(ledger, t)) : [];
    },
  };
}
