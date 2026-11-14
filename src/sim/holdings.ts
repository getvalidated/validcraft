import type { Replay, ResourceType } from '../schema';
import type { PerResource } from '../seam';

export const RESOURCES: ResourceType[] = ['ticket', 'page', 'thread', 'pr', 'analysis', 'embedding', 'taxonomy', 'row', 'video', 'campaign', 'adset', 'ad', 'resume', 'setting', 'report', 'bill', 'email', 'call', 'doc', 'chat', 'image', 'board', 'review', 'comment', 'rival', 'post', 'trend', 'outreach', 'booking', 'incident', 'deploy', 'build', 'assignment', 'invite', 'ambassador', 'lead', 'referral'];
const STRIDE = RESOURCES.length;
const EVERY = 256;

export const perResource = (values: ArrayLike<number> = []): PerResource =>
  Object.fromEntries(RESOURCES.map((type, i) => [type, values[i] ?? 0])) as PerResource;

export const STALE_MS = 7 * 86_400_000;

export function createHoldings(replay: Replay, index: Map<string, number>, unitCount: number) {
  const size = unitCount * STRIDE;
  const slot = (id: string | null) => {
    const i = id ? index.get(id) : undefined;
    return i === undefined ? -1 : i;
  };

  const first = new Int32Array(size);
  const holder = new Map<string, number>();
  const moves: [t: number, key: string, after: number][] = [];
  const touched = new Map<string, number[]>();
  const touch = (key: string, t: number) => {
    const list = touched.get(key);
    if (list) list.push(t);
    else touched.set(key, [t]);
  };
  for (const h of replay.initial) {
    const unit = slot(h.holder);
    const key = `${h.resource}:${h.resourceId}`;
    holder.set(key, unit);
    moves.push([-Infinity, key, unit]);
    if (unit >= 0) first[unit * STRIDE + RESOURCES.indexOf(h.resource)]++;
    if (h.resource === 'video' && h.t !== undefined) touch(key, h.t);
  }

  const times: number[] = [];
  const cells: number[] = [];
  const deltas: number[] = [];
  const snapshots: Int32Array[] = [first];
  const running = Int32Array.from(first);
  const push = (t: number, cell: number, delta: number) => {
    times.push(t);
    cells.push(cell);
    deltas.push(delta);
    running[cell] += delta;
    if (times.length % EVERY === 0) snapshots.push(Int32Array.from(running));
  };

  const video = RESOURCES.indexOf('video');
  const steps: { t: number; key: string; type: number; after: number }[] = [];
  for (const e of replay.events) {
    if (!e.resource || !e.resourceId) continue;
    const key = `${e.resource}:${e.resourceId}`;
    if (e.resource === 'video') touch(key, e.t);
    const made = e.kind === 'create' && e.resource === 'video';
    if (e.kind !== 'send' && e.kind !== 'assign' && e.kind !== 'done' && !made) continue;
    steps.push({ t: e.t, key, type: RESOURCES.indexOf(e.resource), after: e.kind === 'done' ? -1 : slot(made ? e.actor : e.to) });
  }
  for (const [key, seen] of touched) {
    seen.sort((x, y) => x - y);
    seen.forEach((t, i) => {
      if (i === seen.length - 1 || seen[i + 1] - t > STALE_MS) steps.push({ t: t + STALE_MS, key, type: video, after: -1 });
    });
  }
  steps.sort((x, y) => x.t - y.t);
  for (const s of steps) {
    const before = holder.get(s.key) ?? -1;
    if (before === s.after) continue;
    if (before >= 0) push(s.t, before * STRIDE + s.type, -1);
    if (s.after >= 0) push(s.t, s.after * STRIDE + s.type, 1);
    holder.set(s.key, s.after);
    moves.push([s.t, s.key, s.after]);
  }

  const items = (unit: number, t: number) => {
    const now = new Map<string, number>();
    for (const [at, key, after] of moves) {
      if (at > t) break;
      now.set(key, after);
    }
    return [...now].filter(([, who]) => who === unit).map(([key]) => key);
  };

  const at = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    const base = Math.floor(lo / EVERY);
    const counts = Int32Array.from(snapshots[base]);
    for (let i = base * EVERY; i < lo; i++) counts[cells[i]] += deltas[i];
    return (unit: number): PerResource =>
      perResource(counts.subarray(unit * STRIDE, unit * STRIDE + STRIDE));
  };

  return Object.assign(at, { items });
}
