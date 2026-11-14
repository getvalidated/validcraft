import fs from 'node:fs';
import path from 'node:path';
import {
  CARRIED_STATS,
  RECRUIT_REGION,
  SCHEMA_VERSION,
  WILD_REGION,
  type Building,
  type Feature,
  type Group,
  type Region,
  type Replay,
  type ReplayEvent,
  type ReplayRef,
  type ResourceType,
  type SourceName,
  type Unit,
  type WeekClosing,
} from '../../src/schema';
import { createCounters } from '../../src/sim/counters';
import { toTotals } from '../../src/sim/opening';

export const BIN_MS = 10 * 60_000;

interface Seen<T> {
  item: T;
  first: number;
  last: number;
  since?: number;
}

const union = <T>(older: T[] | undefined, newer: T[] | undefined, key: (x: T) => string, t: (x: T) => number) => {
  const out = new Map<string, T>();
  for (const x of [...(older ?? []), ...(newer ?? [])]) if (!out.has(key(x))) out.set(key(x), x);
  return [...out.values()].sort((a, b) => t(a) - t(b));
};

function binsOf(replay: Replay) {
  const { start, end } = replay.window;
  const bins = new Array<number>(Math.max(1, Math.ceil((end - start) / BIN_MS))).fill(0);
  for (const e of replay.events) {
    if (e.kind === 'run' || e.kind === 'error') continue;
    const b = Math.floor((e.t - start) / BIN_MS);
    if (b >= 0 && b < bins.length) bins[b]++;
  }
  return bins;
}

function closingOf(replay: Replay): WeekClosing {
  const closing: Required<WeekClosing> = { bills: {}, features: {}, created: {}, people: {} };
  const feature = (id: string) => (closing.features[id] ??= [0, 0]);
  for (const e of replay.events) {
    if (e.building && e.amount !== undefined) {
      const bill = (closing.bills[e.building] ??= { source: e.source, sums: {} });
      const currency = e.currency ?? '';
      bill.sums[currency] = (bill.sums[currency] ?? 0) + e.amount;
    }
    if (e.feature) feature(e.feature)[e.kind === 'error' ? 1 : 0] += e.count;
    if (e.kind === 'create' && e.building) {
      const made = (closing.created[e.building] ??= {});
      const type = e.resource ?? 'other';
      made[type] = (made[type] ?? 0) + e.count;
    }
  }
  for (const s of replay.sessions) feature(`claude/${s.tool}`)[0]++;
  for (const p of replay.weekly?.people ?? []) {
    const row = CARRIED_STATS.map((key) => p[key]);
    if (row.some(Boolean)) closing.people[p.id] = row;
  }
  return closing;
}

