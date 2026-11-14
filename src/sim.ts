import { CRAFTS, DREAMING, HIRED, LEAD_STAGES, type Busy, type RegionTotals, type Replay, type ReplayEvent, type ResourceType } from './schema';
import type {
  Anchor,
  ApplicantState,
  CrowdState,
  FeatureState,
  FlightState,
  LaneInfo,
  Layout,
  LayoutBuilding,
  MeetingState,
  AgentState,
  Partners,
  Point,
  PulseState,
  Rect,
  RingState,
  Sim,
  SimState,
  TrophyState,
  UnitState,
} from './seam';
import { createBusy } from './sim/busy';
import { createCounters } from './sim/counters';
import { RESOURCES, createHoldings, perResource } from './sim/holdings';
import { createAgents } from './sim/agents';
import { openingTrophies } from './sim/opening';
import { upperBound } from './sim/search';
import { runSelfcheck, type Mismatch } from './sim/selfcheck';
import type { Cargo } from './cargo';
import { createTicker } from './sim/tick';

export type { Mismatch };

export interface CheckedSim extends Sim {
  selfcheck(): Mismatch[];
}

const MINUTE = 60_000;
const CROWD = 100;
const BEND = 0.14;
const GLOW_HORIZON = 10;
const SHADES = 5;
const WANDER = 4.5;
const TABLE_RADIUS: Record<MeetingState['size'], number> = { small: 10, medium: 23, large: 42 };
const TABLE_GAP = 16;
const MEETING_GAP = 56;
const SEAT_ARC = 30;
const SEAT_ROW = 30;
const MIN_SITTING = 5 * 60_000;
const TRIP_CAP = 3;
const ACCOUNT = new Set<ResourceType | null>(['campaign', 'adset', 'ad']);
const ROAM = 9 * 60 * MINUTE;
const ARRIVAL = 3;
const TRANSIT = 40 * MINUTE;
const visits = (kind: string) => kind === 'person' || kind === 'client' || kind === 'ambassador';
const smooth = (v: number) => v * v * (3 - 2 * v);
const HAUL: Point = { x: 0, y: 0 };
const RING: Record<RingState['kind'], { base: number; grow: number }> = {
  create: { base: 3, grow: 8 },
  comment: { base: 3, grow: 10 },
  done: { base: 4, grow: 14 },
  edit: { base: 3, grow: 6 },
  bulk: { base: 7, grow: 26 },
  status: { base: 3, grow: 9 },
};

const SERVICE: Partial<Record<ReplayEvent['kind'], number>> = { use: 0, run: 1, error: 2 };
const quiet = (e: ReplayEvent) => e.kind === 'run' || e.kind === 'error';

const lifeMs = (speed: number) => Math.max(3, speed) * MINUTE;
const tauMs = (speed: number) => Math.max(45, 4 * speed) * MINUTE;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const inside = (rect: Rect, p: Point) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

function control(x0: number, y0: number, x1: number, y1: number) {
  return { x: (x0 + x1) / 2 - (y1 - y0) * BEND, y: (y0 + y1) / 2 + (x1 - x0) * BEND };
}

function along(a: Anchor, b: Anchor, s: number) {
  const c = control(a.x, a.y, b.x, b.y);
  const u = 1 - s;
  return { x: u * u * a.x + 2 * u * s * c.x + s * s * b.x, y: u * u * a.y + 2 * u * s * c.y + s * s * b.y };
}

function shadeOf(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SHADES;
}

interface Lane extends LaneInfo {
  a: number;
  b: number;
  times: number[];
  types: number[];
  back: boolean[];
  pullA: Point;
  pullB: Point;
}

