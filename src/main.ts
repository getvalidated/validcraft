import { log } from './diag';
import './style.css';
import { App, DEFAULT_SPEED, RESOLUTIONS, RESOLUTION_KEY } from './app';
import { createCargo } from './cargo';
import { fetchDays, fetchWeek } from './days';
import { buildLayout } from './layout';
import { createLibrary } from './library';
import { createPanel } from './panel';
import { createHud } from './hud';
import { createGame, mapAspect } from './scene';
import { TYPES } from './palette';
import { SCHEMA_VERSION, type Replay, type ReplayRef, type ResourceType } from './schema';
import type { GearFile } from './sprites';
import { createTimeline } from './timeline';
import { loadTraces } from './traces';

async function fetchReplay(url: string): Promise<Replay | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const data = await res.json();
    return data?.schemaVersion === SCHEMA_VERSION && Array.isArray(data.events) ? data : null;
  } catch {
    return null;
  }
}

async function fetchLibrary(): Promise<ReplayRef[]> {
  try {
    const res = await fetch('/data/library/index.json', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function fetchGear(): Promise<GearFile['entities']> {
  try {
    const res = await fetch('/data/gear.json', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return {};
    const file = await res.json();
    return file?.schemaVersion === 1 && file.entities && typeof file.entities === 'object' ? file.entities : {};
  } catch {
    return {};
  }
}

function toMs(value: number | string | Date) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number(value) : parsed;
}

function storedResolution() {
  try {
    const value = Number(localStorage.getItem(RESOLUTION_KEY));
    return RESOLUTIONS.includes(value) ? value : 0;
  } catch {
    return 0;
  }
}

const heapMB = () => {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1e5) / 10 : null;
};

async function boot() {
  const params = new URLSearchParams(location.search);
  document.getElementById('skipped')!.textContent = 'loading the map…';
  const traced = loadTraces();
  const began = performance.now();
  const [library, world, days, gear] = await Promise.all([fetchLibrary(), fetchReplay('/data/library/world.json'), fetchDays(), fetchGear()]);
  const loadWeek = async (ref: ReplayRef) => (await fetchWeek(ref, days)) ?? fetchReplay(`/data/library/${ref.id}.json`);
  const listed = performance.now();
  const asked = params.has('t') ? toMs(params.get('t')!) : NaN;
  const chosen = library.find((entry) => entry.id === params.get('replay')) ?? library[library.length - 1] ?? null;
  const target = Number.isFinite(asked) ? asked : (chosen?.start ?? NaN);
  const first = Math.max(0, library.filter((entry) => entry.start <= target).length - 1);
  let source: 'real' | 'fixture' = 'real';
  let data = library.length ? await loadWeek(library[first]) : null;
  const paged = !!data;
  if (!data) data = await fetchReplay('/data/replay.json');
  if (!data) {
    source = 'fixture';
    data = await fetchReplay('/fixtures/replay.sample.json');
  }
  if (!data) {
    document.getElementById('map')!.textContent = 'No replay file could be loaded.';
    return;
  }
  const fetched = performance.now();

  const mapEl = document.getElementById('map')!;
  const shape = paged && world ? world : data;
  const traces = (await traced) ?? data.traces ?? [];
  const planted = new Map<string, number>();
  for (const trace of traces) {
    if (!trace.region) continue;
    const launched = new Set(trace.nodes.filter((n) => n.key.startsWith('ad:') && n.parent).map((n) => n.parent));
    planted.set(trace.region, (planted.get(trace.region) ?? 0) + (trace.id.startsWith('client_winner:') ? 1 : launched.size));
  }
  const layout = buildLayout(shape, mapAspect(mapEl), planted, gear);
  const laid = performance.now();
  const refs = paged ? library : [{ id: 'replay', start: data.window.start, end: data.window.end }];
  const cargo = createCargo(traces, layout);
  const pages = createLibrary(refs, layout, loadWeek, { index: paged ? first : 0, data }, cargo);
  const simmed = performance.now();
  const speed = Number(params.get('speed'));
  const app = new App(shape, source, layout, pages, paged, {
    t: refs[paged ? first : 0].start,
    speed: speed > 0 && Number.isFinite(speed) ? speed : DEFAULT_SPEED,
    autoSpeed: !(speed > 0 && Number.isFinite(speed)),
    playing: params.get('paused') !== '1',
    skipIdle: true,
    resolution: storedResolution(),
    selected: null,
    picked: null,
    hover: null,
    scrubbing: false,
    show: {
      types: Object.fromEntries(TYPES.map((type) => [type, true])) as Record<ResourceType, boolean>,
      sources: { linear: true, slack: true, notion: true, github: true, calendar: true, temporal: true, sentry: true, mixpanel: true, mcp: true, outputs: true, sessions: true, money: true, ashby: true, spend: true, platform: true, workspace: true, outreach: true, ops: true },
      trail: true,
      regions: true,
      entities: true,
    },
  });
  app.traces = traces;
  app.cargo = cargo;
  for (const name of (params.get('hide') ?? '').split(',')) {
    if (name in app.view.show.types) app.view.show.types[name as keyof typeof app.view.show.types] = false;
    if (name in app.view.show.sources) app.view.show.sources[name as keyof typeof app.view.show.sources] = false;
    if (name === 'trail') app.view.show.trail = false;
    if (name === 'regions') app.view.show.regions = false;
    if (name === 'entities') app.view.show.entities = false;
  }
  if (Number.isFinite(asked)) app.seek(asked);

  document.addEventListener('gesturestart', (event) => event.preventDefault());
  createPanel(app);
  createTimeline(app);
  createHud(app);
  app.select(params.get('select'));
  const address = () => `${app.view.autoSpeed ? '' : app.view.speed}|${app.replay?.id ?? ''}|${app.view.picked?.id ?? ''}`;
  let addressed = address();
  app.onFrame(() => {
    const now = address();
    if (now === addressed) return;
    addressed = now;
    const query = new URLSearchParams(location.search);
    const put = (key: string, value: string | null | undefined) => (value ? query.set(key, value) : query.delete(key));
    query.delete('t');
    put('speed', app.view.autoSpeed ? null : String(app.view.speed));
    put('replay', app.replay?.id);
    put('select', app.view.picked?.id);
    const text = query.toString();
    history.replaceState(null, '', `${location.pathname}${text ? `?${text}` : ''}`);
  });
  createGame(app, mapEl);
  const boot = {
    weeks: refs.length,
    week: refs[paged ? first : 0].id,
    listMs: Math.round(listed - began),
    chunkMs: Math.round(fetched - listed),
    layoutMs: Math.round(laid - fetched),
    simMs: Math.round(simmed - laid),
    totalMs: Math.round(performance.now() - began),
    heapMB: heapMB(),
  };
  log('ready', { source, replay: app.replay?.id ?? null, units: layout.units.length, lanes: app.sim.lanes.length, sessions: data.sessions.length, ...boot });
  const chunks: { id: string; ms: number; heapMB: number | null }[] = [];
  app.onChunk((ref) => {
    chunks.push({ id: ref.id, ms: Math.round(performance.now()), heapMB: heapMB() });
    log('chunk', { id: ref.id, loaded: pages.loaded().map((c) => c.ref.id), heapMB: heapMB() });
  });

  (window as any).__sim = {
    get data() {
      return app.data;
    },
    view: app.view,
    boot,
    chunks,
    sim: app.sim,
    loaded: () => pages.loaded().map((c) => c.ref.id),
    seek: (t: number | string | Date) => app.seek(toMs(t)),
    state: (t?: number | string | Date, speedOverride?: number) =>
      app.sim.state(t === undefined ? app.view.t : toMs(t), speedOverride ?? app.view.speed),
  };
}

boot();