export function writeLibrary(dir: string) {
  const indexFile = path.join(dir, 'index.json');
  const listed: ReplayRef[] = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  const refs = listed.filter((ref) => fs.existsSync(path.join(dir, `${ref.id}.json`))).sort((a, b) => a.start - b.start);
  const n = refs.length;
  if (!n) return null;
  const units = new Map<string, Seen<Unit>>();
  const regions = new Map<string, Seen<Region>>();
  const groups = new Map<string, Group>();
  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const sources = new Set<SourceName>();
  const weight = new Map<string, number>();
  const tally = new Map<string, Map<ResourceType, number>>();
  const index: ReplayRef[] = new Array(n);
  const seen = <T>(map: Map<string, Seen<T>>, id: string, item: T, k: number, since: number | undefined) => {
    const kept = map.get(id);
    if (!kept) map.set(id, { item, first: k, last: k, since });
    else {
      kept.first = k;
      kept.since = since;
    }
    return kept;
  };

  for (let k = n - 1; k >= 0; k--) {
    const replay: Replay = JSON.parse(fs.readFileSync(path.join(dir, `${refs[k].id}.json`), 'utf8'));
    for (const name of replay.sources) sources.add(name);
    for (const g of replay.groups) if (!groups.has(g.id)) groups.set(g.id, g);
    for (const f of replay.features ?? []) if (!features.has(f.id)) features.set(f.id, f);
    for (const b of replay.buildings) {
      const kept = buildings.get(b.id);
      if (!kept) buildings.set(b.id, b);
      else if (!kept.resource && b.resource) buildings.set(b.id, { ...kept, resource: b.resource });
    }
    for (const r of replay.regions) seen(regions, r.id, { ...r }, k, r.since);
    for (const u of replay.units) {
      const kept = seen(units, u.id, { ...u }, k, u.since);
      if (!kept) continue;
      const w = kept.item;
      if (u.stages) w.stages = union(u.stages, w.stages, ([t, v]) => `${t}|${v}`, ([t]) => t);
      if (u.visits) w.visits = union(u.visits, w.visits, ([t, by]) => `${t}|${by}`, ([t]) => t);
      if (u.calls) w.calls = [...new Set([...u.calls, ...(w.calls ?? [])])];
      if (w.into === undefined && u.into !== undefined) w.into = u.into;
      if (w.role === undefined && u.role !== undefined) w.role = u.role;
    }
    for (const e of replay.events) {
      if (e.kind === 'send') for (const id of [e.from, e.to]) if (id) weight.set(id, (weight.get(id) ?? 0) + 1);
      if (!e.resource) continue;
      if (!tally.has(e.actor)) tally.set(e.actor, new Map());
      const own = tally.get(e.actor)!;
      own.set(e.resource, (own.get(e.resource) ?? 0) + e.count);
    }

    const peopled = new Set([...units.values()].map((s) => s.item.region));
    const placed = new Set(
      [...regions.values()]
        .map((s) => s.item)
        .filter((r) => (r.kind === 'unmapped' ? r.id !== WILD_REGION && peopled.has(r.id) : r.kind !== 'recruiting' || r.id === RECRUIT_REGION))
        .map((r) => r.id),
    );
    const home = [...regions.values()].find((s) => s.item.kind === 'internal')?.item.id ?? null;
    const unitRegion = (id: string | null) => {
      const region = id ? units.get(id)?.item.region : undefined;
      return region && (placed.has(region) || region === WILD_REGION) ? region : null;
    };
    const place = (region: string | null, unit: string | null) => (region && placed.has(region) ? region : null) ?? unitRegion(unit) ?? home;
    const counters = createCounters(
      replay,
      replay.sessions.filter((s) => units.has(s.owner)),
      place,
    )(replay.window.end);
    index[k] = {
      id: refs[k].id,
      start: replay.window.start,
      end: replay.window.end,
      binMs: BIN_MS,
      bins: binsOf(replay),
      totals: toTotals(
        counters,
        replay.artifacts.map((a) => ({ region: place(a.region, a.unit), kind: a.kind })),
      ),
      closing: closingOf(replay),
    };
  }

  const span = (s: Seen<{ since?: number }>) => s.since ?? (s.first > 0 ? refs[s.first].start : undefined);
  const worldUnits: Unit[] = [...units.values()].map((s) => {
    const { since: _since, until, ...rest } = s.item;
    const from = span(s);
    const to = until ?? (s.last < n - 1 ? refs[s.last].end : undefined);
    return { ...rest, ...(from !== undefined ? { since: from } : {}), ...(to !== undefined ? { until: to } : {}) };
  });
  const worldRegions: Region[] = [...regions.values()].map((s) => {
    const { since: _since, ...rest } = s.item;
    const from = span(s);
    return { ...rest, ...(from !== undefined ? { since: from } : {}) };
  });

  const start = refs[0].start;
  const synth = (kind: ReplayEvent['kind'], actor: string, resource: ResourceType | null, count: number): ReplayEvent => ({
    kind,
    t: start,
    source: 'linear',
    actor,
    via: null,
    resource,
    resourceId: null,
    building: null,
    from: kind === 'send' ? actor : null,
    to: null,
    isReturn: false,
    count,
    region: null,
  });
  const events: ReplayEvent[] = [];
  const members = new Map<string, Unit[]>();
  for (const u of worldUnits) {
    if (!members.has(u.region)) members.set(u.region, []);
    members.get(u.region)!.push(u);
  }
  for (const list of members.values()) {
    const levels = [...new Set(list.map((u) => weight.get(u.id) ?? 0))].sort((a, b) => a - b);
    for (const u of list) for (let rank = levels.indexOf(weight.get(u.id) ?? 0); rank > 0; rank--) events.push(synth('send', u.id, null, 1));
  }
  const known = new Set(worldUnits.map((u) => u.id));
  for (const [actor, own] of tally) if (known.has(actor)) for (const [resource, count] of own) events.push(synth('edit', actor, resource, count));

  const world: Replay = {
    schemaVersion: SCHEMA_VERSION,
    window: { start, end: refs[n - 1].end },
    sources: [...sources],
    regions: worldRegions,
    groups: [...groups.values()],
    buildings: [...buildings.values()],
    features: [...features.values()],
    units: worldUnits,
    sessions: [],
    initial: [],
    events,
    measures: [],
    artifacts: [],
    weekly: null,
    unmapped: { actors: 0, clientHints: 0 },
  };
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));
  fs.writeFileSync(indexFile, `[\n${index.map((ref) => JSON.stringify(ref)).join(',\n')}\n]\n`);
  return { weeks: n, units: worldUnits.length, regions: worldRegions.length, buildings: buildings.size, features: features.size, events: events.length };
}
