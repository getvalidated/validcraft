import type Phaser from 'phaser';
import { fmtDuration } from './format';
import { COLORS, RESOURCE_LABELS, STAGE_COLORS, TYPE_COLOR, hex, mix } from './palette';
import type { ResourceType, Trace, TraceNode, TraceStep } from './schema';
import type { Layout, Point, Rect, SimState } from './seam';
import { resourcePath, starPath } from './shapes';

type Graphics = Phaser.GameObjects.Graphics;

const DAY = 86_400_000;
const MINUTE = 60_000;
const GREY_FROM = DAY;
const IDLE = 5 * DAY;
const WITHER = 3 * DAY;
const CARRY = 2;
const RISE = 1.5;
const BACK = 1.5;
const LIFT = 0.2;
const PITCH = 14;
const DESK_COLS = 3;
const DESK_H = 44;
const PLOT_MAX = 15;
const PLOT_MIN = 3.5;
const GRID = 14;
const TRAIL_MS = 200;
const FADE = 4 * 60 * MINUTE;
const SHADES = 6;
const MERGE = 4 * MINUTE;
const BLEND_CAP = 24;
const LINGER = 5;
const MOVING = new Set(['create', 'send', 'assign', 'done', 'edit', 'status', 'bulk']);
const KEEPERS = new Set(['person', 'client', 'ambassador']);
const MEDIA = new Set(['video', 'image']);
const CARRIED = new Set<ResourceType>(['ticket', 'page', 'board', 'video', 'image', 'taxonomy', 'row', 'ad']);
const BG = hex(COLORS.bg);
const GREY = hex(COLORS.away);
const TRACE = hex(COLORS.trace);
const TROPHY = hex(COLORS.trophy);
const THEIRS = hex(STAGE_COLORS.client_winner);
const WHITE = 0xffffff;
const SOIL = 0x3a2a1c;
const FURROW = 0x5a4330;
const CROP = 0x6fcf73;
const SLIME = 0x7fe0c2;
const CONCEPT = hex(STAGE_COLORS.concept);
const CREATIVE = hex(STAGE_COLORS.asset);
const BRIEF = hex(STAGE_COLORS.brief);
const KINDS = 3;
const PARTS: ResourceType[][] = [['ticket', 'board'], ['video', 'image', 'taxonomy', 'row', 'ad'], ['page'], ['client_winner']];
const LEAD: ResourceType[] = ['ticket', 'video', 'page', 'client_winner'];
const CLIENT = 3;
const EDGE = [CONCEPT, CREATIVE, BRIEF];
const SHELVES = ['concept', 'creative', 'brief'] as const;
const PILE_X = [-30, 12, -9];

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const smooth = (v: number) => v * v * (3 - 2 * v);
const typeOf = (key: string) => key.slice(0, key.indexOf(':'));
const offSince = (thing: Thing, t: number) => {
  let at = thing.planted;
  for (let n = 0; n < thing.live!.length && thing.live![n] <= t; n += 2) {
    if (thing.live![n + 1] > t) return Infinity;
    at = thing.live![n + 1];
  }
  for (let n = 1; n < thing.won.length; n += 2) if (thing.won[n] <= t) at = Math.max(at, thing.won[n]);
  return at;
};
const winning = (thing: Thing, t: number) => {
  for (let n = 0; n < thing.won.length; n += 2) if (t >= thing.won[n] && t < thing.won[n + 1]) return true;
  return false;
};
const pop = (v: number) => (v >= 1 ? 1 : v <= 0 ? 0 : 1 + 0.35 * Math.sin(v * Math.PI) * (1 - v) - (1 - v) * (1 - v));

function upper(times: ArrayLike<number>, t: number) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lower(times: ArrayLike<number>, t: number) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Move {
  t: number;
  place: number;
  by: number;
  ax: number;
  ay: number;
  bx: number;
  by2: number;
  stored: boolean;
  jump: boolean;
  whole: boolean;
}

interface Part {
  type: ResourceType;
  t: number;
  flown: boolean;
}

interface Thing {
  trace: number;
  key: string;
  creative: boolean;
  kind: number;
  name: string;
  region: number;
  moves: Move[];
  moveT: Float64Array;
  parts: Part[];
  acts: Float64Array;
  ads: Float64Array;
  won: number[];
  live: number[] | null;
  planted: number;
  plot: number;
}

interface Flyer {
  t: number;
  type: ResourceType;
  thing: number;
  by: number;
  ax: number;
  ay: number;
}

interface Hauls {
  t: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
}

interface Road {
  cells: Int32Array;
  times: number[];
}

export type Shelf = 'concept' | 'creative' | 'brief' | 'retired';

export interface Cargo {
  walk(unit: number, time: number, life: number, out: Point): number;
  times(unit: number): number[];
  carried(resource: ResourceType): boolean;
  stored: number[];
  shelves: { n: Int32Array; x: Float64Array; y: Float64Array };
  shelf(id: string, which: Shelf): { id: string; key: string; name: string }[];
  shelfAt(p: Point): { kind: 'building' | 'region' | 'unit'; id: string; shelf: Shelf } | null;
  shelfType(n: number): ResourceType | null;
  idle(kind: number, t: number): { id: string; name: string; region: string | null; parts: ResourceType[]; ads: number; since: number }[];
  trail(g: Graphics, state: SimState, focus: string | null): void;
  draw(g: Graphics, state: SimState, ux: Float64Array, uy: Float64Array, ua: Float32Array, thin: number, focus: string | null, shown: Record<ResourceType, boolean>, seen: (rect: Rect) => boolean): void;
  at(p: Point): { id: string; items: 'ad' | 'winner' | null } | null;
  trailAt(p: Point, t: number): string | null;
  tip(p: Point, t: number, names: { regionName(id: string, name: string): string; redact(text: string, region: string | null): string }): string | null;
  where(trace: string, key: string, out: Point): number | null;
}

