import { fmtDuration, pacificHour } from './format';
import type { Cargo } from './cargo';
import type { Library } from './library';
import type { Replay, ReplayRef, ResourceType, SourceName, Trace, TraceStage, WeekClosing } from './schema';
import type { Layout, Sim, SimState } from './seam';

export const MINUTE = 60_000;
export const SPEEDS = [1, 5, 20, 60];
export const DEFAULT_SPEED = 1;
export const NIGHT_SPEED = 20;
const DAY_HOURS = [8, 20];
export const speedAt = (t: number) => {
  const hour = pacificHour(t);
  return hour >= DAY_HOURS[0] && hour < DAY_HOURS[1] ? DEFAULT_SPEED : NIGHT_SPEED;
};
export const RESOLUTIONS = [0, 1, 1.5, 2, 3, 4];
export const RESOLUTION_KEY = 'rts.resolution';
export const NARROW = window.matchMedia('(max-width: 819.98px), (max-height: 519.98px)');
const IDLE_GAP_MS = 20 * MINUTE;

export type PickKind = 'unit' | 'region' | 'building' | 'barn' | 'store' | 'trace' | 'crowd';

export interface Pick {
  kind: PickKind;
  id: string;
  shelf?: 'concept' | 'creative' | 'brief' | 'retired';
  items?: TraceStage;
}

export interface Show {
  types: Record<ResourceType, boolean>;
  sources: Record<SourceName, boolean>;
  trail: boolean;
  regions: boolean;
  entities: boolean;
}

export interface View {
  t: number;
  speed: number;
  autoSpeed: boolean;
  playing: boolean;
  skipIdle: boolean;
  resolution: number;
  selected: string | null;
  picked: Pick | null;
  hover: string | null;
  scrubbing: boolean;
  show: Show;
}

export class App {
  skipNote: { text: string; until: number } | null = null;
  state: SimState | null = null;
  traces: Trace[] = [];
  cargo: Cargo | null = null;
  look: { trace: string; key: string; actor: string | null } | null = null;
  private selectListeners: ((pick: Pick | null) => void)[] = [];
  private frameListeners: (() => void)[] = [];
  private repickListeners: (() => void)[] = [];
  private resolutionListeners: (() => void)[] = [];
  private chunkListeners: ((ref: ReplayRef) => void)[] = [];
  private regionIds: Set<string>;
  private buildingIds: Set<string>;
  private aliases: Map<string, string>;
  private named = new Map<string, RegExp>();

  constructor(
    readonly world: Replay,
    readonly source: 'real' | 'fixture',
    readonly layout: Layout,
    readonly pages: Library,
    readonly paged: boolean,
    readonly view: View,
  ) {
    this.regionIds = new Set(layout.regions.map((r) => r.id));
    this.buildingIds = new Set(layout.buildings.map((b) => b.id));
    this.aliases = new Map(world.regions.filter((r) => r.kind === 'client').map((r, i) => [r.id, `Client ${i + 1}`]));
    for (const r of world.regions) if (r.kind === 'client' && r.name.trim()) this.named.set(r.id, new RegExp(`(?<![A-Za-z])${r.name.trim().split(/[\s_-]+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*')}(?![A-Za-z])`, 'gi'));
    pages.onChange((chunk) => {
      for (const listener of this.chunkListeners) listener(chunk.ref);
    });
  }

  regionName(id: string, name: string) {
    return this.view.show.regions ? name : (this.aliases.get(id) ?? name);
  }

  redact(text: string, region: string | null) {
    if (this.view.show.regions) return text;
    const alias = (region && this.aliases.get(region)) || 'Client';
    const out = text.replace(/^\s*[A-Z0-9]{2,5}(?= - |_)/, alias);
    const named = region ? this.named.get(region) : undefined;
    return named ? out.replace(named, alias) : out;
  }

  get data(): Replay {
    return this.pages.active().data;
  }

  get sim(): Sim {
    return this.pages.sim;
  }

  get library(): ReplayRef[] {
    return this.paged ? this.pages.refs : [];
  }

  private carriedAt = -1;
  private carriedSum: Required<WeekClosing> = { bills: {}, features: {}, created: {}, people: {} };

  get carried(): Required<WeekClosing> {
    const index = this.paged ? this.pages.active().index : 0;
    if (index === this.carriedAt) return this.carriedSum;
    const sum: Required<WeekClosing> = { bills: {}, features: {}, created: {}, people: {} };
    for (const ref of this.library.slice(0, index)) {
      const c = ref.closing ?? {};
      for (const [id, bill] of Object.entries(c.bills ?? {})) {
        const kept = (sum.bills[id] ??= { source: bill.source, sums: {} });
        for (const currency in bill.sums) kept.sums[currency] = (kept.sums[currency] ?? 0) + bill.sums[currency];
      }
      for (const [id, [activity, errors]] of Object.entries(c.features ?? {})) {
        const kept = (sum.features[id] ??= [0, 0]);
        kept[0] += activity;
        kept[1] += errors;
      }
      for (const [id, made] of Object.entries(c.created ?? {})) {
        const kept = (sum.created[id] ??= {});
        for (const type in made) kept[type] = (kept[type] ?? 0) + made[type];
      }
      for (const [id, row] of Object.entries(c.people ?? {})) {
        const kept = (sum.people[id] ??= row.map(() => 0));
        row.forEach((n, i) => (kept[i] = (kept[i] ?? 0) + n));
      }
    }
    this.carriedAt = index;
    this.carriedSum = sum;
    return sum;
  }