export function createSim(replay: Replay, layout: Layout, opening: RegionTotals[] = [], cargo: Cargo | null = null): CheckedSim {
  const events: ReplayEvent[] = [...replay.events].sort((a, b) => a.t - b.t);
  const times = Float64Array.from(events, (e) => e.t);
  const units = layout.units;
  const radius = layout.unitRadius;
  const idx = (id: string | null | undefined) => (id ? layout.index.get(id) : undefined);
  const buildings = new Map(layout.buildings.map((b) => [b.id, b]));
  const depots = new Map<ResourceType, LayoutBuilding>();
  for (const b of layout.buildings) if (b.resource && !depots.has(b.resource)) depots.set(b.resource, b);
  const regionRects = new Map(layout.regions.map((r) => [r.id, { ...r.rect, h: r.rect.h - r.foot }]));
  const home = layout.regions.find((r) => r.kind === 'internal')?.id ?? layout.regions[0]?.id ?? null;
  const tick = createTicker(replay.window);
  const holdingsAt = createHoldings(replay, layout.index, units.length);
  const agents = createAgents(replay.sessions, layout);
  const booked = new Map<string, Busy>();
  for (const span of replay.busy ?? []) {
    if (!span.meeting) continue;
    const call = span.meeting.split('@')[0];
    const found = booked.get(call);
    booked.set(call, found ? { ...found, start: Math.min(found.start, span.start), end: Math.max(found.end, span.end) } : span);
  }
  const guests: Busy[] = units.flatMap((u) =>
    (u.calls ?? []).flatMap((call) => {
      const span = booked.get(call);
      return span ? [{ ...span, unit: u.id }] : [];
    }),
  );
  const outdoors = new Set(guests.map((span) => span.meeting!));
  const calendar = createBusy([...(replay.busy ?? []), ...guests], layout.index, units.length);
  const busyAt = calendar.at;

  const unitRegion = (id: string | null) => {
    const i = idx(id);
    return i === undefined ? null : units[i].region;
  };
  const place = (region: string | null, unit: string | null) =>
    (region && regionRects.has(region) ? region : null) ?? unitRegion(unit) ?? home;
  const countersAt = createCounters(
    replay,
    agents.list.map((m) => m.session),
    place,
    opening,
  );

  const boxes = units.map((u) => {
    const rect = regionRects.get(u.region) ?? layout.bounds;
    return {
      x0: Math.min(u.x, rect.x + radius),
      x1: Math.max(u.x, rect.x + rect.w - radius),
      y0: Math.min(u.y, rect.y + radius),
      y1: Math.max(u.y, rect.y + rect.h - radius),
    };
  });

  function pull(from: number, to: number): Point {
    const a = units[from];
    const b = units[to];
    const rect = a.region === b.region ? undefined : regionRects.get(b.region);
    const tx = rect ? clamp(a.x, rect.x, rect.x + rect.w) : b.x;
    const ty = rect ? clamp(a.y, rect.y, rect.y + rect.h) : b.y;
    const dist = Math.hypot(tx - a.x, ty - a.y);
    if (dist) return { x: (tx - a.x) / dist, y: (ty - a.y) / dist };
    const far = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / far, y: (b.y - a.y) / far };
  }

  const featureIndex = new Map(layout.features.map((f, i) => [f.id, i]));
  const marks3: { t: number; k: number; count: number }[] = [];
  for (const e of events) {
    const f = e.feature ? featureIndex.get(e.feature) : undefined;
    if (f !== undefined) marks3.push({ t: e.t, k: f * 3 + (SERVICE[e.kind] ?? 0), count: e.count });
  }
  for (const { session } of agents.list) {
    const f = featureIndex.get(`claude/${session.tool}`);
    if (f !== undefined) marks3.push({ t: session.start, k: f * 3, count: 1 });
  }
  marks3.sort((a, b) => a.t - b.t);
  const seriesT: number[][] = Array.from({ length: layout.features.length * 3 }, () => []);
  const seriesC: number[][] = Array.from({ length: layout.features.length * 3 }, () => []);
  for (const mark of marks3) {
    const sums = seriesC[mark.k];
    seriesT[mark.k].push(mark.t);
    sums.push((sums.length ? sums[sums.length - 1] : 0) + mark.count);
  }
  const sumAt = (k: number, t: number) => {
    const i = upperBound(seriesT[k], t);
    return i ? seriesC[k][i - 1] : 0;
  };

  const tripT: number[][] = units.map(() => []);
  const tripX: number[][] = units.map(() => []);
  const tripY: number[][] = units.map(() => []);
  const tripW: number[][] = units.map(() => []);
  const tripFree: number[][] = units.map(() => []);
  const within = (i: number, x: number, y: number): Point => ({ x: clamp(x, boxes[i].x0, boxes[i].x1), y: clamp(y, boxes[i].y0, boxes[i].y1) });
  const tripMinute = new Float64Array(units.length).fill(-1);
  const tripSpent = new Float64Array(units.length);
  const trip = (i: number, t: number, x: number, y: number, wanted: number, free = false) => {
    const minute = Math.floor(t / MINUTE);
    if (tripMinute[i] !== minute) {
      tripMinute[i] = minute;
      tripSpent[i] = 0;
    }
    const weight = free ? wanted : Math.min(wanted, TRIP_CAP - tripSpent[i]);
    if (weight <= 0) return;
    if (!free) tripSpent[i] += weight;
    const p = free ? { x, y } : within(i, x, y);
    tripT[i].push(t);
    tripX[i].push(p.x);
    tripY[i].push(p.y);
    tripW[i].push(weight);
    tripFree[i].push(free ? 1 : 0);
  };
  const phases = units.map((u) => {
    let h = 0;
    for (let i = 0; i < u.id.length; i++) h = (h * 33 + u.id.charCodeAt(i)) >>> 0;
    return [(h % 628) / 100, ((h >>> 9) % 628) / 100, 0.8 + ((h >>> 18) % 50) / 100];
  });

  const via = new Int32Array(events.length).fill(-1);
  const shades = new Uint8Array(events.length);
  const fetches: { t: number[]; x: number[]; y: number[]; dx: number[]; dy: number[] }[] = units.map(() => ({ t: [], x: [], y: [], dx: [], dy: [] }));
  const fetched = new Uint8Array(events.length);
  const walker = (i: number) => units[i].kind !== 'prospect' && units[i].kind !== 'recruit' && units[i].kind !== 'automation';
  const farms = new Map(layout.regions.flatMap((r) => (r.farm ? [[r.id, r.farm] as const] : [])));
  const abroadSpot = (e: ReplayEvent, i: number, actor: number): Point | null => {
    if ((e.kind !== 'create' && e.kind !== 'status') || !e.region) return null;
    const field = ACCOUNT.has(e.resource) ? farms.get(e.region) : undefined;
    if (!field && (e.region === units[actor].region || units[actor].kind === 'person' || (units[actor].kind === 'client' && ACCOUNT.has(e.resource)))) return null;
    const rect = field ?? regionRects.get(e.region);
    return rect ? { x: rect.x + rect.w * (0.3 + 0.1 * shades[i]), y: rect.y + rect.h * (0.35 + 0.08 * ((i * 7) % 5)) } : null;
  };
  const sourceOf = (e: ReplayEvent) => {
    const origin = (e.building ? buildings.get(e.building) : undefined) ?? (e.resource ? depots.get(e.resource) : undefined);
    if (!origin) return null;
    const cell = e.feature ? layout.features[featureIndex.get(e.feature) ?? -1] : undefined;
    return { id: origin.id, x: cell?.x ?? origin.x, y: cell?.y ?? origin.y, foot: origin.rect.y + origin.rect.h + 12 };
  };
  const shown: number[] = [];
  const laneMap = new Map<number, Lane>();
  const unitTimes: number[][] = units.map(() => []);
  events.forEach((e, i) => {
    const actor = idx(e.actor);
    const from = idx(e.from);
    const to = idx(e.to);
    const moving = e.kind === 'send' || e.kind === 'assign';
    if (actor !== undefined) unitTimes[actor].push(e.t);
    if (from !== undefined && from !== actor) unitTimes[from].push(e.t);
    if (moving && to !== undefined && to !== actor && to !== from) unitTimes[to].push(e.t);
    via[i] = agents.liveAt(e.via, e.t);
    if (e.resourceId) shades[i] = shadeOf(e.resourceId);
    if (e.kind === 'create' && e.resource && e.resourceId && actor !== undefined && walker(actor)) {
      const origin = sourceOf(e);
      if (origin) {
        const drop = abroadSpot(e, i, actor);
        const list = fetches[actor];
        list.t.push(e.t);
        list.x.push(origin.x + (phases[actor][0] / 6.28 - 0.5) * 30);
        list.y.push(origin.foot);
        list.dx.push(drop ? drop.x : NaN);
        list.dy.push(drop ? drop.y : NaN);
        fetched[i] = 1;
      }
    } else if (e.kind === 'status' && actor !== undefined && walker(actor)) {
      const spot = abroadSpot(e, i, actor);
      if (spot) {
        const list = fetches[actor];
        list.t.push(e.t);
        list.x.push(spot.x);
        list.y.push(spot.y);
        list.dx.push(NaN);
        list.dy.push(NaN);
      }
    }

    const start = e.kind === 'send' ? from : actor;
    const cell = e.feature ? featureIndex.get(e.feature) : undefined;
    if (!quiet(e)) {
      if (e.kind === 'send' && from !== undefined && to !== undefined && from !== to) {
        trip(from, e.t, units[to].x, units[to].y, 3);
        trip(to, e.t, units[from].x, units[from].y, 0.6);
      } else if ((e.kind === 'assign' || e.kind === 'comment') && actor !== undefined && to !== undefined && to !== actor) {
        trip(actor, e.t, units[to].x, units[to].y, e.kind === 'assign' ? 1.5 : 1);
      } else if (!moving && actor !== undefined && cell !== undefined && !e.via) {
        const spot = layout.features[cell];
        const home = buildings.get(spot.building);
        const jitter = phases[actor];
        const proxy = units[actor].kind === 'automation' && spot.building === depots.get('ad')?.id;
        const account = proxy
          ? e.region
            ? (farms.get(e.region) ?? (e.region !== units[actor].region ? regionRects.get(e.region) : undefined))
            : undefined
          : (ACCOUNT.has(e.resource) || units[actor].kind === 'ambassador') && visits(units[actor].kind) && e.region && e.region !== units[actor].region
            ? regionRects.get(e.region)
            : undefined;
        if (account) {
          trip(actor, e.t, account.x + account.w * (0.25 + (jitter[0] / 6.28) * 0.5), account.y + account.h * (0.3 + (jitter[1] / 6.28) * 0.4), 1, true);
        } else if (!proxy) {
          trip(
            actor,
            e.t,
            spot.x + (jitter[0] / 6.28 - 0.5) * 44,
            (home ? home.rect.y + home.rect.h : spot.y) + 16 + Math.floor((jitter[1] / 6.28) * 3) * 18,
            e.kind === 'use' ? 2 : 0.8,
          );
        }
      }
    }
    if (quiet(e)) return;
    if (moving ? start !== undefined && to !== undefined && !!e.resource && !!e.resourceId : actor !== undefined) shown.push(e.t);

    if (e.kind !== 'send' || !e.resource || from === undefined || to === undefined) return;
    const key = from * units.length + to;
    let lane = laneMap.get(key);
    if (!lane) {
      lane = {
        key: `${e.from}>${e.to}`,
        from: e.from!,
        to: e.to!,
        a: from,
        b: to,
        times: [],
        types: [],
        back: [],
        pullA: pull(from, to),
        pullB: pull(to, from),
        count: perResource(),
        total: 0,
        returns: 0,
      };
      laneMap.set(key, lane);
    }
    lane.times.push(e.t);
    lane.types.push(RESOURCES.indexOf(e.resource));
    lane.back.push(e.isReturn);
    lane.count[e.resource]++;
    lane.total++;
    if (e.isReturn) lane.returns++;
  });
  const lanes = [...laneMap.values()];
  const shownTimes = Float64Array.from(shown);

  const partnerMap = new Map<string, Partners>();
  const partnersOf = (id: string) => {
    let entry = partnerMap.get(id);
    if (!entry) partnerMap.set(id, (entry = { out: [], in: [], ids: new Set() }));
    return entry;
  };
  for (const lane of lanes) {
    const giver = partnersOf(lane.from);
    giver.out.push(lane);
    giver.ids.add(lane.to);
    const taker = partnersOf(lane.to);
    taker.in.push(lane);
    taker.ids.add(lane.from);
  }
  for (const entry of partnerMap.values()) {
    entry.out.sort((a, b) => b.total - a.total);
    entry.in.sort((a, b) => b.total - a.total);
  }
  const barnSpans = units.map((u, i) => {
    if (!layout.barn || u.group !== layout.barn.group) return null;
    const spans: [number, number][] = [...unitTimes[i].map((t): [number, number] => [t, t]), ...(cargo?.times(i) ?? []).map((t): [number, number] => [t, t]), ...agents.list.filter((m) => m.owner === i).map((m): [number, number] => [m.session.start, m.session.end])].sort((a, b) => a[0] - b[0]);
    const starts: number[] = [];
    const ends: number[] = [];
    for (const [from, to] of spans) {
      if (ends.length && from <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], to);
      else {
        starts.push(from);
        ends.push(to);
      }
    }
    return { starts, ends };
  });
  const afield = (i: number, time: number, life: number) => {
    const spans = barnSpans[i];
    if (!spans) return 1;
    const j = upperBound(spans.starts, time) - 1;
    const since = j >= 0 ? Math.max(0, time - spans.ends[j]) : Infinity;
    const until = j + 1 < spans.starts.length ? spans.starts[j + 1] - time : Infinity;
    const walk = Math.max(1, life * 1.5);
    return clamp(Math.max(1 - (since - life * 4) / walk, 1 - (until - life * 0.5) / walk), 0, 1);
  };

  const partners = (id: string): Partners => partnerMap.get(id) ?? { out: [], in: [], ids: new Set() };

  const moves = replay.applicants?.moves ?? [];
  const moveTimes = Float64Array.from(moves, ([t]) => t);
  const applicantsAt = (t: number): ApplicantState | null => {
    if (!replay.applicants) return null;
    const out = { stages: [...replay.applicants.base], applied: [...(replay.applicants.crafts ?? [0, 0, 0, replay.applicants.base[0]])], hired: 0, passed: 0 };
    const n = upperBound(moveTimes, t);
    for (let i = 0; i < n; i++) {
      const [, from, to, craft = CRAFTS.length] = moves[i];
      if (from === 0) out.applied[craft]--;
      if (to === 0) out.applied[craft]++;
      if (from >= 0) out.stages[from]--;
      if (to >= 0) out.stages[to]++;
      else if (to === HIRED) out.hired++;
      else out.passed++;
    }
    return out;
  };

  const artifacts = [...replay.artifacts]
    .sort((a, b) => a.t - b.t)
    .map((a) => ({ id: a.id, kind: a.kind, name: a.name, region: place(a.region, a.unit), unit: a.unit, t: a.t }));
  const artifactTimes = Float64Array.from(artifacts, (a) => a.t);
  const opened = openingTrophies(opening);

  const marks = [...agents.list.flatMap((m) => [m.session.start, m.session.end]), ...artifactTimes, ...moveTimes];
  const loud = events.filter((e) => !quiet(e)).map((e) => e.t);
  const moments = new Float64Array(loud.length + marks.length);
  moments.set(loud);
  moments.set(marks, loud.length);
  moments.sort();

  function prevEventTime(t: number) {
    const i = upperBound(moments, t) - 1;
    return i >= 0 ? moments[i] : -Infinity;
  }

  function nextEventTime(t: number) {
    const i = upperBound(moments, t);
    return i < moments.length ? moments[i] : Infinity;
  }

  function inMotion(t: number, speed: number) {
    const i = upperBound(shownTimes, t) - 1;
    return i >= 0 && shownTimes[i] > t - lifeMs(speed);
  }

  const attending: { meeting: string; start: number; end: number }[][] = calendar.spans.map((list) => {
    const out: { meeting: string; start: number; end: number }[] = [];
    list.forEach((span, j) => {
      if (!span.meeting) return;
      const end = Math.min(span.end, list[j + 1]?.start ?? Infinity);
      if (end - span.start < MIN_SITTING) return;
      for (let k = 0; k < j; k++) if (list[k].kind === 'ooo' && list[k].end > span.start) return;
      out.push({ meeting: span.meeting, start: span.start, end });
    });
    return out;
  });
  const members = new Map<string, { list: number[]; start: number; end: number }>();
  attending.forEach((list, i) => {
    for (const span of list) {
      const entry = members.get(span.meeting);
      if (!entry) members.set(span.meeting, { list: [i], start: span.start, end: span.end });
      else {
        if (!entry.list.includes(i)) entry.list.push(i);
        entry.start = Math.min(entry.start, span.start);
        entry.end = Math.max(entry.end, span.end);
      }
    }
  });
  const squareRegion = layout.buildings.find((b) => b.id === 'meet')?.region;
  const spots = new Map<string, Map<number, Point>>();
  const tables = new Map<string, { x: number; y: number; size: MeetingState['size'] }>();
  const placed: { x: number; y: number; reach: number; start: number; end: number }[] = [];
  const crowd = [...members].filter(([, entry]) => entry.list.length >= 2).sort((p, q) => q[1].list.length - p[1].list.length || p[1].start - q[1].start || p[0].localeCompare(q[0]));
  for (const [id, { list, start, end }] of crowd) {
    const size: MeetingState['size'] = list.length <= 4 ? 'small' : list.length <= 8 ? 'medium' : 'large';
    const rings: { reach: number; count: number }[] = [];
    for (let left = list.length, reach = TABLE_RADIUS[size] + TABLE_GAP; left > 0; reach += SEAT_ROW) {
      const count = Math.min(left, Math.max(1, Math.floor((2 * Math.PI * reach) / SEAT_ARC)));
      rings.push({ reach, count });
      left -= count;
    }
    const outer = rings[rings.length - 1].reach + radius;
    let cx = 0;
    let cy = 0;
    for (const i of list) {
      cx += units[i].x;
      cy += units[i].y;
    }
    cx /= list.length;
    cy /= list.length;
    const turn = shadeOf(id) * 1.3;
    const guest = outdoors.has(id) ? list.find((i) => units[i].kind === 'prospect') : undefined;
    if (guest !== undefined) ({ x: cx, y: cy } = whereabouts(guest, start, 0));
    const plaza = guest === undefined && !!layout.square && list.some((i) => units[i].region === squareRegion);
    if (plaza) {
      cx = layout.square!.x + layout.square!.w / 2;
      cy = layout.square!.y + layout.square!.h / 2;
    }
    const rect = guest === undefined ? regionRects.get(plaza ? squareRegion! : units[list[0]].region) : undefined;
    const fit = () => {
      if (!rect) return;
      cx = rect.w > outer * 2 ? clamp(cx, rect.x + outer, rect.x + rect.w - outer) : rect.x + rect.w / 2;
      cy = rect.h > outer * 2 ? clamp(cy, rect.y + outer, rect.y + rect.h - outer) : rect.y + rect.h / 2;
    };
    fit();
    const rivals = placed.filter((other) => other.start < end + MIN_SITTING && other.end + MIN_SITTING > start);
    const clear = () => rivals.every((other) => Math.hypot(cx - other.x, cy - other.y) >= outer + other.reach + MEETING_GAP);
    let loose = false;
    if (!clear()) {
      const ox = cx;
      const oy = cy;
      const step = TABLE_GAP / 2;
      const bounds = layout.bounds;
      const seek = (free: boolean, limit: number) => {
        for (let r = step; r < limit; r += step) {
          const n = Math.max(8, Math.ceil((Math.PI * r) / step));
          for (let k = 0; k < n; k++) {
            const angle = turn + (k * 2 * Math.PI) / n;
            cx = ox + Math.cos(angle) * r;
            cy = oy + Math.sin(angle) * r;
            if (free) {
              cx = clamp(cx, bounds.x + outer, bounds.x + bounds.w - outer);
              cy = clamp(cy, bounds.y + outer, bounds.y + bounds.h - outer);
            } else fit();
            if (clear()) return true;
          }
        }
        return false;
      };
      if (!(rect && seek(false, Math.hypot(rect.w, rect.h)))) {
        loose = seek(true, Math.hypot(bounds.w, bounds.h));
        if (!loose) {
          cx = ox;
          cy = oy;
        }
      }
    }
    placed.push({ x: cx, y: cy, reach: outer, start, end });
    const chairs: { angle: number; reach: number }[] = [];
    rings.forEach((ring, r) => {
      for (let k = 0; k < ring.count; k++) {
        const raw = turn + r * 0.5 + (k * 2 * Math.PI) / ring.count;
        chairs.push({ angle: Math.atan2(Math.sin(raw), Math.cos(raw)), reach: ring.reach });
      }
    });
    chairs.sort((p, q) => p.angle - q.angle);
    const order = [...list].sort((p, q) => Math.atan2(units[p].y - cy, units[p].x - cx) - Math.atan2(units[q].y - cy, units[q].x - cx));
    const seats = new Map<number, Point>();
    order.forEach((i, k) => {
      const chair = chairs[k];
      const seat = { x: cx + Math.cos(chair.angle) * chair.reach, y: cy + Math.sin(chair.angle) * chair.reach };
      seats.set(i, guest === undefined && !loose ? within(i, seat.x, seat.y) : seat);
    });
    spots.set(id, seats);
    tables.set(id, { x: cx, y: cy, size });
  }

  const callers = new Set<number>();
  units.forEach((u, i) => {
    for (const [t, by] of u.visits ?? []) {
      const caller = idx(by);
      if (caller === undefined) continue;
      const p = whereabouts(i, t, 0);
      trip(caller, t, p.x + 18, p.y + 10, 1, true);
      callers.add(caller);
    }
  });
  for (const [t, level, by] of replay.applicants?.visits ?? []) {
    const caller = idx(by);
    const yard = layout.grounds?.yards[level];
    if (caller === undefined || !yard) continue;
    trip(caller, t, yard.x + yard.w * (0.3 + (phases[caller][0] / 6.28) * 0.4), yard.y + yard.h * 0.62, 1, true);
    callers.add(caller);
  }
  for (const i of callers) {
    const order = tripT[i].map((_, k) => k).sort((a, b) => tripT[i][a] - tripT[i][b]);
    for (const list of [tripT, tripX, tripY, tripW, tripFree]) list[i] = order.map((k) => list[i][k]);
  }

  function sitting(i: number, time: number, early: number, sit: (seat: Point, ease: number, meeting: string) => void) {
    let free = -Infinity;
    for (const span of attending[i]) {
      if (span.start > time + early) break;
      const seat = spots.get(span.meeting)?.get(i);
      if (!seat) continue;
      const walk = Math.min(early, (span.end - span.start) * 0.25);
      const from = Math.max(span.start - walk, free);
      free = span.end;
      if (time <= from || time >= span.end + walk) continue;
      sit(seat, smooth(clamp(Math.min(time - from, span.end + walk - time) / walk, 0, 1)), span.meeting);
    }
  }

  function whereabouts(i: number, time: number, life: number): Point {
    const p = standing(i, time, life);
    const k = smooth(afield(i, time, life));
    return k < 1 && layout.barn ? { x: layout.barn.x + (p.x - layout.barn.x) * k, y: layout.barn.y + (p.y - layout.barn.y) * k } : p;
  }

  function standing(i: number, time: number, life: number): Point {
    const u = units[i];
    if (u.kind === 'recruit' && u.spots?.length) {
      const stages = u.stages ?? [];
      const toward = (from: Point, to: Point, k: number): Point => ({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
      let k = Math.min(stages.length, u.spots.length) - 1;
      while (k > 0 && stages[k][0] > time) k--;
      let p = u.spots[Math.max(0, k)];
      const moved = k >= 0 ? (time - stages[k][0]) / TRANSIT : 1;
      if (moved < 1) p = toward(k > 0 ? u.spots[k - 1] : layout.grounds?.posts[0] ?? p, p, smooth(clamp(moved, 0, 1)));
      const home = u.into ? regionRects.get(u.into) : undefined;
      if (home && u.until !== undefined && u.until - time < TRANSIT) {
        p = toward(p, { x: home.x + home.w / 2, y: home.y + home.h / 2 }, smooth(clamp(1 - (u.until - time) / TRANSIT, 0, 1)));
      }
      return p;
    }
    if (u.kind === 'prospect') {
      const [a, b, c] = phases[i];
      const s = time / ROAM;
      const strata = layout.strata;
      const all = strata?.core ?? layout.bounds;
      const stages = u.stages;
      if (!stages?.length || !strata) {
        return {
          x: all.x + all.w * (0.5 + 0.46 * Math.sin(s * c + a) * Math.cos(s * 0.37 * c + b)),
          y: all.y + all.h * (0.5 + 0.46 * Math.sin(s * 0.71 * c + b) * Math.cos(s * 0.23 + a)),
        };
      }
      const stroll = (a / 6.28 + s * 0.03 * c) % 2;
      const at = (level: number): Point => {
        if (level >= 0) {
          return {
            x: all.x - strata.gap - strata.band * (LEAD_STAGES.length - level - 0.2 - (b / 6.28) * 0.6),
            y: strata.top + strata.height * (0.07 + 0.88 * (stroll < 1 ? stroll : 2 - stroll)),
          };
        }
        const cell = level <= DREAMING ? strata.heaven : strata.jail;
        const float = level <= DREAMING ? 1 : 0;
        return {
          x: cell.x + cell.w * (0.06 + 0.88 * (((a * 7.31) % 6.28) / 6.28)) + float * Math.sin(s * 3 * c + b) * 14,
          y: cell.y + cell.h * (0.24 + 0.64 * (b / 6.28)) + float * Math.cos(s * 2.3 * c + a) * 10,
        };
      };
      const toward = (from: Point, to: Point, k: number): Point => ({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
      let k = stages.length - 1;
      while (k > 0 && stages[k][0] > time) k--;
      let p = at(stages[k][1]);
      const moved = (time - stages[k][0]) / TRANSIT;
      if (moved < 1) p = toward(k > 0 ? at(stages[k - 1][1]) : { x: p.x - (stages[k][1] < 0 ? 0 : strata.band), y: p.y }, p, smooth(clamp(moved, 0, 1)));
      const home = u.into ? regionRects.get(u.into) : undefined;
      if (home && u.until !== undefined && u.until - time < TRANSIT) {
        p = toward(p, { x: home.x + home.w / 2, y: home.y + home.h / 2 }, smooth(clamp(1 - (u.until - time) / TRANSIT, 0, 1)));
      }
      sitting(i, time, TRANSIT, (seat, ease) => (p = toward(p, seat, ease)));
      return p;
    }
    const rise = life * 1.5;
    const fall = life * 2.2;
    const times = tripT[i];
    let weight = 1;
    let roam = 0;
    let awayX = 0;
    let awayY = 0;
    let x = u.x;
    let y = u.y;
    for (let j = upperBound(times, time + rise) - 1; j >= 0; j--) {
      const since = time - times[j];
      if (since > fall * 6) break;
      const g = tripW[i][j] * (since >= 0 ? Math.exp(-since / fall) : smooth(1 + since / rise));
      if (tripFree[i][j]) {
        roam += g;
        awayX += tripX[i][j] * g;
        awayY += tripY[i][j] * g;
        continue;
      }
      x += tripX[i][j] * g;
      y += tripY[i][j] * g;
      weight += g;
    }
    x /= weight;
    y /= weight;
    let outside: Point | null = null;
    let out = 0;
    sitting(i, time, life * 0.6, (seat, ease, meeting) => {
      if (outdoors.has(meeting)) {
        outside = seat;
        out = ease;
        return;
      }
      x += (seat.x - x) * ease;
      y += (seat.y - y) * ease;
    });
    const phase = phases[i];
    const sway = (time / life) * 1.2;
    const swayX = Math.sin(sway * phase[2] + phase[0]) * WANDER;
    const swayY = Math.cos(sway * 0.83 * phase[2] + phase[1]) * WANDER;
    let p = within(i, x + swayX, y + swayY);
    if (roam) {
      const away = smooth(Math.min(1, roam * 2));
      p = { x: p.x + (awayX / roam + swayX - p.x) * away, y: p.y + (awayY / roam + swayY - p.y) * away };
    }
    const seat = outside as Point | null;
    if (seat) p = { x: p.x + (seat.x - p.x) * out, y: p.y + (seat.y - p.y) * out };
    const list = fetches[i];
    if (life > 0 && list.t.length) {
      const lead = life * 1.5;
      let sum = 0;
      let top = 0;
      let fx = 0;
      let fy = 0;
      let seen = 0;
      for (let j = upperBound(list.t, time + lead) - 1; j >= 0 && seen < 16; j--, seen++) {
        const dt = time - list.t[j];
        if (dt > life * 2.5) break;
        const drop = !Number.isNaN(list.dx[j]);
        let k = 1;
        let s = 0;
        if (dt < 0) k = smooth(1 + dt / lead);
        else if (dt < life) {
          if (drop) s = smooth(dt / life);
          else k = 1 - smooth(dt / life);
        } else if (drop) {
          k = 1 - smooth((dt - life) / (life * 1.5));
          s = 1;
        } else continue;
        if (k <= 0) continue;
        sum += k;
        top = Math.max(top, k);
        fx += k * (drop ? list.x[j] + (list.dx[j] - list.x[j]) * s : list.x[j]);
        fy += k * (drop ? list.y[j] + (list.dy[j] - list.y[j]) * s : list.y[j]);
      }
      if (sum > 0) p = { x: p.x + (fx / sum - p.x) * top, y: p.y + (fy / sum - p.y) * top };
    }
    const hauling = cargo ? cargo.walk(i, time, life, HAUL) : 0;
    return hauling > 0 ? { x: p.x + (HAUL.x - p.x) * hauling, y: p.y + (HAUL.y - p.y) * hauling } : p;
  }

  function state(t: number, speed: number): SimState {
    const life = lifeMs(speed);
    const tau = tauMs(speed);
    const horizon = t - GLOW_HORIZON * tau;

    const holding = holdingsAt(t);
    const busy = busyAt(t);
    const gathered = new Map<string, number[]>();
    const sitting = new Map<string, number>();
    const unitStates: UnitState[] = units.map((u, i) => {
      const now = busy(i);
      for (const span of attending[i]) {
        if (span.start > t) break;
        if (t >= span.end || !spots.has(span.meeting)) continue;
        const list = gathered.get(span.meeting);
        if (list) list.push(i);
        else gathered.set(span.meeting, [i]);
        sitting.set(span.meeting, Math.max(sitting.get(span.meeting) ?? 0, Math.min(t - span.start, span.end - t)));
      }
      const { x, y } = whereabouts(i, t, life);
      const own = unitTimes[i];
      let activity = 0;
      for (let j = upperBound(own, t) - 1; j >= 0 && own[j] > horizon; j--) {
        activity += Math.exp(-(t - own[j]) / tau);
      }
      return {
        id: u.id,
        x,
        y,
        dx: x - u.x,
        dy: y - u.y,
        activity: 1 - Math.exp(-activity),
        holding: holding(i),
        busy: now?.kind ?? null,
        ...((u.since !== undefined && t < u.since) || (u.until !== undefined && t >= u.until) || afield(i, t, life) <= 0 ? { hidden: true } : {}),
      };
    });
    const packs = new Map<string, number[]>();
    units.forEach((u, i) => {
      if (unitStates[i].hidden) return;
      let key = u.group ?? u.region;
      if (u.kind === 'recruit' || u.kind === 'prospect') {
        const stages = u.stages ?? [];
        let k = stages.length - 1;
        while (k > 0 && stages[k][0] > t) k--;
        const level = k >= 0 ? stages[k][1] : 0;
        key = `${u.region}/${u.kind === 'recruit' ? Math.max(1, level) : level}`;
      }
      key += `|${u.kind}|${u.role}`;
      if (u.kind === 'prospect') key += `|${u.origin ?? ''}`;
      const list = packs.get(key);
      if (list) list.push(i);
      else packs.set(key, [i]);
    });
    const crowds: CrowdState[] = [];
    for (const [id, list] of packs) {
      if (list.length <= CROWD) continue;
      let x = 0;
      let y = 0;
      for (const i of list) {
        x += unitStates[i].x / list.length;
        y += unitStates[i].y / list.length;
        unitStates[i].hidden = true;
      }
      const yard = units[list[0]].kind === 'recruit' ? layout.grounds?.yards.findIndex((r) => x >= r.x && x <= r.x + r.w) ?? -1 : -1;
      if (yard >= 0) ({ x, y } = layout.grounds!.posts[yard]);
      crowds.push({ id, kind: units[list[0]].kind, role: units[list[0]].role, origin: units[list[0]].origin, x, y, count: list.length, members: list.map((i) => units[i].id) });
    }
    const applied = layout.grounds?.posts[0];
    const waiting = (applicantsAt(t)?.applied ?? []).map((count, i) => ({ role: CRAFTS[i] ?? ('recruit' as const), count })).filter((c) => c.count > 0);
    const cols = waiting.length > 2 ? 2 : 1;
    const rows = Math.ceil(waiting.length / cols);
    if (applied)
      waiting.forEach((c, i) =>
        crowds.push({
          id: `applied/${c.role}`,
          kind: 'recruit',
          role: c.role,
          x: applied.x + ((i % cols) - (cols - 1) / 2) * 180,
          y: applied.y + (Math.floor(i / cols) - (rows - 1) / 2) * 84,
          count: c.count,
        }),
      );
    const meetings: MeetingState[] = [];
    for (const [id, list] of gathered) {
      const table = tables.get(id);
      if (list.length < 2 || !table) continue;
      meetings.push({
        id,
        x: table.x,
        y: table.y,
        size: table.size,
        radius: TABLE_RADIUS[table.size],
        alpha: smooth(clamp((sitting.get(id) ?? 0) / (life * 0.3), 0, 1)),
        members: list.map((i) => ({ id: units[i].id, x: unitStates[i].x, y: unitStates[i].y })),
      });
    }
    const alive = agents.aliveAt(t, life);
    const towed = new Map<number, Point>();
    for (const i of alive) {
      const m = agents.list[i];
      const behind = whereabouts(m.owner, t - life * (0.16 + 0.07 * (i % 5)), life);
      towed.set(i, { x: behind.x + m.ox, y: behind.y + m.oy });
    }
    const anchor = (i: number): Anchor => ({ id: units[i].id, x: unitStates[i].x, y: unitStates[i].y });
    const acting = (unit: number, agent: number): Anchor => {
      const m = agent >= 0 ? agents.list[agent] : undefined;
      if (!m || m.owner !== unit) return anchor(unit);
      const at = towed.get(agent);
      return { id: units[unit].id, x: at ? at.x : unitStates[unit].x + m.ox, y: at ? at.y : unitStates[unit].y + m.oy };
    };

    const agentStates: AgentState[] = alive.map((i) => {
      const { session } = agents.list[i];
      const brief = session.end - session.start < life;
      return {
        id: session.id,
        owner: session.owner,
        tool: session.tool,
        parent: session.parent,
        x: towed.get(i)!.x,
        y: towed.get(i)!.y,
        active: brief || session.active.some(([from, to]) => from <= t && t < to),
        ageMs: t - session.start,
        remainingMs: Math.max(session.end, session.start + life) - t,
      };
    });

    const flights: FlightState[] = [];
    const pulses: PulseState[] = [];
    const rings: RingState[] = [];
    const hi = upperBound(times, t);
    for (let i = upperBound(times, t - life); i < hi; i++) {
      const e = events[i];
      const progress = (t - e.t) / life;
      const by = via[i];
      const viaId = by >= 0 ? e.via : null;
      if (e.kind === 'use' || e.kind === 'run' || e.kind === 'error') {
        const a = idx(e.actor);
        const f = e.feature ? featureIndex.get(e.feature) : undefined;
        if (e.kind !== 'use' || a === undefined || f === undefined) continue;
        const from = acting(a, by);
        const cell = layout.features[f];
        const to: Anchor = { id: cell.building, x: cell.x, y: cell.y };
        pulses.push({ source: e.source, feature: cell.id, from, to, ...along(from, to, progress), progress, count: e.count, via: viaId });
        continue;
      }
      if (e.kind === 'send' || e.kind === 'assign') {
        const a = idx(e.kind === 'send' ? e.from : e.actor);
        const b = idx(e.to);
        if (a === undefined || b === undefined || !e.resource || !e.resourceId) continue;
        const from = acting(a, by);
        const to = anchor(b);
        flights.push({
          kind: e.kind,
          resource: e.resource,
          resourceId: e.resourceId,
          shade: shades[i],
          from,
          to,
          ...along(from, to, progress),
          progress,
          isReturn: e.isReturn,
          via: viaId,
          trace: e.trace,
        });
        continue;
      }
      const actor = idx(e.actor);
      if (actor === undefined) continue;
      const holder = idx(e.to);
      const at = e.kind === 'done' && holder !== undefined ? holder : actor;
      const abroad = abroadSpot(e, i, actor);
      const doer: Anchor = abroad ? { id: e.region!, x: abroad.x, y: abroad.y } : acting(actor, by);
      const spot = at === actor ? doer : anchor(at);
      const spec = RING[e.kind];
      if (!abroad || e.kind === 'status') rings.push({
        kind: e.kind,
        at: units[at].id,
        actor: e.actor,
        x: spot.x,
        y: spot.y,
        radius: radius + spec.base + spec.grow * progress,
        alpha: 1 - progress,
        progress,
        angle: (i * 2.399963) % (Math.PI * 2),
        count: e.count,
        resource: e.resource,
        status: e.status ?? null,
        via: viaId,
        trace: e.trace,
      });
      if (e.kind === 'create' && e.resource && e.resourceId) {
        const origin = sourceOf(e);
        if (origin) {
          const from: Anchor = { id: origin.id, x: origin.x, y: origin.y };
          const carried = fetched[i] && !unitStates[actor].hidden;
          const relay = abroad && units[actor].kind === 'automation' && !unitStates[actor].hidden ? acting(actor, by) : null;
          flights.push({
            kind: 'spawn',
            resource: e.resource,
            resourceId: e.resourceId,
            shade: shades[i],
            from,
            to: doer,
            ...(carried
              ? { x: unitStates[actor].x, y: unitStates[actor].y - radius - 7 }
              : relay
                ? progress < 0.5
                  ? along(from, relay, progress * 2)
                  : along(relay, doer, progress * 2 - 1)
                : along(from, doer, progress)),
            progress,
            isReturn: false,
            via: viaId,
            trace: e.trace,
          });
        }
      }
    }

    const arrive = (id: string, since: number | undefined, x: number, y: number, reach: number) => {
      if (since === undefined || since <= replay.window.start || since > t || t - since >= life * ARRIVAL) return;
      const progress = (t - since) / (life * ARRIVAL);
      rings.push({ kind: 'done', at: id, actor: id, x, y, radius: radius + RING.done.base + reach * progress, alpha: 1 - progress, progress, angle: 0, count: 1, resource: null, status: null, via: null });
    };
    units.forEach((u, i) => {
      if ((u.kind !== 'prospect' && u.kind !== 'recruit') || unitStates[i].hidden) return;
      for (const [since] of u.stages ?? [[u.since ?? 0, 0]]) arrive(u.id, since, unitStates[i].x, unitStates[i].y, 30);
      for (const [since] of u.visits ?? []) arrive(u.id, since, unitStates[i].x, unitStates[i].y, 16);
    });
    for (const r of layout.regions) arrive(r.id, r.since, r.rect.x + r.rect.w / 2, r.rect.y + r.rect.h / 2, Math.max(r.rect.w, r.rect.h) * 0.6);

    const trophies: TrophyState[] = opened.slice();
    const landed = upperBound(artifactTimes, t);
    for (let i = 0; i < landed; i++) {
      const a = artifacts[i];
      trophies.push({ id: a.id, kind: a.kind, name: a.name, region: a.region, unit: a.unit, ageMs: t - a.t });
    }

    const span = life * 2;
    const features: FeatureState[] = layout.features.map((f, i) => ({
      id: f.id,
      use: sumAt(i * 3, t) - sumAt(i * 3, t - span),
      run: sumAt(i * 3 + 1, t) - sumAt(i * 3 + 1, t - span),
      error: sumAt(i * 3 + 2, t) - sumAt(i * 3 + 2, t - span),
      total: sumAt(i * 3, t) + sumAt(i * 3 + 1, t),
      errors: sumAt(i * 3 + 2, t),
    }));

    return {
      t,
      speed,
      lifeMs: life,
      tauMs: tau,
      tick: tick(t),
      units: unitStates,
      crowds,
      stabled: units.flatMap((u, i) => {
        const spans = barnSpans[i];
        return spans && afield(i, t, life) <= 0 ? [{ id: u.id, next: spans.starts[upperBound(spans.starts, t)] ?? null }] : [];
      }),
      agents: agentStates,
      flights,
      rings,
      counters: countersAt(t),
      trophies,
      applicants: applicantsAt(t),
      meetings,
      features,
      pulses,
      inMotion: flights.length > 0 || rings.length > 0 || pulses.length > 0,
    };
  }

  function bins(start: number, end: number, binMs: number) {
    const counts = new Array<number>(Math.max(1, Math.ceil((end - start) / binMs))).fill(0);
    for (const e of events) {
      if (quiet(e)) continue;
      const b = Math.floor((e.t - start) / binMs);
      if (b >= 0 && b < counts.length) counts[b]++;
    }
    return counts;
  }

  return {
    lanes,
    state,
    lifeMs,
    inMotion,
    prevEventTime,
    nextEventTime,
    bins,
    partners,
    held: (id: string, t: number) => {
      const unit = layout.index.get(id);
      return unit === undefined ? [] : holdingsAt.items(unit, t);
    },
    applied: (role: string, t: number) => {
      const craft = (CRAFTS as readonly string[]).indexOf(role);
      return (replay.applicants?.people ?? []).filter(([, c, from, until]) => c === (craft < 0 ? CRAFTS.length : craft) && from <= t && (until === null || until > t)).map(([name]) => name);
    },
    selfcheck: () => runSelfcheck(state, replay.window),
  };
}
