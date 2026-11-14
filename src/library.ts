import type { Cargo } from './cargo';
import type { Replay, ReplayRef } from './schema';
import type { Layout, Sim } from './seam';
import { createSim } from './sim';
import { sumTotals } from './sim/opening';
import { upperBound } from './sim/search';

const NEAR = 1;
const PREFETCH_MS = 400;

export interface Chunk {
  index: number;
  ref: ReplayRef;
  data: Replay;
  sim: Sim;
}

export interface Library {
  refs: ReplayRef[];
  start: number;
  end: number;
  sim: Sim;
  indexAt(t: number): number;
  active(): Chunk;
  chunk(i: number): Chunk | null;
  loaded(): Chunk[];
  ready(t: number): boolean;
  focus(i: number): void;
  onChange(listener: (chunk: Chunk) => void): void;
  onLoad(listener: (chunk: Chunk) => void): void;
}

export function createLibrary(refs: ReplayRef[], layout: Layout, load: (ref: ReplayRef) => Promise<Replay | null>, first: { index: number; data: Replay }, cargo: Cargo | null = null): Library {
  const starts = Float64Array.from(refs, (r) => r.start);
  const chunks = new Map<number, Chunk>();
  const pending = new Map<number, Promise<Chunk | null>>();
  const failed = new Set<number>();
  const listeners: ((chunk: Chunk) => void)[] = [];
  const loads: ((chunk: Chunk) => void)[] = [];
  const indexAt = (t: number) => Math.min(refs.length - 1, Math.max(0, upperBound(starts, t) - 1));
  const build = (i: number, data: Replay) => {
    const chunk: Chunk = { index: i, ref: refs[i], data, sim: createSim(data, layout, sumTotals(refs.slice(0, i).map((r) => r.totals ?? [])), cargo) };
    chunks.set(i, chunk);
    for (const listener of loads) listener(chunk);
    return chunk;
  };
  let current = build(first.index, first.data);
  let want = first.index;
  const keep = (i: number) => Math.abs(i - want) <= NEAR || i === current.index;

  function ensure(i: number): Promise<Chunk | null> {
    const have = chunks.get(i);
    if (have) return Promise.resolve(have);
    let job = pending.get(i);
    if (!job) {
      job = load(refs[i]).then((data) => {
        pending.delete(i);
        if (!data) failed.add(i);
        return data && keep(i) ? build(i, data) : null;
      });
      pending.set(i, job);
    }
    return job;
  }

  function prefetch(i: number) {
    setTimeout(() => {
      for (const j of [i + 1, i - 1]) if (j >= 0 && j < refs.length && want === i) ensure(j);
    }, PREFETCH_MS);
  }

  function focus(i: number) {
    if (i === want) return;
    want = i;
    ensure(i).then((chunk) => {
      if (!chunk || want !== i) return;
      if (current !== chunk) {
        current = chunk;
        for (const listener of listeners) listener(chunk);
      }
      for (const j of chunks.keys()) if (!keep(j)) chunks.delete(j);
      prefetch(i);
    });
  }

  const at = (t: number) => chunks.get(indexAt(t));

  const sim: Sim = {
    get lanes() {
      return current.sim.lanes;
    },
    state(t, speed) {
      const chunk = at(t);
      if (chunk) return chunk.sim.state(t, speed);
      return current.sim.state(Math.min(current.ref.end, Math.max(current.ref.start, t)), speed);
    },
    lifeMs: (speed) => current.sim.lifeMs(speed),
    held: (id, t) => (at(t) ?? current).sim.held(id, t),
    applied: (role, t) => (at(t) ?? current).sim.applied(role, t),
    inMotion: (t, speed) => at(t)?.sim.inMotion(t, speed) ?? false,
    nextEventTime(t) {
      let best = Infinity;
      for (let i = indexAt(t); i < refs.length && refs[i].start <= best; i++) {
        const chunk = chunks.get(i);
        if (!chunk) return failed.has(i) ? best : Math.min(best, Math.max(t, refs[i].start));
        best = Math.min(best, chunk.sim.nextEventTime(t));
      }
      return best;
    },
    prevEventTime(t) {
      let best = -Infinity;
      for (let i = indexAt(t); i >= 0 && refs[i].end >= best; i--) {
        const chunk = chunks.get(i);
        if (!chunk) return failed.has(i) ? best : Math.max(best, Math.min(t, refs[i].end));
        best = Math.max(best, chunk.sim.prevEventTime(t));
      }
      return best;
    },
    bins(start, end, binMs) {
      const out = new Array<number>(Math.max(1, Math.ceil((end - start) / binMs))).fill(0);
      refs.forEach((ref, i) => {
        if (ref.end <= start || ref.start >= end) return;
        const chunk = chunks.get(i);
        if (!ref.bins && chunk) return chunk.sim.bins(start, end, binMs).forEach((n, k) => (out[k] += n));
        const step = ref.binMs ?? 0;
        (ref.bins ?? []).forEach((n, k) => {
          const b = Math.floor((ref.start + k * step - start) / binMs);
          if (n && b >= 0 && b < out.length) out[b] += n;
        });
      });
      return out;
    },
    partners: (id) => current.sim.partners(id),
  };

  prefetch(first.index);

  return {
    refs,
    start: refs[0].start,
    end: refs[refs.length - 1].end,
    sim,
    indexAt,
    active: () => current,
    chunk: (i) => chunks.get(i) ?? null,
    loaded: () => [...chunks.values()].sort((a, b) => a.index - b.index),
    ready: (t) => chunks.has(indexAt(t)) || failed.has(indexAt(t)),
    focus,
    onChange: (listener) => listeners.push(listener),
    onLoad: (listener) => loads.push(listener),
  };
}