  get dayOffset(): number {
    const first = this.library[0];
    return first ? Math.round((this.data.window.start - first.start) / 86_400_000) : 0;
  }

  get replay(): ReplayRef | null {
    return this.paged ? this.pages.active().ref : null;
  }

  get start() {
    return this.pages.start;
  }

  get end() {
    return this.pages.end;
  }

  get loading() {
    return !this.pages.ready(this.view.t);
  }

  weekAt(t: number) {
    return this.pages.refs[this.pages.indexAt(t)];
  }

  onChunk(listener: (ref: ReplayRef) => void) {
    this.chunkListeners.push(listener);
  }

  onLoad(listener: (ref: ReplayRef) => void) {
    this.pages.onLoad((chunk) => listener(chunk.ref));
  }

  open(id: string) {
    const ref = this.pages.refs.find((entry) => entry.id === id);
    if (ref) this.seek(ref.start);
  }

  advance(deltaMs: number) {
    const view = this.view;
    if (view.autoSpeed) view.speed = speedAt(view.t);
    if (!view.playing || view.scrubbing) return;
    if (this.loading) return this.pages.focus(this.pages.indexAt(view.t));
    let t = view.t + (deltaMs / 1000) * view.speed * MINUTE;
    if (view.skipIdle) {
      const next = this.sim.nextEventTime(t);
      if (!this.sim.inMotion(t, view.speed) && next - t > IDLE_GAP_MS) {
        const target = Math.min(this.end, next - Math.min(view.speed * 0.5, 10) * MINUTE);
        if (target > t) {
          this.skipNote = { text: `skipped ${fmtDuration(target - t)}`, until: performance.now() + 2500 };
          t = target;
        }
      }
    }
    if (t >= this.end) {
      t = this.end;
      view.playing = false;
    }
    if (!this.pages.ready(t)) t = Math.max(view.t, this.weekAt(t).start);
    view.t = t;
    this.pages.focus(this.pages.indexAt(t));
  }

  seek(t: number) {
    this.view.t = Math.min(this.end, Math.max(this.start, t));
    this.skipNote = null;
    this.pages.focus(this.pages.indexAt(this.view.t));
  }

  togglePlay() {
    if (!this.view.playing && this.view.t >= this.end) this.seek(this.start);
    this.view.playing = !this.view.playing;
  }

  select(id: string | null) {
    if (!id) return this.pick(null);
    if (this.layout.index.has(id)) return this.pick({ kind: 'unit', id });
    if (this.regionIds.has(id)) return this.pick({ kind: 'region', id });
    if (this.buildingIds.has(id)) return this.pick({ kind: 'building', id });
    if (id === 'barn') return this.pick({ kind: 'barn', id });
    if (id === 'store:concept' || id === 'store:creative' || id === 'store:brief') return this.pick({ kind: 'store', id });
    if (this.traces.some((t) => t.id === id)) return this.pick({ kind: 'trace', id });
    this.pick(null);
  }

  pick(pick: Pick | null) {
    const known =
      pick &&
      (pick.kind === 'trace' ? this.traces.some((t) => t.id === pick.id) : pick.kind === 'barn' ? !!this.layout.barn : pick.kind === 'store' ? !!this.layout.stores : pick.kind === 'crowd' ? true : pick.kind === 'unit' ? this.layout.index.has(pick.id) : pick.kind === 'region' ? this.regionIds.has(pick.id) : this.buildingIds.has(pick.id));
    const next = known ? pick : null;
    const now = this.view.picked;
    if ((next?.kind ?? null) === (now?.kind ?? null) && (next?.id ?? null) === (now?.id ?? null)) {
      if (next) {
        this.view.picked = next;
        for (const listener of this.repickListeners) listener();
      }
      return;
    }
    this.view.picked = next;
    this.view.selected = next?.kind === 'unit' ? next.id : null;
    for (const listener of this.selectListeners) listener(next);
  }

  onSelect(listener: (pick: Pick | null) => void) {
    this.selectListeners.push(listener);
  }

  onRepick(listener: () => void) {
    this.repickListeners.push(listener);
  }

  onResolution(listener: () => void) {
    this.resolutionListeners.push(listener);
  }

  setResolution(value: number) {
    this.view.resolution = value;
    try {
      localStorage.setItem(RESOLUTION_KEY, String(value));
    } catch {}
    for (const listener of this.resolutionListeners) listener();
  }

  onFrame(listener: () => void) {
    this.frameListeners.push(listener);
  }

  frame() {
    for (const listener of this.frameListeners) listener();
  }
}
