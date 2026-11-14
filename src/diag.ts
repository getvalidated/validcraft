const BEAT_MS = 2000;
const MB = 1 / (1024 * 1024);

function stored(key: string, make: (old: string | null) => string) {
  try {
    const value = make(sessionStorage.getItem(key));
    sessionStorage.setItem(key, value);
    return value;
  } catch {
    return make(null);
  }
}

const tab = stored('rts.diag.tab', (old) => old ?? Math.random().toString(36).slice(2, 8));
const boot = Number(stored('rts.diag.boot', (old) => String(Number(old ?? 0) + 1)));

export function log(kind: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ tab, boot, ms: Math.round(performance.now()), kind, ...data });
  try {
    if (navigator.sendBeacon?.('/__log', line)) return;
  } catch {}
  fetch('/__log', { method: 'POST', body: line, keepalive: true }).catch(() => {});
}

const canvases: WeakRef<HTMLCanvasElement>[] = [];
const seen = new WeakSet<HTMLCanvasElement>();
const stats = { sets: 0, setBytes: 0, made: 0, frames: 0, gap: 0, resizes: 0 };
const sizes = new Map<string, number>();

for (const side of ['width', 'height'] as const) {
  const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, side);
  if (!desc?.set || !desc.get) continue;
  Object.defineProperty(HTMLCanvasElement.prototype, side, {
    ...desc,
    set(this: HTMLCanvasElement, value: number) {
      desc.set!.call(this, value);
      stats.sets++;
      stats.setBytes += this.width * this.height * 4;
      const size = `${this.width}x${this.height}`;
      sizes.set(size, (sizes.get(size) ?? 0) + 1);
      if (!seen.has(this)) {
        seen.add(this);
        stats.made++;
        canvases.push(new WeakRef(this));
      }
    },
  });
}

const ctx2d = { save: 0, restore: 0, depth: 0, draws: 0, fills: 0, strokes: 0, texts: 0 };
const proto2d = CanvasRenderingContext2D.prototype as any;
const count = (name: string, bump: () => void) => {
  const original = proto2d[name];
  proto2d[name] = function (this: unknown, ...args: unknown[]) {
    bump();
    return original.apply(this, args);
  };
};
count('save', () => {
  ctx2d.save++;
  ctx2d.depth++;
});
count('restore', () => {
  ctx2d.restore++;
  ctx2d.depth--;
});
count('drawImage', () => ctx2d.draws++);
count('fill', () => ctx2d.fills++);
count('stroke', () => ctx2d.strokes++);
count('fillText', () => ctx2d.texts++);

let lastFrame = performance.now();
function frame(now: number) {
  stats.frames++;
  stats.gap = Math.max(stats.gap, now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let lastBeat = performance.now();
setInterval(() => {
  const now = performance.now();
  let live = 0;
  let liveBytes = 0;
  let biggest = 0;
  for (let i = canvases.length - 1; i >= 0; i--) {
    const canvas = canvases[i].deref();
    if (!canvas) {
      canvases.splice(i, 1);
      continue;
    }
    const bytes = canvas.width * canvas.height * 4;
    live++;
    liveBytes += bytes;
    biggest = Math.max(biggest, bytes);
  }
  const game = document.querySelector<HTMLCanvasElement>('#map canvas');
  const view = (window as any).__sim?.view;
  log('beat', {
    fps: Math.round((stats.frames * 1000) / (now - lastBeat)),
    gapMs: Math.round(stats.gap),
    sets: stats.sets,
    setMB: Math.round(stats.setBytes * MB),
    made: stats.made,
    live,
    liveMB: Math.round(liveBytes * MB),
    biggestMB: Math.round(biggest * MB),
    game: game ? `${game.width}x${game.height}` : null,
    win: `${window.innerWidth}x${window.innerHeight}`,
    resizes: stats.resizes,
    top: [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([size, n]) => `${size}:${n}`).join(' '),
    vis: document.visibilityState,
    ctx: `save ${ctx2d.save} restore ${ctx2d.restore} depth ${ctx2d.depth} draw ${ctx2d.draws} fill ${ctx2d.fills} stroke ${ctx2d.strokes} text ${ctx2d.texts}`,
    dom: document.getElementsByTagName('*').length,
    heapMB: (performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize * MB) : null,
    t: view ? Math.round(view.t) : null,
    speed: view?.speed ?? null,
    playing: view?.playing ?? null,
  });
  stats.sets = 0;
  stats.setBytes = 0;
  stats.made = 0;
  stats.frames = 0;
  stats.gap = 0;
  stats.resizes = 0;
  ctx2d.save = ctx2d.restore = ctx2d.draws = ctx2d.fills = ctx2d.strokes = ctx2d.texts = 0;
  sizes.clear();
  lastBeat = now;
}, BEAT_MS);

window.addEventListener('resize', () => stats.resizes++);
window.addEventListener('error', (event) =>
  log('error', {
    message: event.message,
    at: `${event.filename}:${event.lineno}:${event.colno}`,
    stack: String(event.error?.stack ?? '').slice(0, 1500),
  }),
);
window.addEventListener('unhandledrejection', (event) =>
  log('rejection', { message: String(event.reason?.message ?? event.reason), stack: String(event.reason?.stack ?? '').slice(0, 1500) }),
);
window.addEventListener('pagehide', (event) => log('pagehide', { persisted: event.persisted }));
window.addEventListener('pageshow', (event) => log('pageshow', { persisted: event.persisted }));
document.addEventListener('visibilitychange', () => log('visibility', { state: document.visibilityState }));
document.addEventListener('freeze', () => log('freeze'));
document.addEventListener('resume', () => log('resume'));

const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
log('boot', {
  ua: navigator.userAgent,
  dpr: window.devicePixelRatio,
  win: `${window.innerWidth}x${window.innerHeight}`,
  screen: `${screen.width}x${screen.height}`,
  nav: nav?.type ?? null,
  discarded: (document as any).wasDiscarded ?? null,
  memoryGB: (navigator as any).deviceMemory ?? null,
  cores: navigator.hardwareConcurrency ?? null,
  href: location.pathname + location.search.replace(/k=[^&]*/, 'k=…'),
});
