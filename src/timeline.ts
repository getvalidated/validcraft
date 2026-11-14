import { DEFAULT_SPEED, MINUTE, NARROW, NIGHT_SPEED, RESOLUTIONS, SPEEDS, type App } from './app';
import { fmtClock, fmtDate, fmtDay, fmtWeekday, pacificMidnights } from './format';

const BIN_MS = 10 * MINUTE;
const DAY_MS = 1440 * MINUTE;
const LABEL_W = 30;
const WEEK_LABEL_W = 44;
const icon = (path: string) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
const ICONS = {
  Play: icon('M4 2.5v11l9-5.5z'),
  Pause: icon('M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z'),
  Replay: icon('M8 1v2.2a5.4 5.4 0 1 0 5.4 5.4h-1.7A3.7 3.7 0 1 1 8 4.9V7l3.6-3z'),
};

interface Strip {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  backdrop: HTMLCanvasElement;
  width: number;
  height: number;
  ratio: number;
}

function strip(canvas: HTMLCanvasElement): Strip {
  return { canvas, ctx: canvas.getContext('2d')!, backdrop: document.createElement('canvas'), width: 0, height: 0, ratio: 1 };
}

function size(s: Strip) {
  const rect = s.canvas.getBoundingClientRect();
  s.ratio = window.devicePixelRatio || 1;
  s.width = Math.max(1, Math.floor(rect.width));
  s.height = Math.max(1, Math.floor(rect.height));
  for (const c of [s.canvas, s.backdrop]) {
    c.width = Math.floor(s.width * s.ratio);
    c.height = Math.floor(s.height * s.ratio);
  }
  const b = s.backdrop.getContext('2d')!;
  b.setTransform(s.ratio, 0, 0, s.ratio, 0, 0);
  return b;
}

function bars(b: CanvasRenderingContext2D, s: Strip, counts: number[], top: number, color: string) {
  const peak = Math.max(1, ...counts);
  const barW = Math.max(1, s.width / counts.length);
  b.fillStyle = color;
  counts.forEach((count, i) => {
    if (!count) return;
    const h = Math.max(1.5, Math.sqrt(count / peak) * (s.height - top - 2));
    b.fillRect((i / counts.length) * s.width, s.height - h, barW, h);
  });
}

function blit(s: Strip) {
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.drawImage(s.backdrop, 0, 0);
  s.ctx.setTransform(s.ratio, 0, 0, s.ratio, 0, 0);
}

