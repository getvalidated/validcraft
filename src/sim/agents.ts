import type { Session } from '../schema';
import type { Layout } from '../seam';
import { upperBound } from './search';

const EVERY = 64;
const LINGER_MAX = 60 * 60_000;

export interface Agent {
  session: Session;
  owner: number;
  ox: number;
  oy: number;
}

export function createAgents(all: Session[], layout: Layout) {
  const kept = all
    .filter((s) => layout.index.has(s.owner))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const busy = new Map<number, number[]>();
  const list: Agent[] = kept.map((session) => {
    const owner = layout.index.get(session.owner)!;
    const unit = layout.units[owner];
    let ends = busy.get(owner);
    if (!ends) busy.set(owner, (ends = []));
    let slot = ends.findIndex((end) => end <= session.start);
    if (slot < 0) slot = ends.length;
    ends[slot] = session.end;
    const seat = unit.slots.length ? unit.slots[slot % unit.slots.length] : unit;
    return { session, owner, ox: seat.x - unit.x, oy: seat.y - unit.y };
  });
  const byId = new Map(list.map((m, i) => [m.session.id, i]));

  const marks: { t: number; i: number; on: boolean }[] = [];
  list.forEach(({ session }, i) => {
    marks.push({ t: session.start, i, on: true }, { t: Math.max(session.end, session.start + LINGER_MAX), i, on: false });
  });
  marks.sort((a, b) => a.t - b.t);
  const times = Float64Array.from(marks, (m) => m.t);
  const snapshots: Int32Array[] = [new Int32Array(0)];
  const running = new Set<number>();
  marks.forEach((mark, k) => {
    if (mark.on) running.add(mark.i);
    else running.delete(mark.i);
    if ((k + 1) % EVERY === 0) snapshots.push(Int32Array.from(running));
  });

  function aliveAt(t: number, linger: number) {
    const hold = Math.min(linger, LINGER_MAX);
    const n = upperBound(times, t);
    const base = Math.floor(n / EVERY);
    const alive = new Set<number>(snapshots[base]);
    for (let k = base * EVERY; k < n; k++) {
      if (marks[k].on) alive.add(marks[k].i);
      else alive.delete(marks[k].i);
    }
    return [...alive].filter((i) => t < Math.max(list[i].session.end, list[i].session.start + hold)).sort((a, b) => a - b);
  }

  function liveAt(id: string | null, t: number) {
    const i = id ? byId.get(id) : undefined;
    if (i === undefined) return -1;
    const { start, end } = list[i].session;
    return start <= t && t < end ? i : -1;
  }

  return { list, aliveAt, liveAt };
}