export function createCargo(traces: Trace[], layout: Layout): Cargo {
  const U = layout.units.length;
  const B = layout.buildings.length;
  const R = layout.regions.length;
  const FARM = U + B;
  const STORE = FARM + R;
  const radius = layout.unitRadius;
  const buildingAt = new Map(layout.buildings.map((b, i) => [b.id, i]));
  const regionAt = new Map(layout.regions.map((r, i) => [r.id, i]));
  const depots = new Map<string, number>();
  layout.buildings.forEach((b, i) => {
    if (b.resource && !depots.has(b.resource)) depots.set(b.resource, i);
  });
  const stores = layout.stores ? [layout.stores.concept, layout.stores.creative, layout.stores.brief] : null;
  const keeper = (u: number) => KEEPERS.has(layout.units[u].kind);
  const relay = (u: number) => layout.units[u].kind === 'automation';
  const unitOf = (id: string | null | undefined) => (id ? (layout.index.get(id) ?? -1) : -1);
  const madeIn = (key: string, step: TraceStep | undefined) => {
    const named = step?.building ? buildingAt.get(step.building) : undefined;
    if (named !== undefined) return named;
    const hinted = buildingAt.get(key.split(':')[1] ?? '');
    if (hinted !== undefined) return hinted;
    const type = typeOf(key);
    return depots.get(type) ?? (type === 'image' || type === 'board' ? depots.get('video') : undefined) ?? -1;
  };

  const things: Thing[] = [];
  const thingOf = new Map<string, number>();
  const flyers: Flyer[] = [];
  const drafts: { thing: number; moves: { t: number; place: number; by: number }[]; flights: { t: number; type: ResourceType; from: number; by: number }[]; acts: number[]; plant: { t: number; place: number; by: number; known: boolean } | null }[] = [];
  const courier = layout.regions.map((region) => {
    const local = layout.units.filter((u) => u.region === region.id);
    return (local.find((u) => u.kind === 'automation') ?? local.find((u) => u.kind === 'client'))?.index ?? -1;
  });
  const market = depots.get('ad');

  traces.forEach((trace, ti) => {
    const byKey = new Map(trace.nodes.map((n) => [n.key, n]));
    const made = new Map<string, TraceStep>();
    const stepsOf = new Map<string, TraceStep[]>();
    for (const s of trace.steps) {
      if (s.kind === 'create' && !made.has(s.key)) made.set(s.key, s);
      const list = stepsOf.get(s.key);
      if (list) list.push(s);
      else stepsOf.set(s.key, [s]);
    }
    const region = trace.region ? (regionAt.get(trace.region) ?? -1) : -1;
    const farm = region >= 0 && layout.regions[region].farm ? FARM + region : -1;
    if (typeOf(trace.id) === 'client_winner') {
      if (farm < 0) return;
      const won: number[] = [];
      let begun = -1;
      for (const s of stepsOf.get(trace.id) ?? []) {
        if (s.kind === 'done' && begun < 0) begun = s.t;
        else if (s.kind === 'status' && begun >= 0) {
          won.push(begun, s.t);
          begun = -1;
        }
      }
      if (begun >= 0) won.push(begun, Infinity);
      const t0 = won.length ? won[0] : trace.t;
      for (const node of trace.nodes) thingOf.set(`${trace.id}\n${node.key}`, things.length);
      drafts.push({ thing: things.length, moves: [{ t: t0, place: farm, by: -1 }], flights: [], acts: [t0, ...won.filter((t) => t < Infinity)], plant: null });
      things.push({ trace: ti, key: trace.id, creative: false, kind: CLIENT, name: trace.name, region, moves: [], moveT: new Float64Array(0), parts: [{ type: 'client_winner', t: t0, flown: false }], acts: new Float64Array(0), ads: new Float64Array(0), won, live: null, planted: t0, plot: -1 });
      return;
    }
    const isMedia = (n: TraceNode | undefined) => !!n && MEDIA.has(typeOf(n.key));
    const born = (node: TraceNode, fallback: number) => {
      const step = made.get(node.key);
      const by = unitOf(step?.actor);
      const b = madeIn(node.key, step);
      return { place: b >= 0 ? U + b : by >= 0 ? by : fallback, by };
    };
    const open = (kind: number, name: string, first: TraceNode, t0: number, fallback: number) => {
      const start = born(first, fallback);
      const draft = { thing: things.length, moves: [{ t: t0, place: start.place, by: -1 }], flights: [] as { t: number; type: ResourceType; from: number; by: number }[], acts: [t0], plant: null as { t: number; place: number; by: number; known: boolean } | null };
      if (start.by >= 0 && keeper(start.by) && start.place !== start.by) draft.moves.push({ t: t0, place: start.by, by: start.by });
      things.push({ trace: ti, key: first.key, creative: kind === 1, kind, name, region, moves: [], moveT: new Float64Array(0), parts: [{ type: typeOf(first.key) as ResourceType, t: t0, flown: false }], acts: new Float64Array(0), ads: new Float64Array(0), won: [], live: null, planted: Infinity, plot: -1 });
      drafts.push(draft);
      return draft;
    };
    const join = (draft: (typeof drafts)[number], node: TraceNode, type: ResourceType) => {
      const thing = things[draft.thing];
      const t = Math.max(node.t, draft.moves[0].t);
      draft.acts.push(t);
      const step = made.get(node.key);
      const b = madeIn(node.key, step);
      const flown = b >= 0;
      if (flown) draft.flights.push({ t, type, from: U + b, by: unitOf(step?.actor) });
      if (!thing.parts.some((p) => p.type === type)) thing.parts.push({ type, t, flown });
    };
    const follow = (draft: (typeof drafts)[number], keys: Iterable<string>, skip: Set<string>) => {
      for (const key of keys) {
        for (const s of stepsOf.get(key) ?? []) {
          draft.acts.push(s.t);
          if (!MOVING.has(s.kind) || (s.kind === 'create' && skip.has(key))) continue;
          const by = unitOf(s.actor);
          if (by >= 0 && keeper(by)) draft.moves.push({ t: s.t, place: by, by });
        }
      }
    };

    const root = byKey.get(trace.id) ?? { key: trace.id, parent: null, stage: 'concept' as const, t: trace.t, name: trace.name };
    const home = depots.get('ticket');
    const concept = open(0, trace.name, root, trace.t, home !== undefined ? U + home : unitOf(trace.hands[0]));
    const conceptKeys = [trace.id];
    const joined = new Set([trace.id]);
    for (const node of trace.nodes) {
      const type = typeOf(node.key);
      if (node.key === trace.id || (type !== 'board' && type !== 'ticket')) continue;
      conceptKeys.push(node.key);
      if (type === 'ticket') continue;
      joined.add(node.key);
      join(concept, node, type as ResourceType);
    }
    follow(concept, conceptKeys, joined);
    for (const key of conceptKeys) thingOf.set(`${trace.id}\n${key}`, concept.thing);
    const conceptPlace = concept.moves[0].place;
    for (const node of trace.nodes) {
      if (node.key === trace.id || typeOf(node.key) !== 'page') continue;
      const brief = open(2, node.name ?? trace.name, node, node.t, conceptPlace);
      follow(brief, [node.key], new Set([node.key]));
      thingOf.set(`${trace.id}\n${node.key}`, brief.thing);
    }

    interface Cut {
      media: TraceNode | null;
      tax: TraceNode | null;
      row: TraceNode | null;
      keys: string[];
      ads: TraceNode[];
      wins: number[];
    }
    const cuts: Cut[] = [];
    const cutOf = new Map<string, Cut>();
    const thingOfCut = new Map<Cut, number>();
    for (const node of trace.nodes) {
      if (!isMedia(node)) continue;
      if (isMedia(byKey.get(node.parent ?? ''))) continue;
      const cut: Cut = { media: node, tax: null, row: null, keys: [node.key], ads: [], wins: [] };
      cuts.push(cut);
      cutOf.set(node.key, cut);
    }
    for (const node of trace.nodes) {
      if (!isMedia(node) || cutOf.has(node.key)) continue;
      let up = byKey.get(node.parent ?? '');
      while (up && !cutOf.has(up.key)) up = byKey.get(up.parent ?? '');
      const cut = up ? cutOf.get(up.key) : undefined;
      if (!cut) continue;
      cut.keys.push(node.key);
      cutOf.set(node.key, cut);
    }
    for (const node of trace.nodes) {
      if (typeOf(node.key) !== 'taxonomy') continue;
      let cut: Cut | null = null;
      for (const c of cuts) if (c.media && !c.tax && c.media.t <= node.t + DAY && (!cut || c.media.t > cut.media!.t)) cut = c;
      if (!cut) cuts.push((cut = { media: null, tax: null, row: null, keys: [], ads: [], wins: [] }));
      cut.tax = node;
      cut.keys.push(node.key);
      cutOf.set(node.key, cut);
    }
    for (const node of trace.nodes) {
      if (typeOf(node.key) !== 'row') continue;
      let cut: Cut | null = cuts.find((c) => c.tax?.parent === node.key) ?? null;
      if (!cut) {
        let best = Infinity;
        for (const c of cuts) {
          if (c.row) continue;
          const d = Math.abs((c.tax ?? c.media)!.t - node.t) + (c.tax ? 0 : 30 * DAY);
          if (d < best) {
            best = d;
            cut = c;
          }
        }
      }
      if (!cut) cuts.push((cut = { media: null, tax: null, row: null, keys: [], ads: [], wins: [] }));
      cut.row = node;
      cut.keys.push(node.key);
      cutOf.set(node.key, cut);
    }
    for (const node of trace.nodes) {
      if (typeOf(node.key) !== 'ad') continue;
      const cut = cutOf.get(node.parent ?? '');
      if (!cut) continue;
      cut.ads.push(node);
      cutOf.set(node.key, cut);
    }
    for (const node of trace.nodes) {
      const type = typeOf(node.key);
      if (type !== 'winning_ad' && type !== 'creative') continue;
      const cut = cutOf.get(node.parent ?? '');
      if (!cut || type !== 'winning_ad') continue;
      let open = -1;
      for (const s of stepsOf.get(node.key) ?? []) {
        if (s.kind === 'done' && open < 0) open = s.t;
        else if (s.kind === 'status' && open >= 0) {
          cut.wins.push(open, s.t);
          open = -1;
        }
      }
      if (open >= 0) cut.wins.push(open, Infinity);
    }

    for (const cut of cuts) {
      const firsts = [cut.media, cut.tax, cut.row].filter((n): n is TraceNode => !!n).sort((a, b) => a.t - b.t);
      const first = firsts[0];
      const launch = cut.ads.length ? Math.min(...cut.ads.map((a) => a.t)) : Infinity;
      const t0 = Math.min(first.t, launch);
      const draft = open(1, cut.tax?.name ?? cut.media?.name ?? cut.tax?.key.slice(9) ?? trace.name, first, t0, conceptPlace);
      const thing = things[draft.thing];
      thingOfCut.set(cut, draft.thing);
      thing.key = (cut.media ?? first).key;
      const skip = new Set([first.key]);
      for (const node of firsts.slice(1)) {
        skip.add(node.key);
        join(draft, node, typeOf(node.key) as ResourceType);
      }
      follow(draft, cut.keys, skip);
      if (cut.ads.length) {
        const ads = [...cut.ads].sort((a, b) => a.t - b.t);
        thing.ads = Float64Array.from(ads, (a) => a.t);
        thing.parts.push({ type: 'ad', t: launch, flown: false });
        thing.won = cut.wins;
        const spans: [number, number][] = [];
        for (const ad of ads) for (let n = 0; ad.on && n < ad.on.length; n += 2) spans.push([ad.on[n], ad.on[n + 1] ?? Infinity]);
        if (ads.some((ad) => ad.on)) {
          thing.live = [];
          for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
            const end = thing.live.length - 1;
            if (end >= 0 && from <= thing.live[end]) thing.live[end] = Math.max(thing.live[end], to);
            else thing.live.push(from, to);
          }
        }
        for (const ad of ads) for (const s of stepsOf.get(ad.key) ?? []) draft.acts.push(s.t);
        for (const t of cut.wins) if (t < Infinity) draft.acts.push(t);
        for (const t of thing.ads) draft.acts.push(t);
        if (farm >= 0) {
          const hand = (ad: TraceNode) => {
            const by = unitOf(made.get(ad.key)?.actor);
            return by >= 0 ? by : courier[region];
          };
          draft.moves = draft.moves.filter((m) => m.t < launch || m === draft.moves[0]);
          draft.plant = { t: launch, place: farm, by: hand(ads[0]), known: unitOf(made.get(ads[0].key)?.actor) >= 0 };
          thing.planted = launch;
          if (market !== undefined) for (const ad of ads.slice(1)) draft.flights.push({ t: ad.t, type: 'ad', from: U + market, by: hand(ad) });
        }
      }
    }
    for (const node of trace.nodes) {
      if (thingOf.has(`${trace.id}\n${node.key}`)) continue;
      let up: TraceNode | undefined = node;
      for (let hops = 0; up && !cutOf.has(up.key) && hops < 20; hops++) up = byKey.get(up.parent ?? '');
      const i = up && thingOfCut.get(cutOf.get(up.key)!);
      if (i !== undefined) thingOf.set(`${trace.id}\n${node.key}`, i);
    }
  });

  const plotPitch = new Float64Array(R);
  const plotCols = new Int32Array(R);
  const planted: number[][] = layout.regions.map(() => []);
  things.forEach((thing, i) => {
    if (thing.planted < Infinity && thing.region >= 0) planted[thing.region].push(i);
  });
  planted.forEach((list, ri) => {
    const farm = layout.regions[ri].farm;
    if (!farm) return;
    list.sort((a, b) => things[a].planted - things[b].planted || a - b);
    list.forEach((i, k) => (things[i].plot = k));
    let pitch = PLOT_MAX;
    while (pitch > PLOT_MIN && Math.floor(farm.w / pitch) * Math.floor(farm.h / pitch) < list.length) pitch -= 0.25;
    plotPitch[ri] = pitch;
    plotCols[ri] = Math.max(1, Math.floor(farm.w / pitch));
  });
  const plantTimes = planted.map((list) => Float64Array.from(list, (i) => things[i].planted));

  const plotAt = (thing: Thing, out: Point) => {
    const farm = layout.regions[thing.region].farm!;
    const pitch = plotPitch[thing.region];
    const cols = plotCols[thing.region];
    const rows = Math.max(1, Math.floor(farm.h / pitch));
    out.x = farm.x + (farm.w - cols * pitch) / 2 + ((thing.plot % cols) + 0.5) * pitch;
    out.y = farm.y + ((Math.floor(thing.plot / cols) % rows) + 0.5) * pitch;
  };
  const deskSide = (u: number) => (layout.units[u].palace ? radius * 3.2 : radius) + 13;
  const anchor = (place: number, thing: Thing, out: Point) => {
    if (place < 0) {
      out.x = layout.bounds.x + layout.bounds.w / 2;
      out.y = layout.bounds.y + layout.bounds.h / 2;
    } else if (place < U) {
      out.x = layout.units[place].x - deskSide(place);
      out.y = layout.units[place].y - 14;
    } else if (place < FARM) {
      const rect = layout.buildings[place - U].rect;
      out.x = rect.x + rect.w / 2;
      out.y = rect.y + rect.h + 10;
    } else if (place < STORE) plotAt(thing, out);
    else {
      out.x = stores![place - STORE].x;
      out.y = stores![place - STORE].y;
    }
  };
  const slot = (place: number, rank: number, count: number, kind: number, out: Point) => {
    if (place < U) {
      const step = Math.min(PITCH, DESK_H / Math.ceil(count / DESK_COLS));
      out.x = layout.units[place].x - deskSide(place) - (rank % DESK_COLS) * PITCH;
      out.y = layout.units[place].y - 14 + Math.floor(rank / DESK_COLS) * step;
      return;
    }
    const rect = layout.buildings[place - U].rect;
    out.x = rect.x + rect.w / 2 + PILE_X[kind];
    out.y = rect.y + rect.h + 12;
  };

  const P: Point = { x: 0, y: 0 };
  const Q: Point = { x: 0, y: 0 };
  const walks: { t: number; ax: number; ay: number; bx: number; by: number }[][] = layout.units.map(() => []);
  const roadAt = new Map<string, { ax: number; ay: number; bx: number; by: number; times: number[] }>();
  const legsOf: number[][] = traces.map(() => []);
  const winners = traces.map((trace) => trace.nodes.some((n) => n.stage === 'winner'));

  for (const draft of drafts) {
    const thing = things[draft.thing];
    thing.acts = Float64Array.from(draft.acts).sort();
    const sorted = draft.moves.map((m, k) => ({ ...m, k })).sort((a, b) => a.t - b.t || a.k - b.k);
    const kept: typeof sorted = [];
    for (const m of sorted) {
      const last = kept[kept.length - 1];
      if (last && last.place === m.place) continue;
      if (last && kept.length > 1 && m.t - last.t < MERGE && last.place < FARM && m.place < FARM) {
        last.place = m.place;
        last.by = m.by;
        if (kept[kept.length - 2].place === last.place) kept.pop();
        continue;
      }
      kept.push(m);
    }
    if (draft.plant) {
      if (market !== undefined && kept[kept.length - 1].place !== U + market) kept.push({ t: draft.plant.t, place: U + market, by: -1, k: -1 });
      kept.push({ t: draft.plant.t, place: draft.plant.place, by: draft.plant.by, k: draft.plant.known ? -2 : -3 });
    }
    const store = STORE + thing.kind;
    thing.moves = kept.map((m, k) => {
      const prev = kept[k - 1];
      const before = k ? thing.acts[lower(thing.acts, m.t) - 1] : m.t;
      const jump = m.k === -1;
      const stored = !!stores && !!prev && !jump && prev.k !== -1 && prev.place < FARM && m.t - before >= IDLE;
      anchor(m.place, thing, Q);
      if (prev && !jump) anchor(stored ? store : prev.place, thing, P);
      else anchor(m.place, thing, P);
      const move: Move = { t: m.t, place: m.place, by: m.by, ax: P.x, ay: P.y, bx: Q.x, by2: Q.y, stored, jump, whole: !prev || k === 1 || prev.k === -1 || m.t - prev.t >= 3 * 60 * MINUTE };
      if (prev && m.by >= 0 && !relay(m.by)) walks[m.by].push({ t: m.t, ax: P.x, ay: P.y, bx: Q.x, by: Q.y });
      if (prev && m.by >= 0 && m.k !== -3) {
        const key = `${Math.round(P.x)},${Math.round(P.y)},${Math.round(Q.x / GRID)},${Math.round(Q.y / GRID)}`;
        const road = roadAt.get(key);
        if (road && winners[thing.trace]) road.times.push(m.t);
        else if (winners[thing.trace]) roadAt.set(key, { ax: P.x, ay: P.y, bx: Q.x, by: Q.y, times: [m.t] });
        legsOf[thing.trace].push(draft.thing, k);
      }
      return move;
    });
    thing.moveT = Float64Array.from(thing.moves, (m) => m.t);
    for (const flight of draft.flights) {
      anchor(flight.from, thing, P);
      const jitter = ((flyers.length * 7) % 5) - 2;
      const host = thing.moves[Math.max(0, upper(thing.moveT, flight.t) - 1)].place;
      const by = flight.by >= 0 ? flight.by : host < U ? host : -1;
      flyers.push({ t: flight.t, type: flight.type, thing: draft.thing, by, ax: P.x + jitter * 5, ay: P.y });
      if (by < 0 || relay(by)) continue;
      anchor(host, thing, Q);
      walks[by].push({ t: flight.t, ax: P.x, ay: P.y, bx: Q.x, by: Q.y });
    }
  }
  flyers.sort((a, b) => a.t - b.t);
  const flyerTimes = Float64Array.from(flyers, (f) => f.t);

  const hauls: (Hauls | null)[] = walks.map((list) => {
    if (!list.length) return null;
    list.sort((a, b) => a.t - b.t);
    return {
      t: Float64Array.from(list, (h) => h.t),
      ax: Float64Array.from(list, (h) => h.ax),
      ay: Float64Array.from(list, (h) => h.ay),
      bx: Float64Array.from(list, (h) => h.bx),
      by: Float64Array.from(list, (h) => h.by),
    };
  });

  function walk(unit: number, time: number, life: number, out: Point) {
    const list = hauls[unit];
    if (!list || life <= 0) return 0;
    const span = life * CARRY;
    const rise = life * RISE;
    const back = life * BACK;
    let sum = 0;
    let top = 0;
    let x = 0;
    let y = 0;
    let seen = 0;
    for (let j = upper(list.t, time + rise) - 1; j >= 0 && seen < BLEND_CAP; j--, seen++) {
      const dt = time - list.t[j];
      if (dt > span + back) break;
      let k = 1;
      let s = 0;
      if (dt < 0) k = smooth(1 + dt / rise);
      else if (dt < span) s = smooth(clamp((dt / span - 0.1) / 0.8, 0, 1));
      else {
        k = 1 - smooth((dt - span) / back);
        s = 1;
      }
      if (k <= 0) continue;
      sum += k;
      top = Math.max(top, k);
      x += k * (list.ax[j] + (list.bx[j] - list.ax[j]) * s);
      y += k * (list.ay[j] + (list.by[j] - list.ay[j]) * s);
    }
    if (sum <= 0) return 0;
    out.x = x / sum + radius + 4;
    out.y = y / sum + 6;
    return top;
  }

  const bounds = layout.bounds;
  const gridW = Math.ceil(bounds.w / GRID) + 1;
  const gridH = Math.ceil(bounds.h / GRID) + 1;
  const cellsOf = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (GRID * 0.5)));
    const cells: number[] = [];
    for (let k = 0; k <= n; k++) {
      const cx = clamp(Math.floor((ax + ((bx - ax) * k) / n - bounds.x) / GRID), 0, gridW - 1);
      const cy = clamp(Math.floor((ay + ((by - ay) * k) / n - bounds.y) / GRID), 0, gridH - 1);
      const cell = cy * gridW + cx;
      if (cells[cells.length - 1] !== cell) cells.push(cell);
    }
    return cells;
  };
  const roads: Road[] = [...roadAt.values()].map((road) => ({ cells: Int32Array.from(cellsOf(road.ax, road.ay, road.bx, road.by)), times: road.times.sort((a, b) => a - b) }));
  const density = new Float32Array(gridW * gridH);
  const heat = new Float32Array(gridW * gridH);
  const touched: number[] = [];
  let trailAt = -Infinity;
  let trailKey = '';

  function trail(g: Graphics, state: SimState, focus: string | null) {
    const now = performance.now();
    const key = `${focus ?? ''}|${Math.round(state.t / MINUTE)}`;
    if (now - trailAt < TRAIL_MS || key === trailKey) return;
    trailAt = now;
    trailKey = key;
    g.clear();
    for (const cell of touched) density[cell] = heat[cell] = 0;
    touched.length = 0;
    const linger = state.tauMs * LINGER;
    for (const road of roads) {
      const n = upper(road.times, state.t);
      let left = 0;
      for (let k = n - 1; k >= 0; k--) {
        const shade = SHADES - Math.floor((state.t - road.times[k]) / FADE);
        if (shade <= 0) break;
        left += shade / SHADES;
      }
      if (!left) continue;
      const hot = n - upper(road.times, state.t - linger);
      for (const cell of road.cells) {
        if (!density[cell]) touched.push(cell);
        density[cell] += left;
        heat[cell] += hot;
      }
    }
    const dim = focus ? 0.35 : 1;
    for (const cell of touched) {
      const warm = Math.min(1, heat[cell] / 3);
      g.fillStyle(mix(SLIME, WHITE, 0.5 * warm), dim * Math.min(0.42, 0.02 + 0.3 * (1 - Math.exp(-density[cell] / 1.5)) + 0.1 * warm));
      g.fillRect(bounds.x + (cell % gridW) * GRID, bounds.y + Math.floor(cell / gridW) * GRID, GRID, GRID);
    }
    const legs = focus ? legsOf[byId.get(focus) ?? -1] : undefined;
    if (!legs) return;
    const lit = new Set<number>();
    g.fillStyle(TRACE, 0.5);
    for (let n = 0; n < legs.length; n += 2) {
      const move = things[legs[n]].moves[legs[n + 1]];
      if (move.t > state.t) continue;
      for (const cell of cellsOf(move.ax, move.ay, move.bx, move.by2)) {
        if (lit.has(cell)) continue;
        lit.add(cell);
        g.fillRect(bounds.x + (cell % gridW) * GRID, bounds.y + Math.floor(cell / gridW) * GRID, GRID, GRID);
      }
    }
  }

  const N = things.length;
  const active = new Int32Array(N);
  const phase = new Uint8Array(N);
  const member = new Int32Array(N);
  const arrive = new Float64Array(N);
  const last = new Float64Array(N);
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const sx = new Float64Array(N);
  const sy = new Float64Array(N);
  const piles = new Map<number, number[]>();
  const hits: number[] = [];
  const stored: number[] = [0, 0, 0];
  const DESK = B * KINDS + R;
  const PILES = DESK + U * KINDS;
  const shelves = { n: new Int32Array(PILES), x: new Float64Array(PILES), y: new Float64Array(PILES) };
  const shelved: number[][] = Array.from({ length: PILES }, () => []);
  const shelfKind = (n: number) => (n < B * KINDS ? n % KINDS : n < DESK ? -1 : (n - DESK) % KINDS);
  const spot = (n: number, out: Point) => {
    if (n < B * KINDS) return slot(U + Math.floor(n / KINDS), 0, 1, n % KINDS, out);
    if (n >= DESK) {
      const u = Math.floor((n - DESK) / KINDS);
      out.x = layout.units[u].x - deskSide(u) - 14;
      out.y = layout.units[u].y - 14 + ((n - DESK) % KINDS) * 14.5;
      return;
    }
    const farm = layout.regions[n - B * KINDS].farm!;
    out.x = farm.x + farm.w - 30;
    out.y = farm.y - 10;
  };
  const kept = [false, false, false];
  let shelfT = 0;
  const C: Point = { x: 0, y: 0 };
  const byId = new Map(traces.map((t, i) => [t.id, i]));

  function draw(g: Graphics, state: SimState, ux: Float64Array, uy: Float64Array, ua: Float32Array, thin: number, focus: string | null, shown: Record<ResourceType, boolean>, seen: (rect: Rect) => boolean) {
    g.clear();
    hits.length = 0;
    stored.fill(0);
    kept.fill(false);
    shelfT = state.t;
    shelves.n.fill(0);
    for (const list of shelved) list.length = 0;
    if (!N) return;
    const t = state.t;
    const span = state.lifeMs * CARRY;
    const focused = focus ? (byId.get(focus) ?? -1) : -1;
    for (const list of piles.values()) list.length = 0;
    const enter = (i: number, place: number, since: number) => {
      member[i] = place;
      arrive[i] = since;
      const list = piles.get(place);
      if (list) list.push(i);
      else piles.set(place, [i]);
    };

    for (let i = 0; i < N; i++) {
      const thing = things[i];
      phase[i] = 0;
      member[i] = -1;
      const k = upper(thing.moveT, t) - 1;
      active[i] = k;
      if (k < 0 || !shown[LEAD[thing.kind]]) continue;
      const move = thing.moves[k];
      const s = k === 0 || move.jump ? 1 : (t - move.t) / span;
      last[i] = thing.acts[Math.max(0, upper(thing.acts, t) - 1)];
      if (s >= 1) {
        if (move.place >= FARM) {
          phase[i] = 6;
          continue;
        }
        const idle = t - last[i];
        if (stores && idle >= IDLE) {
          stored[thing.kind]++;
          member[i] = STORE + thing.kind;
          if (thing.trace === focused) kept[thing.kind] = true;
          continue;
        }
        phase[i] = 1;
        enter(i, move.place, move.t);
      } else if (s < LIFT) {
        phase[i] = 2;
        const prev = thing.moves[k - 1];
        if (!move.stored && move.whole && prev.place < FARM) enter(i, prev.place, prev.t);
      } else if (s > 1 - LIFT) {
        phase[i] = 4;
        if (move.place < FARM) enter(i, move.place, move.t);
      } else phase[i] = 3;
    }

    for (const [place, list] of piles) {
      if (!list.length) continue;
      list.sort((a, b) => arrive[a] - arrive[b] || a - b);
      for (let rank = 0; rank < list.length; rank++) {
        slot(place, rank, list.length, things[list[rank]].kind, C);
        sx[list[rank]] = C.x;
        sy[list[rank]] = C.y;
      }
    }

    const carrier = (by: number, s: number, ax: number, ay: number, bx: number, by2: number) => {
      const there = by >= 0 && ua[by] > 0 && !state.units[by]?.hidden;
      if (there && !relay(by)) {
        C.x = ux[by];
        C.y = uy[by] - radius - 8;
        return;
      }
      const q = smooth(clamp((s - 0.1) / 0.8, 0, 1));
      if (there) {
        const mx = ux[by];
        const my = uy[by] - radius - 8;
        const h = q < 0.5 ? q * 2 : q * 2 - 1;
        C.x = q < 0.5 ? ax + (mx - ax) * h : mx + (bx - mx) * h;
        C.y = q < 0.5 ? ay + (my - ay) * h : my + (by2 - my) * h;
        return;
      }
      C.x = ax + (bx - ax) * q;
      C.y = ay + (by2 - ay) * q;
    };

    for (let ri = 0; ri < R; ri++) {
      const region = layout.regions[ri];
      const farm = region.farm;
      if (!farm || (region.since !== undefined && t < region.since) || !seen(farm)) continue;
      g.fillStyle(SOIL, 0.55);
      g.fillRoundedRect(farm.x - 3, farm.y - 3, farm.w + 6, farm.h + 6, 5);
      g.lineStyle(1 * thin, FURROW, 0.7);
      g.strokeRoundedRect(farm.x - 3, farm.y - 3, farm.w + 6, farm.h + 6, 5);
      const pitch = plotPitch[ri] || PLOT_MAX;
      g.lineStyle(0.6, FURROW, 0.35);
      for (let y = farm.y + pitch; y < farm.y + farm.h - 1; y += pitch) g.lineBetween(farm.x, y, farm.x + farm.w, y);
      const list = planted[ri];
      const n = upper(plantTimes[ri], t);
      const cell = pitch - 1;
      let lit = false;
      for (let j = 0; j < n; j++) {
        const i = list[j];
        if (phase[i] !== 6) continue;
        const thing = things[i];
        const own = thing.trace === focused;
        const won = winning(thing, t);
        const off = thing.live ? offSince(thing, t) : last[i];
        if (!won && thing.kind === CLIENT && (thing.won.length ? t - off >= WITHER : true)) {
          phase[i] = 0;
          continue;
        }
        if (!won && t - off >= IDLE) {
          shelved[B * KINDS + ri].push(i);
          spot(B * KINDS + ri, P);
          px[i] = P.x;
          py[i] = P.y;
          continue;
        }
        plotAt(thing, P);
        px[i] = P.x;
        py[i] = P.y;
        if (own) lit = true;
        const ads = upper(thing.ads, t);
        const dead = !won && (thing.won.some((at) => at <= t) || (thing.live ? off < Infinity : t - last[i] > WITHER));
        const color = own ? TRACE : won ? (thing.kind === CLIENT ? THEIRS : TROPHY) : dead ? GREY : CROP;
        const fresh = pop((t - thing.planted - span) / state.lifeMs);
        g.fillStyle(mix(SOIL, color, dead ? 0.25 : 0.4), 1);
        g.fillRect(P.x - cell / 2, P.y - cell / 2, cell, cell);
        if (pitch >= 11) {
          glyphs(g, thing, P.x, P.y, t, span, dead ? 0.75 : 0, 0.85 * fresh);
          g.lineStyle(1.1 * thin, color, 1);
          g.strokeRect(P.x - cell / 2, P.y - cell / 2, cell, cell);
          if (won && thing.kind !== CLIENT) {
            starPath(g, P.x + cell / 2 - 1, P.y - cell / 2 + 1, 3.2);
            g.fillStyle(TROPHY, 1);
            g.fillPath();
          }
        } else {
          const grow = (dead ? 0.4 : clamp(0.4 + 0.2 * Math.log2(1 + ads), 0.4, 1)) * fresh;
          g.fillStyle(color, dead ? 0.7 : 1);
          if (won && pitch >= 6) {
            starPath(g, P.x, P.y, cell * 0.55);
            g.fillPath();
          } else g.fillRect(P.x - (cell * grow) / 2, P.y - (cell * grow) / 2, cell * grow, cell * grow);
        }
        hits.push(P.x, P.y, Math.max(2.5, pitch / 2), i);
      }
      const put = shelved[B * KINDS + ri];
      const mine = put.some((i) => things[i].trace === focused);
      spot(B * KINDS + ri, P);
      silo(g, P.x, P.y, mine, focused >= 0 && !mine ? 0.45 : 1, thin);
      shelves.n[B * KINDS + ri] = put.length;
      shelves.x[B * KINDS + ri] = P.x;
      shelves.y[B * KINDS + ri] = P.y;
      if (lit) {
        g.fillStyle(TRACE, 0.1);
        g.fillRoundedRect(farm.x - 3, farm.y - 3, farm.w + 6, farm.h + 6, 5);
        g.lineStyle(2.4 * thin, TRACE, 1);
        g.strokeRoundedRect(farm.x - 5, farm.y - 5, farm.w + 10, farm.h + 10, 6);
      }
    }

    if (stores) {
      for (let n = 0; n < KINDS; n++) shed(g, stores[n].x, stores[n].y, n, thin);
      for (let n = 0; n < KINDS; n++) {
        if (!kept[n]) continue;
        g.lineStyle(2 * thin, TRACE, 1);
        g.strokeCircle(stores[n].x, stores[n].y + 2, 34);
      }
    }

    if (focused >= 0) {
      const legs = legsOf[focused];
      g.fillStyle(TRACE, 0.9);
      for (let n = 0; n < legs.length; n += 2) {
        const move = things[legs[n]].moves[legs[n + 1]];
        if (move.t > t) continue;
        const dots = clamp(Math.round(Math.hypot(move.bx - move.ax, move.by2 - move.ay) / (8 * thin)), 2, 80);
        for (let d = 1; d < dots; d++) g.fillCircle(move.ax + ((move.bx - move.ax) * d) / dots, move.ay + ((move.by2 - move.ay) * d) / dots, 1.4 * thin);
      }
    }

    for (let i = 0; i < N; i++) {
      const mode = phase[i];
      if (!mode || mode === 6) continue;
      const thing = things[i];
      const k = active[i];
      const move = thing.moves[k];
      const idle = t - last[i];
      let x = sx[i];
      let y = sy[i];
      let lifted = 0;
      if (mode >= 2) {
        const s = (t - move.t) / span;
        carrier(move.by, s, move.ax, move.ay, move.bx, move.by2);
        if (mode === 3) {
          x = C.x;
          y = C.y;
          lifted = 1;
        } else if (mode === 2) {
          const fx = member[i] >= 0 ? sx[i] : move.ax;
          const fy = member[i] >= 0 ? sy[i] : move.ay;
          lifted = smooth(s / LIFT);
          x = fx + (C.x - fx) * lifted;
          y = fy + (C.y - fy) * lifted;
        } else {
          const tx = member[i] >= 0 ? sx[i] : move.bx;
          const ty = member[i] >= 0 ? sy[i] : move.by2;
          lifted = 1 - smooth((s - (1 - LIFT)) / LIFT);
          x = tx + (C.x - tx) * lifted;
          y = ty + (C.y - ty) * lifted;
        }
      }
      px[i] = x;
      py[i] = y;
      const own = thing.trace === focused;
      if (mode === 1 && move.place < U && !own) {
        shelved[DESK + move.place * KINDS + thing.kind].push(i);
        continue;
      }
      if (mode === 1 && move.place >= U && move.place < FARM) {
        shelved[(move.place - U) * KINDS + thing.kind].push(i);
        continue;
      }
      const stale = clamp((idle - GREY_FROM) / (IDLE - GREY_FROM), 0, 1);
      const size = 6.2 * pop((t - thing.moveT[0]) / state.lifeMs) * (1 + 0.15 * lifted);
      if (size <= 0) continue;
      const alpha = focused >= 0 && !own ? 0.45 : 1 - 0.3 * stale;
      g.fillStyle(BG, 0.85 * alpha);
      g.fillRoundedRect(x - size, y - size, size * 2, size * 2, 2.5);
      g.lineStyle((own ? 1.6 : 1) * thin, own ? TRACE : mix(EDGE[thing.kind], GREY, stale * 0.85), alpha);
      g.strokeRoundedRect(x - size, y - size, size * 2, size * 2, 2.5);
      glyphs(g, thing, x, y, t, span, stale * 0.85, alpha * (size / 6.2));
      if (own) {
        g.lineStyle(1.3 * thin, WHITE, 1);
        g.strokeCircle(x, y, size + 4 * thin);
      }
      hits.push(x, y, 7, i);
    }

    for (let n = 0; n < PILES; n++) {
      const list = shelved[n];
      const kind = shelfKind(n);
      if (!list.length || kind < 0) continue;
      spot(n, C);
      const own = list.some((i) => things[i].trace === focused);
      const alpha = focused >= 0 && !own ? 0.45 : 1;
      const edge = own ? TRACE : EDGE[kind];
      const size = 6.2;
      shelves.n[n] = list.length;
      shelves.x[n] = C.x;
      shelves.y[n] = C.y;
      for (let back = Math.min(2, list.length - 1); back >= 0; back--) {
        const x = C.x + back * 2.2;
        const y = C.y - back * 2.2;
        g.fillStyle(BG, 0.9 * alpha);
        g.fillRoundedRect(x - size, y - size, size * 2, size * 2, 2.5);
        g.lineStyle((own ? 1.6 : 1) * thin, edge, alpha);
        g.strokeRoundedRect(x - size, y - size, size * 2, size * 2, 2.5);
      }
      g.fillStyle(TYPE_COLOR[LEAD[kind]], alpha);
      resourcePath(g, LEAD[kind], C.x, C.y, 3.5);
      g.fillPath();
      if (own) {
        g.lineStyle(2 * thin, TRACE, 1);
        g.strokeCircle(C.x + 2, C.y - 2, size + 7 * thin);
      }
    }

    const until = upper(flyerTimes, t);
    for (let n = upper(flyerTimes, t - span); n < until; n++) {
      const flyer = flyers[n];
      const i = flyer.thing;
      const thing = things[i];
      if (active[i] < 0 || !shown[LEAD[thing.kind]]) continue;
      let hx = px[i];
      let hy = py[i];
      if (!phase[i]) {
        const store = stores?.[thing.kind];
        if (!store) continue;
        hx = store.x;
        hy = store.y;
      }
      const s = (t - flyer.t) / span;
      carrier(flyer.by, s, flyer.ax, flyer.ay, hx, hy);
      let x = C.x;
      let y = C.y + (flyer.by >= 0 ? -7 : 0);
      if (s < LIFT) {
        const q = smooth(s / LIFT);
        x = flyer.ax + (x - flyer.ax) * q;
        y = flyer.ay + (y - flyer.ay) * q;
      } else if (s > 1 - LIFT) {
        const q = smooth((s - (1 - LIFT)) / LIFT);
        x += (hx - x) * q;
        y += (hy - y) * q;
      }
      const r = 3.4 * pop(s * CARRY);
      g.fillStyle(thing.trace === focused ? TRACE : TYPE_COLOR[flyer.type], 1);
      resourcePath(g, flyer.type, x, y, r);
      g.fillPath();
      g.lineStyle(1 * thin, WHITE, 0.9 * (1 - s));
      g.strokeCircle(x, y, r + 3 * thin);
    }
  }

  const SPOTS: [number, number][][] = [[], [[0, 0]], [[-3.1, 0], [3.1, 0]], [[-3.1, -3], [3.1, -3], [0, 3]], [[-3.1, -3], [3.1, -3], [-3.1, 3], [3.1, 3]]];

  function glyphs(g: Graphics, thing: Thing, x: number, y: number, t: number, span: number, stale: number, alpha: number) {
    const order = PARTS[thing.kind];
    let count = 0;
    for (const part of thing.parts) if (t >= part.t + (part.flown ? span : 0)) count++;
    count = Math.min(4, count);
    if (!count) return;
    const spots = SPOTS[count];
    const r = count === 1 ? 3.5 : count === 2 ? 2.5 : 2.2;
    let n = 0;
    for (const type of order) {
      const part = thing.parts.find((p) => p.type === type);
      if (!part || t < part.t + (part.flown ? span : 0) || n >= count) continue;
      g.fillStyle(mix(TYPE_COLOR[type], GREY, stale), alpha);
      resourcePath(g, type, x + spots[n][0], y + spots[n][1], r);
      g.fillPath();
      n++;
    }
  }

  function silo(g: Graphics, x: number, y: number, own: boolean, alpha: number, thin: number) {
    const edge = own ? TRACE : GREY;
    g.fillStyle(mix(BG, GREY, 0.3), alpha);
    g.lineStyle((own ? 2 : 1.2) * thin, edge, alpha);
    g.beginPath();
    g.moveTo(x - 7, y + 9);
    g.lineTo(x - 7, y - 7);
    g.arc(x, y - 7, 7, Math.PI, Math.PI * 2, false);
    g.lineTo(x + 7, y + 9);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.lineStyle(0.8 * thin, edge, 0.6 * alpha);
    g.lineBetween(x - 7, y - 2, x + 7, y - 2);
    g.lineBetween(x - 7, y + 3.5, x + 7, y + 3.5);
    g.fillStyle(edge, 0.8 * alpha);
    g.fillRect(x - 2, y + 4.5, 4, 4.5);
  }

  function shed(g: Graphics, x: number, y: number, kind: number, thin: number) {
    const creative = kind === 1;
    const edge = EDGE[kind];
    g.fillStyle(0x05070b, 0.55);
    g.fillEllipse(x, y + 22, 62, 9);
    g.lineStyle(1.3 * thin, edge, 1);
    g.fillStyle(mix(BG, edge, creative ? 0.3 : 0.22), 1);
    g.beginPath();
    if (creative) {
      g.moveTo(x - 22, y + 21);
      g.lineTo(x - 22, y - 4);
      g.lineTo(x - 13, y - 17);
      g.lineTo(x + 13, y - 17);
      g.lineTo(x + 22, y - 4);
      g.lineTo(x + 22, y + 21);
    } else {
      g.moveTo(x - 30, y + 21);
      g.lineTo(x - 19, y - 3);
      g.lineTo(x - 7, y - 18);
      g.lineTo(x + 8, y - 14);
      g.lineTo(x + 21, y - 1);
      g.lineTo(x + 30, y + 21);
    }
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.fillStyle(0x05070b, 0.9);
    g.fillRect(x - 7, y + 3, 14, 18);
    g.lineStyle(1.2 * thin, mix(BG, edge, 0.7), 1);
    g.strokeRect(x - 7, y + 3, 14, 18);
    g.fillStyle(edge, 0.9);
    resourcePath(g, LEAD[kind], x, y - 6, 3.2);
    g.fillPath();
  }

  function idle(kind: number, t: number) {
    const out: { id: string; name: string; region: string | null; parts: ResourceType[]; ads: number; since: number }[] = [];
    if (!stores) return out;
    for (const thing of things) {
      if (thing.kind !== kind) continue;
      const k = upper(thing.moveT, t) - 1;
      if (k < 0 || thing.moves[k].place >= FARM) continue;
      const since = thing.acts[Math.max(0, upper(thing.acts, t) - 1)] + IDLE;
      if (t < since) continue;
      out.push({
        id: traces[thing.trace].id,
        name: thing.name,
        region: traces[thing.trace].region,
        parts: PARTS[kind].filter((type) => thing.parts.some((part) => part.type === type && part.t <= t)),
        ads: upper(thing.ads, t),
        since,
      });
    }
    return out.sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
  }

  function shelfAt(p: Point) {
    for (let n = 0; n < shelves.n.length; n++) {
      if (!shelves.n[n] || p.x < shelves.x[n] - 9 || p.x > shelves.x[n] + 30 || Math.abs(p.y - shelves.y[n]) > (n >= DESK ? 7 : 10)) continue;
      if (n >= DESK) return { kind: 'unit' as const, id: layout.units[Math.floor((n - DESK) / KINDS)].id, shelf: SHELVES[(n - DESK) % KINDS] };
      if (n >= B * KINDS) return { kind: 'region' as const, id: layout.regions[n - B * KINDS].id, shelf: 'retired' as const };
      return { kind: 'building' as const, id: layout.buildings[Math.floor(n / KINDS)].id, shelf: SHELVES[n % KINDS] };
    }
    return null;
  }

  const shelfOf = (id: string, which: Shelf) => {
    if (which === 'retired') return B * KINDS + (regionAt.get(id) ?? -1 - B * KINDS);
    const at = buildingAt.get(id);
    if (at !== undefined) return at * KINDS + SHELVES.indexOf(which);
    const u = layout.index.get(id);
    return u === undefined ? -1 : DESK + u * KINDS + SHELVES.indexOf(which);
  };

  function shelf(id: string, which: Shelf) {
    const n = shelfOf(id, which);
    if (n < 0) return [];
    const since = (i: number) => (which !== 'retired' ? arrive[i] : things[i].live ? offSince(things[i], shelfT) : last[i]);
    return [...shelved[n]].sort((a, c) => since(c) - since(a) || a - c).map((i) => ({ id: traces[things[i].trace].id, key: things[i].key, name: things[i].name }));
  }

  function trailOf(p: Point, t: number) {
    let best = -1;
    let latest = -Infinity;
    for (let ti = 0; ti < legsOf.length; ti++) {
      if (!winners[ti]) continue;
      const legs = legsOf[ti];
      for (let n = 0; n < legs.length; n += 2) {
        const move = things[legs[n]].moves[legs[n + 1]];
        if (move.t > t || t - move.t >= SHADES * FADE || move.t <= latest) continue;
        const dx = move.bx - move.ax;
        const dy = move.by2 - move.ay;
        const k = clamp(((p.x - move.ax) * dx + (p.y - move.ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        if (Math.hypot(p.x - move.ax - dx * k, p.y - move.ay - dy * k) > GRID) continue;
        latest = move.t;
        best = ti;
      }
    }
    return best < 0 ? null : traces[best].id;
  }

  function hit(p: Point) {
    for (let n = hits.length - 4; n >= 0; n -= 4) if (Math.abs(p.x - hits[n]) <= hits[n + 2] && Math.abs(p.y - hits[n + 1]) <= hits[n + 2]) return hits[n + 3];
    return -1;
  }

  function at(p: Point) {
    const i = hit(p);
    const items = i < 0 || phase[i] !== 6 || things[i].kind === CLIENT ? null : things[i].won.some((at) => at <= shelfT) ? ('winner' as const) : ('ad' as const);
    return i < 0 ? null : { id: traces[things[i].trace].id, items };
  }

  function tip(p: Point, t: number, names: { regionName(id: string, name: string): string; redact(text: string, region: string | null): string }) {
    const i = hit(p);
    if (i < 0) {
      const pile = shelfAt(p);
      if (!pile) return null;
      const n = shelves.n[shelfOf(pile.id, pile.shelf)];
      const many = n === 1 ? '' : 's';
      if (pile.kind === 'unit') return `${n.toLocaleString('en-US')} ${pile.shelf}${many} with ${layout.units[layout.index.get(pile.id)!].name}, click to list ${n === 1 ? 'it' : 'them'}`;
      if (pile.kind === 'region') return `${n.toLocaleString('en-US')} creative${many} in the silo, put away from ${names.regionName(pile.id, layout.regions[regionAt.get(pile.id)!].name)}'s ad account five days after their ads were turned off, click to list ${n === 1 ? 'it' : 'them'}`;
      return `${n.toLocaleString('en-US')} ${pile.shelf}${many} lying at ${layout.buildings[buildingAt.get(pile.id)!].name}, click to list ${n === 1 ? 'it' : 'them'}`;
    }
    const thing = things[i];
    const id = traces[thing.trace].id;
    const name = names.redact(thing.name, traces[thing.trace].region);
    if (thing.kind === CLIENT) return `client winner ${name} · an ad the client made · ${winning(thing, t) ? `winning in the ad account for ${fmtDuration(t - last[i])}` : 'win streak over in the ad account'} · click to inspect`;
    const move = thing.moves[active[i]];
    const made = PARTS[thing.kind].filter((type) => type !== 'ad' && thing.parts.some((part) => part.type === type && part.t <= t)).map((type) => RESOURCE_LABELS[type]);
    const ads = upper(thing.ads, t);
    if (ads) made.push(`${ads} ad${ads === 1 ? '' : 's'}`);
    const mode = phase[i];
    const where =
      mode === 6
        ? winning(thing, t)
          ? 'a winner in the ad account'
          : thing.won.some((at) => at <= t)
            ? 'win streak over in the ad account'
            : thing.live
              ? offSince(thing, t) < Infinity
                ? 'turned off in the ad account'
                : 'live in the ad account'
              : t - last[i] > WITHER
                ? 'gone quiet in the ad account'
                : 'live in the ad account'
        : mode !== 1 && move.by >= 0
          ? `carried by ${layout.units[move.by].name}`
          : mode !== 1
            ? 'on the move'
            : move.place < U
              ? `with ${layout.units[move.place].name}`
              : `at ${layout.buildings[move.place - U].name}`;
    return `${id.slice(id.indexOf(':') + 1)} ${thing.creative ? `creative ${name}` : thing.kind === 2 ? `brief ${name}` : name} · ${made.join(' + ')} · ${where} · quiet for ${fmtDuration(t - last[i])}`;
  }

  function where(trace: string, key: string, out: Point) {
    const i = thingOf.get(`${trace}\n${key}`);
    if (i === undefined || active[i] < 0) return null;
    const thing = things[i];
    const move = thing.moves[active[i]];
    if (phase[i] === 6) {
      if (!winning(thing, shelfT) && shelfT - (thing.live ? offSince(thing, shelfT) : last[i]) >= IDLE) spot(B * 2 + thing.region, out);
      else plotAt(thing, out);
    } else if (phase[i]) {
      out.x = px[i];
      out.y = py[i];
      return phase[i] === 1 ? (move.place < U ? move.place : -1) : move.by;
    } else if (member[i] >= STORE) anchor(member[i], thing, out);
    else return null;
    return -1;
  }

  return {
    walk,
    times: (unit) => (hauls[unit] ? Array.from(hauls[unit]!.t) : []),
    carried: (resource) => N > 0 && CARRIED.has(resource),
    stored,
    shelves,
    shelf,
    shelfAt,
    shelfType: (n) => (shelfKind(n) < 0 ? null : LEAD[shelfKind(n)]),
    idle,
    trail,
    draw,
    at,
    trailAt: trailOf,
    tip,
    where,
  };
}