export function createTimeline(app: App) {
  const { view, sim, pages } = app;
  const weeks = pages.refs;
  const playButton = document.getElementById('play') as HTMLButtonElement;
  const speedBox = document.getElementById('speeds')!;
  const speedCycle = document.getElementById('speed') as HTMLButtonElement;
  const dock = document.getElementById('timeline')!;
  const more = document.getElementById('more')!;
  const moreButton = document.getElementById('more-toggle')!;
  const dayBox = document.getElementById('days')!;
  const resolutionBox = document.getElementById('resolution') as HTMLSelectElement;
  const clock = document.getElementById('clock')!;
  const skipped = document.getElementById('skipped')!;
  const detail = strip(document.getElementById('scrub') as HTMLCanvasElement);
  const overview = strip(document.getElementById('weeks') as HTMLCanvasElement);
  const many = weeks.length > 1;
  overview.canvas.hidden = !many;

  let week = -1;
  let from = app.start;
  let to = app.end;
  let midnights: number[] = [];
  let counts: number[] = [];

  playButton.addEventListener('click', () => app.togglePlay());
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    if (event.repeat) return;
    if (target.closest('button, a')) target.blur();
    app.togglePlay();
  });

  const autoButton = document.createElement('button');
  autoButton.title = `${NIGHT_SPEED}× from 8pm to 8am Pacific, ${DEFAULT_SPEED}× during the day`;
  autoButton.addEventListener('click', () => {
    view.autoSpeed = true;
  });
  speedBox.append(autoButton);
  const speedButtons = SPEEDS.map((speed) => {
    const button = document.createElement('button');
    button.textContent = `${speed}×`;
    button.title = `${speed} replay minutes per second`;
    button.addEventListener('click', () => {
      view.speed = speed;
      view.autoSpeed = false;
    });
    speedBox.append(button);
    return { speed, button };
  });

  speedCycle.addEventListener('click', () => {
    const at = view.autoSpeed ? -1 : SPEEDS.indexOf(view.speed);
    view.autoSpeed = at === SPEEDS.length - 1;
    if (!view.autoSpeed) view.speed = SPEEDS[at + 1];
  });

  const setMore = (open: boolean) => {
    dock.classList.toggle('more-open', open);
    moreButton.classList.toggle('on', open);
    moreButton.setAttribute('aria-expanded', String(open));
  };
  moreButton.addEventListener('click', () => setMore(!dock.classList.contains('more-open')));
  document.addEventListener('pointerdown', (event) => {
    if (!dock.classList.contains('more-open')) return;
    const target = event.target as Node;
    if (!more.contains(target) && !moreButton.contains(target)) setMore(false);
  });
  NARROW.addEventListener('change', () => setMore(false));


  for (const value of RESOLUTIONS) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = value ? `Resolution: ${value}×` : 'Resolution: match screen';
    option.selected = value === view.resolution;
    resolutionBox.append(option);
  }
  resolutionBox.addEventListener('change', () => app.setResolution(Number(resolutionBox.value)));

  function showWeek(i: number) {
    week = i;
    from = weeks[i].start;
    to = weeks[i].end;
    midnights = pacificMidnights(from, to);
    counts = sim.bins(from, to, BIN_MS);
    dayBox.replaceChildren();
    const dayStarts = [from, ...midnights];
    dayStarts.forEach((dayStart, k) => {
      const dayEnd = dayStarts[k + 1] ?? to;
      const button = document.createElement('button');
      button.textContent = fmtDay(dayStart);
      button.addEventListener('click', () => {
        const first = sim.nextEventTime(dayStart - 1);
        app.seek(first < dayEnd ? Math.max(dayStart, first - sim.lifeMs(view.speed) * 0.1) : dayStart);
      });
      dayBox.append(button);
    });
    drawDetail();
    drawOverview();
    drawScrub();
  }

  function drawDetail() {
    const b = size(detail);
    const { width, height } = detail;
    const span = to - from;
    b.fillStyle = '#0e121b';
    b.fillRect(0, 0, width, height);
    bars(b, detail, counts, 16, '#44506e');
    b.font = '10px -apple-system, "Segoe UI", sans-serif';
    b.textBaseline = 'top';
    b.fillStyle = '#8791a8';
    const firstMark = midnights.length ? ((midnights[0] - from) / span) * width : width;
    if (firstMark > 36) b.fillText(many && firstMark > 76 ? `${fmtWeekday(from)} ${fmtDate(from)}` : fmtWeekday(from), 4, 3);
    const every = Math.max(1, Math.ceil(LABEL_W / ((DAY_MS / span) * width)));
    midnights.forEach((midnight, i) => {
      const x = ((midnight - from) / span) * width;
      b.fillStyle = '#5c6885';
      b.fillRect(Math.round(x), 0, 1, height);
      if (i % every) return;
      b.fillStyle = '#8791a8';
      b.fillText(fmtWeekday(midnight), x + 4, 3);
    });
  }

  function drawOverview() {
    if (!many) return;
    const b = size(overview);
    const { width, height } = overview;
    const span = app.end - app.start;
    const x = (t: number) => ((t - app.start) / span) * width;
    b.fillStyle = '#0b0f17';
    b.fillRect(0, 0, width, height);
    const binMs = Math.max(BIN_MS, Math.ceil(span / width / BIN_MS) * BIN_MS);
    bars(b, overview, sim.bins(app.start, app.end, binMs), 2, '#34405c');
    b.fillStyle = 'rgba(86, 180, 233, 0.14)';
    b.fillRect(x(from), 0, Math.max(2, x(to) - x(from)), height);
    b.fillStyle = '#56b4e9';
    b.fillRect(Math.round(x(from)), 0, 1, height);
    b.fillRect(Math.round(x(to)) - 1, 0, 1, height);
    b.font = '10px -apple-system, "Segoe UI", sans-serif';
    b.textBaseline = 'middle';
    const every = Math.max(1, Math.ceil(WEEK_LABEL_W / ((width * (7 * DAY_MS)) / span)));
    weeks.forEach((ref, i) => {
      if (i) {
        b.fillStyle = '#5c6885';
        b.fillRect(Math.round(x(ref.start)), 0, 1, height);
      }
      if (i % every || x(ref.start) > width - 30) return;
      b.fillStyle = i === week ? '#dfe9f7' : '#8791a8';
      b.fillText(fmtDate(ref.start), x(ref.start) + 4, height / 2 + 0.5);
    });
  }

  function drawPlayhead(s: Strip, start: number, end: number, cap: boolean) {
    blit(s);
    const ctx = s.ctx;
    const x = ((view.t - start) / (end - start)) * s.width;
    if (cap) {
      ctx.fillStyle = 'rgba(86, 180, 233, 0.08)';
      ctx.fillRect(0, 0, x, s.height);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(x) - 1, 0, 2, s.height);
    if (!cap) return;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 7);
    ctx.closePath();
    ctx.fill();
  }

  function drawScrub() {
    drawPlayhead(detail, from, to, true);
    if (many) drawPlayhead(overview, app.start, app.end, false);
  }

  const scrubber = (s: Strip, range: () => [number, number]) => {
    let [start, end] = range();
    const scrubTo = (event: PointerEvent) => {
      const rect = s.canvas.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      app.seek(start + k * (end - start));
    };
    s.canvas.addEventListener('pointerdown', (event) => {
      [start, end] = range();
      s.canvas.setPointerCapture(event.pointerId);
      view.scrubbing = true;
      scrubTo(event);
    });
    s.canvas.addEventListener('pointermove', (event) => {
      if (view.scrubbing && s.canvas.hasPointerCapture(event.pointerId)) scrubTo(event);
    });
    const release = () => {
      view.scrubbing = false;
    };
    s.canvas.addEventListener('pointerup', release);
    s.canvas.addEventListener('pointercancel', release);
  };
  scrubber(detail, () => [from, to < app.end ? to - 1 : to]);
  scrubber(overview, () => [app.start, app.end]);

  new ResizeObserver(() => {
    drawDetail();
    drawOverview();
    drawScrub();
  }).observe(detail.canvas);
  showWeek(pages.indexAt(view.t));
  app.onLoad(() => showWeek(week));

  let shown = '';
  app.onFrame(() => {
    const at = pages.indexAt(view.t);
    if (at !== week) showWeek(at);
    const loading = app.loading;
    const key = `${view.t}|${view.playing}|${view.speed}|${view.autoSpeed}|${NARROW.matches}|${app.skipNote?.text ?? ''}|${loading}`;
    if (app.skipNote && performance.now() > app.skipNote.until) app.skipNote = null;
    if (key === shown && !app.skipNote) return;
    shown = key;
    const action = view.playing ? 'Pause' : view.t >= app.end ? 'Replay' : 'Play';
    if (playButton.title !== action || playButton.dataset.narrow !== String(NARROW.matches)) {
      playButton.title = action;
      playButton.dataset.narrow = String(NARROW.matches);
      playButton.setAttribute('aria-label', action);
      if (NARROW.matches) playButton.innerHTML = ICONS[action];
      else playButton.textContent = action;
    }
    speedCycle.textContent = view.autoSpeed ? `Default ${view.speed}×` : `${view.speed}×`;
    autoButton.textContent = view.autoSpeed ? `Default ${view.speed}×` : 'Default';
    autoButton.classList.toggle('on', view.autoSpeed);
    for (const { speed, button } of speedButtons) button.classList.toggle('on', !view.autoSpeed && speed === view.speed);
    clock.textContent = fmtClock(view.t);
    skipped.textContent = loading ? `loading the week of ${fmtDate(weeks[at].start)}…` : (app.skipNote?.text ?? '');
    drawScrub();
  });
}
