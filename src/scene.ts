import Phaser from 'phaser';
import { NARROW, type App, type Pick } from './app';
import { fmtCompact, fmtCostPer, fmtMoneyCompact } from './format';
import { MAX_AGENTS, SLOT_STEP, unitInitials } from './layout';
import { COLORS, ORIGIN_COLORS, RESOURCE_COLORS, RESOURCE_LABELS, TYPES, TYPE_COLOR, UNIT_COLORS, hex, mix, originColor, shadeColor } from './palette';
import { LEAD_STAGES, RECRUIT_STAGES, type ResourceType, type SourceName } from './schema';
import { OCEAN, buildTerrain } from './terrain';
import type { CounterState, AgentState, Point, Rect, RingState, SimState } from './seam';
import { barn as drawBarn, building as drawBuilding, home as drawHome, palace as drawPalace, stall as drawStall, table as drawTable, resourcePath, starPath, unitSprite } from './shapes';
import { SPRITE_CHEST } from './sprites';
import { billsOf } from './sim/bills';
import { drawTrace } from './tracefx';
import { traceFocus } from './traces';

type Text = Phaser.GameObjects.Text;
type Graphics = Phaser.GameObjects.Graphics;

const FONT = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const BG = hex(COLORS.bg);
const WHITE = 0xffffff;
const RETURN = hex(COLORS.return);
const BULK = hex(COLORS.bulk);
const NEUTRAL = hex(COLORS.neutral);
const AGENT = hex(COLORS.agent);
const AGENT_IDLE = mix(hex(COLORS.agent), hex(COLORS.neutral), 0.55);
const TROPHY = hex(COLORS.trophy);
const MEETING = hex(COLORS.meeting);
const TABLE = mix(hex(COLORS.bg), MEETING, 0.3);
const AWAY = hex(COLORS.away);
const USE = hex(COLORS.use);
const ERROR = hex(COLORS.error);
const CELL = 0x141a28;
const CELL_SIZE = 7.5;
const CELL_ZOOM = 0.62;
const CELL_FINE = 0.3;
const CELL_TIP = 0.4;
const DAY = 86_400_000;
const BAR_GAP = 4;
const TAP_SLOP = 10;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const FIT_MAX = 2;
const NAME_ZOOM = 0.95;
const INITIALS_ZOOM = 0.42;
const COUNT_ZOOM = 1.35;
const DIM = 0.42;
const UNBORN = Math.fround(0.02);
const STRATUM = 0xe3c48e;
const JAIL = 0x1b1e26;
const HEAVEN = 0xdfe8ff;
const BARS = 0x8a919e;
const BAR_STEP = 26;
const FAR = 0.28;
const LIGHT = 0xffd27a;
const PALACE = 3.2;
const homed = (kind: string) => kind === 'person' || kind === 'client' || kind === 'ambassador';
const COUNTER_MS = 250;
const COUNTER_SIZE = 10.5;
const COUNTER_FONT = `${COUNTER_SIZE}px ${FONT}`;
const COUNTER_COLOR = '#8fa0c0';
const TALLY_ROWS = 2;
const KID_OFFSETS: Point[] = [
  { x: SLOT_STEP / 2, y: -SLOT_STEP / 2 },
  { x: -SLOT_STEP / 2, y: -SLOT_STEP / 2 },
  { x: SLOT_STEP / 2, y: SLOT_STEP / 2 },
  { x: -SLOT_STEP / 2, y: SLOT_STEP / 2 },
];
const TERRITORY = ['#18232e', '#1c2233', '#221f35', '#27202e', '#272323', '#202722', '#19272a', '#1f2430'].map(hex);

const PAN_MS = 600;
const STORE_IDS = ['store:concept', 'store:creative', 'store:brief'];
const STORE_NAMES = ['Idle concepts', 'Idle creatives', 'Idle briefs'];
const PAN_AT: Point = { x: 0, y: 0 };
const barHeight = () => (document.getElementById('bar')?.offsetHeight || 36) + BAR_GAP;

export const mapAspect = (parent: HTMLElement) =>
  Math.max(0.4, (parent.clientWidth - 24) / Math.max(120, parent.clientHeight - barHeight() - 20));

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function pop(k: number) {
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  const u = k - 1;
  return 1 + 3.2 * u * u * u + 2.2 * u * u;
}

function money(totals: Record<string, number>) {
  return Object.keys(totals)
    .sort()
    .map((currency) => fmtMoneyCompact(totals[currency], currency))
    .join('+');
}

function paint(text: Text, color: string) {
  if (text.style.color !== color) text.setColor(color);
  return text;
}

const ruler = document.createElement('canvas').getContext('2d')!;
let rulerFont = '';

function widthOf(font: string, value: string) {
  if (font !== rulerFont) {
    ruler.font = font;
    rulerFont = font;
  }
  return Math.ceil(ruler.measureText(value).width);
}

function fit(font: string, full: string, limit: number) {
  const width = widthOf(font, full);
  if (width <= limit || full.length < 3) return full;
  let n = Math.max(1, Math.floor((full.length * limit) / width) - 1);
  let value = `${full.slice(0, n).trimEnd()}…`;
  while (widthOf(font, value) > limit && n > 1) {
    n--;
    value = `${full.slice(0, n).trimEnd()}…`;
  }
  return value;
}

function fitText(text: Text, full: string, limit: number) {
  const value = fit((text.style as unknown as { _font: string })._font, full, limit);
  if (text.text !== value) text.setText(value);
}

export function createGame(app: App, parent: HTMLElement) {
  const { layout, sim, view } = app;
  const R = layout.unitRadius;
  const count = layout.units.length;
  const scale = () => Math.min(view.resolution || Math.max(1, window.devicePixelRatio || 1), 16384 / Math.max(1, parent.clientWidth, parent.clientHeight));
  let dpr = scale();
  let RES = clamp(dpr * 2, 2, 4);

  const regionIndex = new Map(layout.regions.map((r, i) => [r.id, i]));
  const unitRegion = layout.units.map((u) => regionIndex.get(u.region) ?? -1);
  const terrain = buildTerrain(layout);
  const SEA = hex(OCEAN);
  const regionStyle = terrain.islands.map((island) => {
    const edge = hex(island.coast);
    return { edge, glow: mix(edge, WHITE, 0.6) };
  });
  const unitColors = Object.fromEntries(
    Object.entries(UNIT_COLORS).map(([kind, c]) => [kind, { fill: hex(c.fill), edge: hex(c.edge) }]),
  ) as Record<keyof typeof UNIT_COLORS, { fill: number; edge: number }>;

  const tinted = (kind: keyof typeof UNIT_COLORS, origin?: string) =>
    kind === 'prospect' && origin && ORIGIN_COLORS[origin] ? { fill: unitColors.prospect.fill, edge: hex(ORIGIN_COLORS[origin]) } : unitColors[kind];
  const unitTint = layout.units.map((u) => tinted(u.kind, u.origin));

  const regionOfUnit = (id: string | null) => {
    const i = id ? layout.index.get(id) : undefined;
    return i === undefined ? null : layout.units[i].region;
  };
  let typeSource: Partial<Record<ResourceType, SourceName>> = {};
  let plainSource = new Map<string, SourceName>();
  let touchTimes: Float64Array[] = [];
  const reindex = () => {
    const touched: number[][] = layout.regions.map(() => []);
    const touch = (region: string | null, t: number) => {
      const i = region ? regionIndex.get(region) : undefined;
      if (i !== undefined) touched[i].push(t);
    };
    typeSource = {};
    plainSource = new Map();
    const tally = new Map<string, number>();
    for (const { data } of app.pages.loaded()) {
      for (const e of data.events) {
        touch(e.region, e.t);
        touch(regionOfUnit(e.actor), e.t);
        touch(regionOfUnit(e.from), e.t);
        touch(regionOfUnit(e.to), e.t);
        if (e.resource) {
          const key = `${e.resource}|${e.source}`;
          const n = (tally.get(key) ?? 0) + 1;
          tally.set(key, n);
          const lead = typeSource[e.resource];
          if (!lead || n > (tally.get(`${e.resource}|${lead}`) ?? 0)) typeSource[e.resource] = e.source;
        } else {
          plainSource.set(`${e.kind}|${e.actor}|${e.t}`, e.source);
        }
      }
      for (const a of data.artifacts) {
        touch(a.region, a.t);
        touch(regionOfUnit(a.unit), a.t);
      }
      for (const s of data.sessions) touch(regionOfUnit(s.owner), s.start);
    }
    touchTimes = touched.map((list) => Float64Array.from(list).sort());
  };
  reindex();
  app.onChunk(reindex);
  app.onLoad(reindex);
  const lastTouch = (region: number, t: number) => {
    const times = touchTimes[region];
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo ? times[lo - 1] : -Infinity;
  };

  const featureAt = new Map(layout.features.map((f, i) => [f.id, i]));
  const cellNames = layout.features.map((f) => fit(`${CELL_SIZE}px ${FONT}`, f.name, f.rect.w - 30));
  const cargo = app.cargo;

  class MapScene extends Phaser.Scene {
    private gRegions!: Graphics;
    private gTrails!: Graphics;
    private gCargo!: Graphics;
    private storeTexts: Text[] = [];
    private shelfTexts: Text[] = [];
    private gMeetings!: Graphics;
    private gUnits!: Graphics;
    private gFx!: Graphics;
    private regionNames: Text[] = [];
    private counterShown: string[] = [];
    private counterAt: Point[] = layout.regions.map(() => ({ x: 0, y: 0 }));
    private counterScale = 1;
    private groupNames: Text[] = [];
    private buildingNames: Text[] = [];
    private initials: Text[] = [];
    private homeInitials: (Text | null)[] = [];
    private strataNames: Text[] = [];
    private names: Text[] = [];
    private holdTexts: Text[] = [];
    private badgeTexts: Text[] = [];
    private bulkTexts: Text[] = [];
    private floatSelected!: Text;
    private floatHover!: Text;
    private tip!: Text;
    private ux = new Float64Array(count);
    private uy = new Float64Array(count);
    private ua = new Float32Array(count);
    private ha = new Float32Array(count);
    private atHome = new Uint8Array(count);
    private homeLit = new Uint8Array(count);
    private nameShown = new Uint8Array(count);
    private grow = 1;
    private counterKeys: string[] = [];
    private countersAt = 0;
    private regionAlpha = new Float32Array(layout.regions.length);
    private trophyCount = new Int32Array(layout.regions.length);
    private winCount = new Int32Array(layout.regions.length);
    private clientCount = new Int32Array(layout.regions.length);
    private crowdTexts: Text[] = [];
    private barnText?: Text;
    private tallies: { type: ResourceType | 'win' | 'launch'; n: number; value: string; width: number; dx: number; row: number }[][] = [];
    private namesKey = '';
    private labelBucket = -1;
    private drag: { id: number; x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
    private pinch: { dist: number; zoom: number; world: Point } | null = null;
    private pointer: Point | null = null;
    private cameraMoved = false;
    private pan: { trace: string; key: string; actor: string | null; left: number } | null = null;
    private sought: Pick | null = null;
    private glide: { x: number; y: number; zoom: number; left: number } | null = null;
    private last: SimState | null = null;
    private loose = false;

    constructor() {
      super('map');
    }

    private label(size: number, color: string, bold: boolean, depth: number) {
      return this.add
        .text(0, 0, '', {
          fontFamily: FONT,
          fontSize: `${size}px`,
          fontStyle: bold ? 'bold' : 'normal',
          color,
          resolution: RES,
        })
        .setDepth(depth);
    }

    private pooled(pool: Text[], i: number, size: number, depth: number) {
      let text = pool[i];
      if (!text) {
        text = this.label(size, '#ffffff', true, depth);
        pool.push(text);
      }
      return text.setVisible(true);
    }

    create() {
      this.textures.addCanvas('terrain', terrain.canvas);
      this.add
        .image(terrain.x, terrain.y, 'terrain')
        .setOrigin(0, 0)
        .setScale(1 / terrain.scale)
        .setDepth(-1);
      this.gRegions = this.add.graphics().setDepth(0);
      this.gMeetings = this.add.graphics().setDepth(1);
      this.gTrails = this.add.graphics().setDepth(2);
      this.gUnits = this.add.graphics().setDepth(3);
      this.gCargo = this.add.graphics().setDepth(3.5);
      this.gFx = this.add.graphics().setDepth(5);

      for (const region of layout.regions) {
        const root = region.kind === 'internal';
        this.regionNames.push(this.label(root ? 22 : 13, root ? '#8a97b8' : '#a9b6d0', true, 2.5));
      }
      for (const group of layout.groups) this.groupNames.push(this.label(12, '#8090b0', true, 2.5).setText(group.name));
      if (layout.strata) {
        const { core, band, gap } = layout.strata;
        LEAD_STAGES.forEach((name, level) => {
          const out = gap + band * (LEAD_STAGES.length - level);
          this.strataNames.push(this.label(13, '#b59f76', true, 2.5).setText(name).setPosition(core.x - out + 12, layout.strata!.top + 8));
        });
        this.strataNames.push(this.label(13, '#a7aebb', true, 5.5).setText('No-shows').setPosition(layout.strata.jail.x + 12, layout.strata.jail.y + 8));
        this.strataNames.push(this.label(13, '#dfe8ff', true, 2.5).setText('Dream').setPosition(layout.strata.heaven.x + 14, layout.strata.heaven.y + 10));
      }
      layout.grounds?.yards.forEach((yard, level) => {
        this.strataNames.push(this.label(13, '#e0c9a6', true, 2.5).setText(RECRUIT_STAGES[level]).setPosition(yard.x + 12, yard.y + 8));
      });
      for (const b of layout.buildings) {
        this.buildingNames.push(this.label(10, '#9aa7c2', false, 2.5).setText(b.name).setOrigin(0.5, 0));
      }
      if (layout.barn) this.barnText = this.label(10, '#9aa7c2', false, 2.5).setOrigin(0.5, 0);
      if (layout.stores && cargo) this.storeTexts = [0, 1, 2].map(() => this.label(10, '#9aa7c2', false, 2.5).setOrigin(0.5, 0));
      for (const unit of layout.units) {
        this.initials.push(this.label(9.5, '#f2f5fb', true, 4).setText(unitInitials(unit.name)).setOrigin(0.5, 0.5));
        this.homeInitials.push(homed(unit.kind) ? this.label(8.5, '#aab4c8', true, 3.5).setText(unitInitials(unit.name)).setOrigin(0.5, 0.5) : null);
        this.names.push(this.label(10, '#c3cbdb', false, 4).setText(unit.label).setOrigin(0.5, 0));
      }
      const float = () =>
        this.label(11, '#ffffff', true, 7)
          .setOrigin(0.5, 0)
          .setBackgroundColor('#0b0e14')
          .setPadding(4, 1, 4, 1)
          .setVisible(false);
      this.floatSelected = float();
      this.floatHover = float();
      this.tip = float().setOrigin(0.5, 1).setDepth(8);

      this.fit();
      this.scale.on('resize', () => {
        if (!this.cameraMoved) this.fit();
      });

      this.input.on('wheel', (pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const before = this.toWorld(pointer.x, pointer.y);
        if (this.pan) this.pan.left = 0;
        this.glide = null;
        cam.setZoom(clamp(cam.zoom * Math.exp(-dy * 0.0015), ZOOM_MIN * dpr, ZOOM_MAX * dpr));
        const after = this.toWorld(pointer.x, pointer.y);
        cam.scrollX += before.x - after.x;
        cam.scrollY += before.y - after.y;
        this.cameraMoved = true;
      });
      this.input.addPointer(1);
      this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (this.pan) this.pan.left = 0;
        this.glide = null;
        const pair = this.touches();
        if (pair) {
          const [a, b] = pair;
          this.pinch = {
            dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            zoom: this.cameras.main.zoom,
            world: this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
          };
          this.drag = this.grab(pointer, true);
          return;
        }
        this.drag = this.grab(pointer, false);
      });
      this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
        if (!pointer.wasTouch) this.pointer = { x: pointer.x, y: pointer.y };
        const cam = this.cameras.main;
        if (this.pinch) {
          const pair = this.touches();
          if (!pair) return;
          const [a, b] = pair;
          cam.setZoom(
            clamp((this.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.dist, ZOOM_MIN * dpr, ZOOM_MAX * dpr),
          );
          const now = this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
          cam.scrollX += this.pinch.world.x - now.x;
          cam.scrollY += this.pinch.world.y - now.y;
          this.cameraMoved = true;
          this.loose = true;
          return;
        }
        if (!this.drag || !pointer.isDown || pointer.id !== this.drag.id) return;
        const dx = pointer.x - this.drag.x;
        const dy = pointer.y - this.drag.y;
        if (Math.hypot(dx, dy) > (pointer.wasTouch ? TAP_SLOP : 4) * dpr) this.drag.moved = true;
        if (!this.drag.moved) return;
        cam.scrollX = this.drag.sx - dx / cam.zoom;
        cam.scrollY = this.drag.sy - dy / cam.zoom;
        this.cameraMoved = true;
        this.loose = true;
      });
      this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (this.pinch) {
          this.pinch = null;
          const rest = pointer === this.input.pointer1 ? this.input.pointer2 : this.input.pointer1;
          this.drag = rest.isDown ? this.grab(rest, true) : null;
          return;
        }
        if (!this.drag || pointer.id !== this.drag.id) return;
        if (!this.drag.moved) {
          this.click(pointer);
          this.sought = null;
        }
        this.drag = null;
      });
      this.input.on('pointerupoutside', () => {
        this.pinch = null;
        this.drag = null;
      });
      this.input.on('gameout', () => {
        this.pointer = null;
      });
      this.input.keyboard?.on('keydown-ESC', () => app.pick(null));
      app.onSelect((pick) => {
        this.sought = pick;
        this.loose = false;
      });
      app.onRepick(() => {
        this.sought = view.picked;
        this.loose = false;
      });
      this.events.on('render', this.paintCounters, this);
    }

    update(_time: number, delta: number) {
      app.advance(Math.min(delta, 100));
      const state = sim.state(view.t, view.speed);
      this.last = state;
      app.state = state;
      this.draw(state);
      this.follow(state, Math.min(delta, 100));
      app.frame();
    }

    private follow(state: SimState, delta: number) {
      if (app.look) {
        this.pan = { ...app.look, left: PAN_MS };
        app.look = null;
      }
      if (this.sought) {
        this.reveal(state, this.sought);
        this.sought = null;
      }
      const tail = !this.loose && view.picked?.kind === 'unit' ? this.spotOf(state, view.picked) : null;
      if (tail && this.glide) {
        this.glide.x = tail.x + tail.w / 2;
        this.glide.y = tail.y + tail.h / 2;
      } else if (tail) {
        const cam = this.cameras.main;
        const k = 1 - Math.exp(-delta / 110);
        cam.scrollX += (tail.x + tail.w / 2 - cam.width / 2 - cam.scrollX) * k;
        cam.scrollY += (tail.y + tail.h / 2 - cam.height / 2 - (barHeight() * dpr) / (2 * cam.zoom) - cam.scrollY) * k;
        this.cameraMoved = true;
      }
      const glide = this.glide;
      if (glide) {
        const cam = this.cameras.main;
        const k = glide.left <= delta ? 1 : 1 - Math.exp(-delta / 110);
        cam.setZoom(cam.zoom + (glide.zoom - cam.zoom) * k);
        cam.scrollX += (glide.x - cam.width / 2 - cam.scrollX) * k;
        cam.scrollY += (glide.y - cam.height / 2 - (barHeight() * dpr) / (2 * cam.zoom) - cam.scrollY) * k;
        this.cameraMoved = true;
        glide.left -= delta;
        if (glide.left <= 0) this.glide = null;
      }
      const pan = this.pan;
      if (!pan) return;
      if (view.picked?.kind !== 'trace' || view.picked.id !== pan.trace) {
        this.pan = null;
        return;
      }
      const at = cargo?.where(pan.trace, pan.key, PAN_AT) ?? null;
      const holder = at !== null && at >= 0 && !state.units[at]?.hidden ? at : -1;
      view.selected = holder >= 0 ? layout.units[holder].id : pan.actor;
      if (at === null) pan.left = 0;
      if (pan.left <= 0) return;
      if (holder >= 0 && this.ua[holder] > 0) {
        PAN_AT.x = this.ux[holder];
        PAN_AT.y = this.uy[holder];
      }
      const cam = this.cameras.main;
      const k = pan.left <= delta ? 1 : 1 - Math.exp(-delta / 110);
      cam.scrollX += (PAN_AT.x - cam.width / 2 - cam.scrollX) * k;
      cam.scrollY += (PAN_AT.y - cam.height / 2 - (barHeight() * dpr) / (2 * cam.zoom) - cam.scrollY) * k;
      this.cameraMoved = true;
      pan.left -= delta;
    }

    private spotOf(state: SimState, pick: Pick): Rect | null {
      const around = (p: Point | null | undefined) => (p ? { x: p.x - 30, y: p.y - 30, w: 60, h: 60 } : null);
      const regionRect = (id: string | null | undefined) => layout.regions.find((r) => r.id === id)?.rect ?? null;
      if (pick.kind === 'region') return regionRect(pick.id);
      if (pick.kind === 'building') return layout.buildings.find((b) => b.id === pick.id)?.rect ?? null;
      if (pick.kind === 'barn') return around(layout.barn);
      if (pick.kind === 'store') return around(layout.stores?.[pick.id.slice(6) as 'concept' | 'creative' | 'brief']);
      if (pick.kind === 'crowd') return around(state.crowds.find((c) => c.id === pick.id));
      if (pick.kind === 'unit') {
        const i = layout.index.get(pick.id);
        if (i === undefined) return null;
        return around(state.units[i].hidden ? state.crowds.find((c) => c.members?.includes(pick.id)) ?? layout.units[i] : state.units[i]);
      }
      const trace = app.traces.find((t) => t.id === pick.id);
      for (const key of [pick.id, ...(trace?.nodes.map((n) => n.key) ?? [])]) if (cargo?.where(pick.id, key, PAN_AT) != null) return around(PAN_AT);
      return regionRect(trace?.region);
    }

    private reveal(state: SimState, pick: Pick) {
      const rect = this.spotOf(state, pick);
      if (!rect) return;
      const cam = this.cameras.main;
      const bar = barHeight() * dpr;
      const pad = 24 * dpr;
      const zoom = Math.min(cam.zoom, Math.max(ZOOM_MIN * dpr, Math.min((cam.width - pad * 2) / rect.w, (cam.height - bar - pad * 2) / rect.h)));
      const lo = this.toWorld(pad, bar + pad);
      const hi = this.toWorld(cam.width - pad, cam.height - pad);
      if (zoom === cam.zoom && rect.x >= lo.x && rect.x + rect.w <= hi.x && rect.y >= lo.y && rect.y + rect.h <= hi.y) return;
      if (this.pan) this.pan.left = 0;
      this.glide = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom, left: PAN_MS };
    }

    rescale(ratio: number) {
      const cam = this.cameras.main;
      if (cam) cam.setZoom(cam.zoom * ratio);
      for (const child of this.children.list) if (child instanceof Phaser.GameObjects.Text) child.setResolution(RES);
    }

    refit() {
      this.cameraMoved = false;
      this.fit();
    }

    private touches() {
      const { pointer1, pointer2 } = this.input;
      return pointer1.isDown && pointer2.isDown ? ([pointer1, pointer2] as const) : null;
    }

    private grab(pointer: Phaser.Input.Pointer, moved: boolean) {
      const cam = this.cameras.main;
      return { id: pointer.id, x: pointer.x, y: pointer.y, sx: cam.scrollX, sy: cam.scrollY, moved };
    }

    private fit() {
      const cam = this.cameras.main;
      const width = this.scale.width;
      const height = this.scale.height;
      const bar = barHeight() * dpr;
      const b = layout.bounds;
      const zoom = clamp(
        Math.min((width - 24 * dpr) / b.w, (height - bar - 20 * dpr) / b.h),
        ZOOM_MIN * dpr,
        FIT_MAX * dpr,
      );
      cam.setZoom(zoom);
      cam.setScroll(b.x + b.w / 2 - width / 2, b.y + b.h / 2 - height / 2 - bar / (2 * zoom));
    }

    private toWorld(px: number, py: number) {
      const cam = this.cameras.main;
      return {
        x: (px - cam.width / 2) / cam.zoom + cam.scrollX + cam.width / 2,
        y: (py - cam.height / 2) / cam.zoom + cam.scrollY + cam.height / 2,
      };
    }

    private inView() {
      const lo = this.toWorld(0, 0);
      const hi = this.toWorld(this.cameras.main.width, this.cameras.main.height);
      return (r: { x: number; y: number; w: number; h: number }) => r.x < hi.x && r.x + r.w > lo.x && r.y < hi.y && r.y + r.h > lo.y;
    }

    private unitAt(state: SimState, p: Point, touch = false) {
      const reach = Math.max(R + 6, ((touch ? 22 : 14) * dpr) / this.cameras.main.zoom);
      let best: string | null = null;
      let bestDist = reach;
      state.units.forEach((unit, i) => {
        if (unit.hidden) return;
        const base = layout.units[i];
        const d = Math.min(
          Math.hypot(unit.x - p.x, unit.y - p.y),
          homed(base.kind) ? Math.hypot(base.x - p.x, base.y - p.y) / (base.palace ? PALACE : 1) : Infinity,
        );
        if (d <= bestDist) {
          bestDist = d;
          best = unit.id;
        }
      });
      return best;
    }

    private click(pointer: Phaser.Input.Pointer) {
      const state = this.last;
      if (!state) return;
      const p = this.toWorld(pointer.x, pointer.y);
      const unit = this.unitAt(state, p, pointer.wasTouch);
      if (unit) return app.pick({ kind: 'unit', id: unit });
      const crowd = state.crowds.find((c) => (!c.id.startsWith('applied/') || (view.show.sources.ashby && view.show.types.resume)) && Math.abs(p.x - c.x) <= 70 * this.grow && Math.abs(p.y - c.y) <= 26 * this.grow);
      if (crowd) return app.pick({ kind: 'crowd', id: crowd.id });
      if (layout.stores && cargo) for (const kind of ['concept', 'creative', 'brief'] as const) if (Math.hypot(p.x - layout.stores[kind].x, p.y - layout.stores[kind].y) <= 28) return app.pick({ kind: 'store', id: `store:${kind}` });
      const pile = cargo?.shelfAt(p);
      if (pile) return app.pick({ kind: pile.kind, id: pile.id, shelf: pile.shelf });
      const concept = cargo?.at(p);
      if (concept) return app.pick({ kind: 'trace', id: concept.id, ...(concept.items ? { items: concept.items } : {}) });
      if (layout.barn && Math.hypot(p.x - layout.barn.x, p.y - layout.barn.y) <= 34) return app.pick({ kind: 'barn', id: 'barn' });
      const b = layout.buildings.find(({ rect }) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h);
      if (b) return app.pick({ kind: 'building', id: b.id });
      const trailed = view.show.trail ? cargo?.trailAt(p, state.t) : null;
      if (trailed) return app.pick({ kind: 'trace', id: trailed });
      const region = layout.regions.find(
        ({ rect }) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h,
      );
      const now = view.picked;
      if (!region || (now?.kind === 'region' && now.id === region.id)) return app.pick(null);
      app.pick({ kind: 'region', id: region.id });
    }

    private sourceShown(resource: ResourceType | null, kind: string, actor: string, eventTime: number) {
      const source = resource ? typeSource[resource] : plainSource.get(`${kind}|${actor}|${Math.round(eventTime)}`);
      return !source || view.show.sources[source];
    }

    private draw(state: SimState) {
      const z = this.cameras.main.zoom / dpr;
      const thin = 1 / Math.min(1, z);
      const focus = traceFocus(app);
      const selected = focus ? focus.id : view.selected;
      const partners = selected && !focus ? sim.partners(selected).ids : null;
      const near = (id: string) => (focus ? focus.hands.has(id) : !selected || id === selected || partners!.has(id));

      const hover = this.pointer && !this.drag?.moved ? this.unitAt(state, this.toWorld(this.pointer.x, this.pointer.y)) : null;
      if (hover !== view.hover) {
        view.hover = hover;
        parent.style.cursor = hover ? 'pointer' : '';
      }

      this.drawRegions(state, thin);
      this.drawMeetings(state, thin, near);
      this.drawUnits(state, z, near);
      this.drawCargo(state, thin, focus?.id ?? null);
      this.drawAgents(state, near);
      this.drawTrophies(state);
      this.drawFx(state, z, thin, selected, near);
      if (focus) drawTrace(this.gFx, state, focus, layout, view.show, this.ux, this.uy, this.ua, R * this.grow, thin);
      this.labelRegions(state, z);
      this.labelUnits(state, z);

      const at = this.pointer && !this.drag?.moved ? this.toWorld(this.pointer.x, this.pointer.y) : null;
      const tip = at ? (cargo?.tip(at, state.t, app) ?? this.resourceAt(state, at)) : null;
      this.tip.setVisible(!!tip);
      if (tip && at) {
        if (this.tip.text !== tip) this.tip.setText(tip);
        this.tip.setScale(Math.max(1, 1 / z)).setPosition(at.x, at.y - 8 * Math.max(1, 1 / z));
      }
    }

    private resourceAt(state: SimState, p: Point) {
      const many = (n: number, label: string) => `${n.toLocaleString('en-US')} ${label}${n === 1 ? '' : 's'}`;
      const r = R * this.grow;
      for (let i = 0; i < count; i++) {
        const s = state.units[i];
        const side = layout.units[i].palace && this.atHome[i] ? r * PALACE : r;
        if (!s || s.hidden || this.ua[i] <= 0 || Math.abs(p.y - this.uy[i]) > 60 || p.x < this.ux[i] + side + 3 || p.x > this.ux[i] + side + 40) continue;
        const held = TYPES.filter((type) => view.show.types[type] && s.holding[type] > 0);
        for (let row = 0; row < held.length; row++) {
          const n = s.holding[held[row]];
          if (Math.abs(p.y - (this.uy[i] + (row - (held.length - 1) / 2) * 7.5)) > 3.75) continue;
          if (p.x <= this.ux[i] + side + 7 + (Math.min(n, 4) - 1) * 3.2 + 14) return `${layout.units[i].name} holds ${many(n, RESOURCE_LABELS[held[row]])}`;
        }
      }
      const scale = this.counterScale;
      for (let i = 0; i < layout.regions.length; i++) {
        const tally = this.tallies[i];
        const region = layout.regions[i];
        const { x, y, w, h } = region.rect;
        if (!tally?.length || this.regionAlpha[i] === UNBORN || p.x < x || p.x > x + w || p.y < y || p.y > y + h) continue;
        for (const { type, n, width, dx, row } of tally) {
          const px = x + w - 8 - dx;
          if (p.x > px + 2 * scale || p.x < px - (width + 15) * scale || Math.abs(p.y - (y + h - 6 - (6 + 14 * row) * scale)) > 7 * scale) continue;
          const place = app.regionName(region.id, region.name);
          if (type === 'win') return `${many(n, 'winning ad')} in ${place} so far`;
          if (type === 'launch') return `${many(n, 'creative')} launched in ${place} so far`;
          if (type === 'client_winner') return `${many(n, 'winning ad')} the client made in ${place} so far`;
          return `${many(n, RESOURCE_LABELS[type])} made in ${place} so far`;
        }
      }
      if (this.cameras.main.zoom / dpr < CELL_TIP) return null;
      for (const b of layout.buildings) {
        if (!b.features.length || p.x < b.rect.x || p.x > b.rect.x + b.rect.w || p.y < b.rect.y || p.y > b.rect.y + b.rect.h) continue;
        const cell = b.features.find(({ rect }) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h);
        const f = cell && state.features[featureAt.get(cell.id)!];
        if (!cell || !f) return null;
        return `${b.name}: ${cell.name} · ${f.total.toLocaleString('en-US')} so far${f.errors ? ` · ${many(f.errors, 'error')}` : ''}`;
      }
      return null;
    }

    private drawRegions(state: SimState, thin: number) {
      const g = this.gRegions;
      g.clear();
      const picked = view.picked;
      if (layout.strata) {
        const { core, band, gap } = layout.strata;
        for (let level = 0; level < LEAD_STAGES.length; level++) {
          const out = gap + band * (LEAD_STAGES.length - level);
          g.fillStyle(STRATUM, 0.04 + 0.015 * level);
          g.fillRoundedRect(core.x - out, layout.strata.top, band - 10, layout.strata.height, 24);
          g.lineStyle(1.2 * thin, STRATUM, 0.3);
          g.strokeRoundedRect(core.x - out, layout.strata.top, band - 10, layout.strata.height, 24);
        }
        const heaven = layout.strata.heaven;
        g.fillStyle(HEAVEN, 0.13);
        g.fillRoundedRect(heaven.x, heaven.y, heaven.w, heaven.h, 60);
        g.lineStyle(1.4 * thin, HEAVEN, 0.55);
        g.strokeRoundedRect(heaven.x, heaven.y, heaven.w, heaven.h, 60);
        g.fillStyle(HEAVEN, 0.16);
        for (let k = 0; k * 78 < heaven.w - 110; k++) {
          const cx = heaven.x + 60 + k * 78;
          g.fillCircle(cx, heaven.y + heaven.h - 6 + (k % 2) * 8, 34 + ((k * 7) % 3) * 8);
          g.fillCircle(cx + 30, heaven.y + 6 - (k % 3) * 6, 24 + ((k * 5) % 3) * 7);
        }
        const jail = layout.strata.jail;
        g.fillStyle(JAIL, 0.55);
        g.fillRect(jail.x, jail.y, jail.w, jail.h);
      }
      layout.regions.forEach((region, i) => {
        const { x, y, w, h } = region.rect;
        const root = region.kind === 'internal';
        let alpha = 1;
        let level = 0;
        if (!root) {
          const idle = state.t - lastTouch(i, state.t);
          alpha = idle > DAY ? DIM : 1;
          level = idle > DAY ? 0 : Math.exp(-idle / state.tauMs);
        }
        if (region.since !== undefined && state.t < region.since) {
          this.regionAlpha[i] = UNBORN;
          g.fillStyle(SEA, 0.9);
          g.fillPoints(terrain.islands[i].points as Phaser.Math.Vector2[], true);
          return;
        }
        this.regionAlpha[i] = alpha;
        const style = regionStyle[i];
        const shore = terrain.islands[i].points as Phaser.Math.Vector2[];
        const chosen = picked?.kind === 'region' && picked.id === region.id;
        if (alpha < 1) {
          g.fillStyle(SEA, 0.5);
          g.fillPoints(shore, true);
        }
        if (level > 0.02) {
          g.lineStyle(5 * thin, style.glow, 0.22 * level);
          g.strokePoints(shore, true);
        }
        g.lineStyle((chosen ? 2.2 : 1.1 + level) * thin, chosen ? WHITE : mix(style.edge, style.glow, level), chosen ? 1 : alpha < 1 ? 0.35 : 0.75);
        g.strokePoints(shore, true);
        g.fillStyle(BG, 0.4);
        g.fillRoundedRect(x + 8, y + h - region.foot, w - 16, region.foot - 6, 10);
      });

      const pulses = new Map<string, number>();
      for (const flight of state.flights) {
        if (flight.kind !== 'spawn' || !view.show.types[flight.resource]) continue;
        pulses.set(flight.from.id, Math.max(pulses.get(flight.from.id) ?? 0, 1 - flight.progress));
      }
      const fine = this.cameras.main.zoom / dpr >= CELL_FINE;
      const seen = this.inView();
      for (const b of layout.buildings) {
        const color = b.resource ? TYPE_COLOR[b.resource] : NEUTRAL;
        const pulse = pulses.get(b.id) ?? 0;
        const alpha = this.regionAlpha[regionIndex.get(b.region) ?? 0] || 1;
        const chosen = picked?.kind === 'building' && picked.id === b.id;
        if (b.features.length && seen(b.rect)) {
          g.fillStyle(0x0d121b, alpha);
          g.fillRoundedRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h, 7);
          g.lineStyle((chosen ? 2 : 1) * thin, chosen ? WHITE : mix(BG, color, 0.45), alpha);
          g.strokeRoundedRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h, 7);
          for (const cell of b.features) {
            if (fine && !seen(cell.rect)) continue;
            const f = state.features[featureAt.get(cell.id)!];
            const level = f ? Math.min(1, Math.log1p(f.use + f.run) / Math.log1p(60)) : 0;
            const alarm = f ? Math.min(1, Math.log1p(f.error) / Math.log1p(12)) : 0;
            g.fillStyle(mix(mix(CELL, color, 0.1 + 0.6 * level), ERROR, 0.75 * alarm), alpha);
            if (!fine) {
              g.fillRect(cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h);
              continue;
            }
            g.fillRoundedRect(cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h, 3);
            g.lineStyle(1 * thin, alarm > 0 ? mix(color, ERROR, 0.5 + 0.5 * alarm) : mix(0x2b3654, color, level), alpha);
            g.strokeRoundedRect(cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h, 3);
          }
        }
        if (pulse > 0) {
          g.lineStyle(2 * thin, color, pulse * 0.9);
          g.strokeCircle(b.x, b.y, b.size * (0.62 + 0.5 * (1 - pulse)));
        }
        if (chosen) {
          g.lineStyle(2 * thin, WHITE, 1);
          g.strokeCircle(b.x, b.y - 2, b.size * 0.64);
        }
        drawBuilding(
          g,
          b.resource,
          b.x,
          b.y,
          (b.size / 34) * (1 + 0.16 * pulse * pulse),
          mix(BG, color, 0.2 + 0.45 * pulse),
          mix(BG, color, 0.5 + 0.4 * pulse),
          mix(color, WHITE, 0.5 * pulse),
          alpha,
        );
      }
    }

    private drawMeetings(state: SimState, thin: number, near: (id: string) => boolean) {
      const g = this.gMeetings;
      g.clear();
      if (!view.show.sources.calendar) return;
      for (const meeting of state.meetings) {
        const lit = meeting.members.some((m) => near(m.id) && (!view.selected || m.id === view.selected));
        const alpha = (view.selected ? (lit ? 1 : 0.2) : 0.9) * meeting.alpha;
        drawTable(g, meeting.x, meeting.y, meeting.radius, TABLE, MEETING, Math.max(1.2, 1.1 * thin), alpha);
      }
    }

    private drawUnits(state: SimState, z: number, near: (id: string) => boolean) {
      const g = this.gUnits;
      g.clear();
      const show = view.show.types;
      const selected = view.selected;
      const numbers = z >= COUNT_ZOOM;
      const grow = clamp(0.82 / z, 1, 1.3);
      const r = R * grow;
      this.grow = grow;
      let texts = 0;
      layout.units.forEach((unit, i) => {
        const s = state.units[i];
        this.ha[i] = 0;
        this.atHome[i] = 0;
        this.homeLit[i] = 0;
        if (!s || s.hidden || !homed(unit.kind)) return;
        const c = unitColors[unit.kind];
        const picked = unit.id === selected || unit.id === view.hover;
        const inside = Math.hypot(s.dx, s.dy) < r * 0.5;
        const lit = inside && !(view.show.sources.calendar && s.busy === 'ooo');
        const alpha = (near(unit.id) ? 1 : FAR) * (this.regionAlpha[unitRegion[i]] || 1) * (lit || picked ? 1 : 0.7);
        this.ha[i] = alpha;
        this.atHome[i] = inside ? 1 : 0;
        this.homeLit[i] = lit ? 1 : 0;
        (unit.palace ? drawPalace : unit.kind === 'ambassador' ? drawStall : drawHome)(
          g,
          unit.x,
          unit.y,
          unit.palace ? r * PALACE : r,
          lit ? mix(LIGHT, WHITE, unit.palace ? 0.65 : 0.6 * s.activity) : mix(BG, c.fill, 0.3),
          unit.palace ? mix(BG, TROPHY, lit ? 1 : 0.45) : unit.kind === 'ambassador' ? mix(BG, c.edge, lit ? 1 : 0.45) : lit ? mix(c.fill, c.edge, 0.6 * s.activity) : mix(BG, c.edge, 0.4),
          picked ? WHITE : lit ? mix(c.edge, WHITE, 0.8 * s.activity) : mix(BG, c.edge, 0.7),
          alpha,
          lit ? LIGHT : null,
        );
      });
      layout.units.forEach((unit, i) => {
        const s = state.units[i];
        if (!s) return;
        if (s.hidden) {
          this.ua[i] = 0;
          return;
        }
        const inside = this.atHome[i] === 1;
        const x = inside ? unit.x : unit.x + s.dx;
        const y = inside ? unit.y : unit.y + s.dy;
        const busy = view.show.sources.calendar ? s.busy : null;
        const alpha = (near(unit.id) ? 1 : FAR) * (this.regionAlpha[unitRegion[i]] || 1) * (busy === 'ooo' ? 0.4 : 1);
        this.ux[i] = x;
        this.uy[i] = y;
        this.ua[i] = alpha;
        const c = unitTint[i];
        if (!inside) {
          unitSprite(
            g,
            unit.sprite ?? unit.role,
            x,
            y,
            r,
            busy === 'ooo' ? BG : mix(c.fill, c.edge, 0.6 * s.activity),
            busy === 'ooo' ? AWAY : mix(c.edge, WHITE, 0.8 * s.activity),
            alpha,
          );
        }
        if (busy === 'ooo') {
          g.lineStyle(1.6, AWAY, alpha);
          g.lineBetween(x - r * 0.7, y + r * 0.7, x + r * 0.7, y - r * 0.7);
        } else if (busy === 'meeting') {
          g.lineStyle(1.6, MEETING, alpha);
          g.strokeCircle(x, y, r + 2.6);
          g.fillStyle(MEETING, alpha);
          g.lineStyle(0.8, BG, alpha);
          g.fillCircle(x - r * 0.92, y + r * 0.92, 3.4 * grow);
          g.strokeCircle(x - r * 0.92, y + r * 0.92, 3.4 * grow);
        }
        if (unit.id === selected || unit.id === view.hover) {
          g.lineStyle((unit.id === selected ? 2 : 1.2) / Math.min(1, z), WHITE, unit.id === selected ? 1 : 0.7);
          g.strokeCircle(x, y, r + 4.5);
        }

        const side = inside && unit.palace ? r * PALACE : r;
        let rows = 0;
        for (const type of TYPES) if (show[type] && s.holding[type] > 0) rows++;
        let row = 0;
        for (const type of TYPES) {
          const held = s.holding[type];
          if (!show[type] || held <= 0) continue;
          const gy = y + (row - (rows - 1) / 2) * 7.5;
          const pips = Math.min(held, 4);
          g.fillStyle(TYPE_COLOR[type], alpha);
          g.lineStyle(0.8, BG, alpha);
          for (let j = pips - 1; j >= 0; j--) {
            resourcePath(g, type, x + side + 7 + j * 3.2, gy, 2.7);
            g.fillPath();
            g.strokePath();
          }
          const end = x + side + 7 + (pips - 1) * 3.2 + 5;
          if (numbers && held > 1) {
            const text = this.pooled(this.holdTexts, texts++, 7.5, 4);
            const value = String(held);
            if (text.text !== value) text.setText(value);
            paint(text, RESOURCE_COLORS[type]).setOrigin(0, 0.5).setPosition(end, gy).setAlpha(alpha);
          } else if (held > 4) {
            g.fillStyle(WHITE, alpha * 0.85);
            g.fillCircle(end + 0.5, gy, 1.1);
          }
          row++;
        }
      });
      for (let i = texts; i < this.holdTexts.length; i++) this.holdTexts[i].setVisible(false);
      let crowds = 0;
      for (const crowd of state.crowds) {
        if (crowd.id.startsWith('applied/') && !(view.show.sources.ashby && show.resume)) continue;
        const c = tinted(crowd.kind, crowd.origin);
        const text = this.pooled(this.crowdTexts, crowds++, 30, 4);
        const value = crowd.count.toLocaleString('en-US');
        if (text.text !== value) text.setText(value);
        const size = r * 2;
        const left = crowd.x - (size * 2 + 8 + text.width * grow) / 2;
        if (view.picked?.kind === 'crowd' && view.picked.id === crowd.id) {
          const w = size * 2 + 8 + text.width * grow;
          g.lineStyle(2 / Math.min(1, z), WHITE, 1);
          g.strokeRoundedRect(left - 8, crowd.y - size - 8, w + 16, size * 2 + 16, 8);
        }
        unitSprite(g, crowd.role, left + size, crowd.y, size, c.fill, c.edge, 1);
        paint(text, crowd.kind === 'prospect' ? originColor(crowd.origin) : UNIT_COLORS[crowd.kind].edge).setOrigin(0, 0.5).setScale(grow).setPosition(left + size * 2 + 8, crowd.y).setAlpha(1);
      }
      for (let i = crowds; i < this.crowdTexts.length; i++) this.crowdTexts[i].setVisible(false);
      if (layout.barn && this.barnText) {
        const c = unitColors.automation;
        if (view.picked?.kind === 'barn') {
          g.lineStyle(2 / Math.min(1, z), WHITE, 1);
          g.strokeCircle(layout.barn.x, layout.barn.y, 36);
        }
        drawBarn(g, layout.barn.x, layout.barn.y, 1.5, mix(BG, c.edge, 0.25), mix(BG, c.edge, 0.5), c.edge);
        const value = `Automations · ${state.stabled.length}`;
        if (this.barnText.text !== value) this.barnText.setText(value);
        this.barnText.setScale(grow).setPosition(layout.barn.x, layout.barn.y + 27);
      }
    }

    private drawCargo(state: SimState, thin: number, focus: string | null) {
      if (!cargo) return;
      const seen = this.inView() as (rect: Rect) => boolean;
      this.gTrails.setVisible(view.show.trail);
      if (view.show.trail) cargo.trail(this.gTrails, state, focus);
      cargo.draw(this.gCargo, state, this.ux, this.uy, this.ua, thin, focus, view.show.types, seen);
      const spots = layout.stores ? [layout.stores.concept, layout.stores.creative, layout.stores.brief] : [];
      if (view.picked?.kind === 'store' && spots.length) {
        const spot = spots[STORE_IDS.indexOf(view.picked.id)] ?? spots[0];
        this.gCargo.lineStyle(2 * thin, WHITE, 1);
        this.gCargo.strokeCircle(spot.x, spot.y + 2, 38);
      }
      this.storeTexts.forEach((text, i) => {
        const value = `${STORE_NAMES[i]} · ${cargo.stored[i].toLocaleString('en-US')}`;
        if (text.text !== value) text.setText(value);
        text.setScale(this.grow).setPosition(spots[i].x, spots[i].y + 25);
      });
      let used = 0;
      for (let n = 0; n < cargo.shelves.n.length; n++) {
        if (!cargo.shelves.n[n]) continue;
        const text = this.pooled(this.shelfTexts, used++, 9, 3.6);
        const value = cargo.shelves.n[n].toLocaleString('en-US');
        if (text.text !== value) text.setText(value);
        paint(text, RESOURCE_COLORS[cargo.shelfType(n)!] ?? COLORS.away).setOrigin(0, 0.5).setPosition(cargo.shelves.x[n] + 11, cargo.shelves.y[n]).setAlpha(focus ? 0.6 : 1);
      }
      for (let i = used; i < this.shelfTexts.length; i++) this.shelfTexts[i].setVisible(false);
    }

    private drawAgents(state: SimState, near: (id: string) => boolean) {
      const g = this.gUnits;
      let badges = 0;
      if (view.show.sources.sessions) {
        const byOwner = new Map<string, AgentState[]>();
        for (const m of state.agents) {
          const list = byOwner.get(m.owner);
          if (list) list.push(m);
          else byOwner.set(m.owner, [m]);
        }
        const fade = state.lifeMs * 0.6;
        for (const [owner, list] of byOwner) {
          const oi = layout.index.get(owner);
          const dim = oi === undefined ? (near(owner) ? 1 : FAR) : this.ua[oi];
          const grow = this.grow;
          const at = new Map<string, Point>();
          const kids = new Map<string, number>();
          const used = new Set<number>();
          let drawn = 0;
          for (const m of list) {
            if (drawn >= MAX_AGENTS) break;
            const parentAt = m.parent ? at.get(m.parent) : undefined;
            let x = oi === undefined ? m.x : this.ux[oi] + (m.x - this.ux[oi]) * grow;
            let y = oi === undefined ? m.y : this.uy[oi] + (m.y - this.uy[oi]) * grow;
            let r = 5 * grow;
            if (parentAt) {
              const k = kids.get(m.parent!) ?? 0;
              kids.set(m.parent!, k + 1);
              x = parentAt.x + KID_OFFSETS[k % 4].x * grow;
              y = parentAt.y + KID_OFFSETS[k % 4].y * grow;
              r = 3.3 * grow;
            } else {
              const key = Math.round(x * 4) * 131071 + Math.round(y * 4);
              if (used.has(key)) continue;
              used.add(key);
            }
            at.set(m.id, { x, y });
            const life = clamp(Math.min(m.ageMs, m.remainingMs) / fade, 0, 1);
            const beat = m.active ? 0.5 + 0.5 * Math.sin((m.ageMs / state.lifeMs) * Math.PI * 2) : 0;
            const alpha = dim * life * (m.active ? 0.85 + 0.15 * beat : 0.55);
            if (parentAt) {
              g.lineStyle(0.8, AGENT, alpha * 0.7);
              g.lineBetween(parentAt.x, parentAt.y, x, y);
            }
            if (m.active) {
              g.lineStyle(1.1, AGENT, alpha * 0.55 * (1 - beat));
              g.strokeCircle(x, y, r * (1.5 + 0.7 * beat));
            }
            unitSprite(g, 'cat', x, y, r * (m.active ? 1 + 0.16 * beat : 0.88), m.active ? AGENT : AGENT_IDLE, BG, alpha, Math.max(0.5, r * 0.12));
            drawn++;
          }
          if (list.length > drawn && oi !== undefined) {
            const text = this.pooled(this.badgeTexts, badges++, 8, 4);
            const value = `+${list.length - drawn}`;
            if (text.text !== value) text.setText(value);
            paint(text, COLORS.agent)
              .setOrigin(0, 0.5)
              .setPosition(this.ux[oi] + (SLOT_STEP * 1.5 + 7) * grow, this.uy[oi] - (R + 7) * grow)
              .setAlpha(dim);
          }
        }
      }
      for (let i = badges; i < this.badgeTexts.length; i++) this.badgeTexts[i].setVisible(false);
    }

    private drawTrophies(state: SimState) {
      const g = this.gUnits;
      this.trophyCount.fill(0);
      this.winCount.fill(0);
      this.clientCount.fill(0);
      const marks = new Map<number, number>();
      for (const trophy of state.trophies) {
        const ri = trophy.region ? regionIndex.get(trophy.region) : undefined;
        if (ri !== undefined && trophy.kind === 'client_winner') this.clientCount[ri] += trophy.count ?? 1;
        else if (ri !== undefined) {
          this.trophyCount[ri] += trophy.count ?? 1;
          if (trophy.kind === 'winning_ad') this.winCount[ri] += trophy.count ?? 1;
        }
        const ui = trophy.unit ? layout.index.get(trophy.unit) : undefined;
        if (ui !== undefined) marks.set(ui, Math.min(marks.get(ui) ?? Infinity, trophy.ageMs));
      }
      for (const [ui, age] of marks) {
        const off = R * this.grow * 0.92;
        starPath(g, this.ux[ui] - off, this.uy[ui] - off, 4.4 * pop(age / state.lifeMs));
        g.fillStyle(TROPHY, this.ua[ui]);
        g.fillPath();
        g.lineStyle(0.8, BG, this.ua[ui]);
        g.strokePath();
      }
    }

    private drawFx(state: SimState, z: number, thin: number, selected: string | null, near: (id: string) => boolean) {
      const g = this.gFx;
      g.clear();
      if (layout.strata) {
        const jail = layout.strata.jail;
        g.lineStyle(2.4 * thin, BARS, 0.75);
        for (let x = jail.x + BAR_STEP; x < jail.x + jail.w - 4; x += BAR_STEP) g.lineBetween(x, jail.y + 30, x, jail.y + jail.h);
        g.lineStyle(3.2 * thin, BARS, 0.95);
        g.strokeRect(jail.x, jail.y, jail.w, jail.h);
        g.lineBetween(jail.x, jail.y + 30, jail.x + jail.w, jail.y + 30);
      }
      const show = view.show;
      const shown = (resource: ResourceType | null) => !resource || show.types[resource];

      const bulk = new Map<string, RingState[]>();
      for (const ring of state.rings) {
        if (!shown(ring.resource)) continue;
        if (!this.sourceShown(ring.resource, ring.kind, ring.actor, state.t - ring.progress * state.lifeMs)) continue;
        const dim = !selected || ring.at === selected || ring.actor === selected ? 1 : 0.25;
        const color = ring.resource ? TYPE_COLOR[ring.resource] : ring.kind === 'bulk' ? BULK : NEUTRAL;
        if (ring.kind === 'status') {
          if (!ring.resource) continue;
          const on = ring.status === 'active';
          const alpha = Math.min(1, ring.alpha * 1.6) * dim;
          if (on) {
            g.lineStyle(1.3 * thin, color, ring.alpha * 0.9 * dim);
            g.strokeCircle(ring.x, ring.y, ring.radius);
          }
          resourcePath(g, ring.resource, ring.x, ring.y, (3.6 + Math.min(2.4, Math.log1p(ring.count) * 0.6)) * thin);
          g.fillStyle(on ? color : BG, alpha);
          g.fillPath();
          g.lineStyle(1.2 * thin, color, alpha);
          g.strokePath();
          continue;
        }
        if (ring.kind === 'edit') {
          const cos = Math.cos(ring.angle);
          const sin = Math.sin(ring.angle);
          g.lineStyle(1.3 * thin, color, ring.alpha * 0.6 * dim);
          g.lineBetween(ring.x + cos * (R + 3), ring.y + sin * (R + 3), ring.x + cos * (R + 9), ring.y + sin * (R + 9));
          continue;
        }
        if (ring.kind === 'comment') {
          g.lineStyle(1.3 * thin, color, ring.alpha * 0.75 * dim);
          for (let k = 0; k < 6; k++) {
            const a = ring.angle + (k * Math.PI) / 3;
            g.beginPath();
            g.arc(ring.x, ring.y, ring.radius, a, a + 0.62);
            g.strokePath();
          }
          continue;
        }
        const width = ring.kind === 'bulk' ? 3.6 : ring.kind === 'done' ? 2.6 : 1.3;
        g.lineStyle(width * thin, color, ring.alpha * 0.95 * dim);
        g.strokeCircle(ring.x, ring.y, ring.radius);
        if (ring.kind === 'done') {
          g.fillStyle(color, ring.alpha * 0.18 * dim);
          g.fillCircle(ring.x, ring.y, ring.radius);
        }
        if (ring.kind === 'bulk') {
          const list = bulk.get(ring.at);
          if (list) list.push(ring);
          else bulk.set(ring.at, [ring]);
        }
      }

      let labels = 0;
      const scale = clamp(0.9 / z, 1, 2);
      for (const list of bulk.values()) {
        list.sort((a, b) => a.progress - b.progress);
        let above = Infinity;
        for (const ring of list) {
          const y = Math.min(ring.y - ring.radius - 3 * thin, above - 13 * scale);
          above = y;
          const text = this.pooled(this.bulkTexts, labels++, 12, 6);
          const value = `×${ring.count}`;
          if (text.text !== value) text.setText(value);
          paint(text, ring.resource ? RESOURCE_COLORS[ring.resource] : COLORS.bulk)
            .setOrigin(0.5, 1)
            .setScale(scale)
            .setPosition(ring.x, y)
            .setAlpha(Math.min(1, ring.alpha * 1.6) * (!selected || ring.at === selected || ring.actor === selected ? 1 : 0.25));
        }
      }
      for (let i = labels; i < this.bulkTexts.length; i++) this.bulkTexts[i].setVisible(false);

      for (const pulse of state.pulses) {
        if (!show.sources[pulse.source]) continue;
        const dim = !selected || pulse.from.id === selected ? 1 : 0.2;
        g.lineStyle(1 * thin, USE, 0.28 * (1 - pulse.progress) * dim);
        g.lineBetween(pulse.from.x, pulse.from.y, pulse.x, pulse.y);
        g.fillStyle(USE, 0.95 * dim);
        g.fillCircle(pulse.x, pulse.y, (1.8 + Math.min(2.2, Math.log1p(pulse.count) * 0.7)) * thin);
        if (pulse.via && show.sources.sessions) {
          g.fillStyle(AGENT, 0.95 * dim);
          g.fillCircle(pulse.x + 3 * thin, pulse.y - 3 * thin, 1.4 * thin);
        }
      }

      for (const flight of state.flights) {
        if (!show.types[flight.resource]) continue;
        if (flight.kind === 'spawn' && flight.trace && cargo?.carried(flight.resource)) continue;
        const source = typeSource[flight.resource];
        if (source && !show.sources[source]) continue;
        const dim = !selected || flight.from.id === selected || flight.to.id === selected ? 1 : 0.25;
        const size = (flight.kind === 'send' ? 4.6 : flight.kind === 'spawn' ? 3.6 : 3) * thin;
        g.fillStyle(shadeColor(flight.resource, flight.shade), dim);
        resourcePath(g, flight.resource, flight.x, flight.y, size);
        g.fillPath();
        g.lineStyle((flight.isReturn ? 1.8 : 1) * thin, flight.isReturn ? RETURN : BG, dim);
        g.strokePath();
        if (flight.kind === 'spawn') {
          g.lineStyle(1 * thin, WHITE, 0.8 * (1 - flight.progress) * dim);
          g.strokeCircle(flight.x, flight.y, size + 3 * thin);
        }
        if (flight.via && show.sources.sessions) {
          g.fillStyle(AGENT, 0.95 * dim);
          g.fillCircle(flight.x + size * 1.25, flight.y - size * 1.25, 1.7 * thin);
        }
      }
    }

    private counterLines(counter: CounterState | undefined) {
      const parts: [string, string][] = [];
      if (counter && view.show.sources.money) {
        if (Object.keys(counter.adSpend).length) parts.push([money(counter.adSpend), ' spend']);
        const cost = counter.goal ? fmtCostPer(counter.adSpend, counter.conversions, counter.goal.target) : '';
        if (cost) parts.push([cost.replace(/ \/ /, '/'), ' CPA']);
        if (Object.keys(counter.feeRevenue).length) parts.push([money(counter.feeRevenue), ' fees']);
      }
      if (counter && view.show.sources.spend && view.show.sources.money) {
        const spent: Record<string, number> = {};
        for (const totals of Object.values(counter.expenses)) for (const currency in totals) spent[currency] = (spent[currency] ?? 0) + totals[currency];
        if (Object.keys(spent).length) parts.push([money(spent), ' costs']);
      }
      if (counter && counter.tokens > 0 && view.show.sources.sessions) parts.push([fmtCompact(Math.round(counter.tokens)), ' tok']);
      if (counter && counter.active.ad > 0 && view.show.sources.outputs && view.show.types.ad) parts.push([fmtCompact(counter.active.ad), ' ads live']);
      if (counter && view.show.sources.ashby && view.show.types.resume) {
        if (counter.active.resume > 0) parts.push([fmtCompact(counter.active.resume), ' resumes in play']);
        if (counter.inactive.resume > 0) parts.push([fmtCompact(counter.inactive.resume), ' passed']);
      }
      return [parts.map(([value, unit]) => value + unit).join(' · '), parts.map(([value]) => value).join(' · ')];
    }

    private labelRegions(state: SimState, z: number) {
      const bucket = Math.round(z * 24);
      const refit = bucket !== this.labelBucket;
      this.labelBucket = bucket;
      const sName = clamp(11.5 / (13 * z), 1, 1.7);
      const sRoot = clamp(14 / (22 * z), 1, 1.3);
      const sCount = clamp(10 / (10.5 * z), 1, 1.75);
      const now = performance.now();
      const tally = refit || now - this.countersAt >= COUNTER_MS;
      if (tally) this.countersAt = now;
      const counters = tally ? new Map(state.counters.map((counter) => [counter.region, counter])) : null;
      if (refit) for (const name of this.strataNames) name.setScale(sName);
      layout.regions.forEach((region, i) => {
        const { x, y, w } = region.rect;
        const root = region.kind === 'internal';
        const name = this.regionNames[i];
        const scale = root ? sRoot : sName;
        if (refit) {
          fitText(name, region.since !== undefined && region.since > app.data.window.start ? `New: ${region.name}` : region.name, (w - 16) / scale);
          name.setScale(scale).setPosition(x + 8, y + 5);
          this.counterAt[i].x = x + 8;
          this.counterAt[i].y = y + 5 + (root ? 27 : 15.5) * scale;
        }
        if (counters) {
          const [long, short] = this.counterLines(counters.get(region.id));
          const key = `${bucket}|${long}`;
          if (key !== this.counterKeys[i]) {
            this.counterKeys[i] = key;
            const limit = (w - 16) / sCount;
            this.counterShown[i] = fit(COUNTER_FONT, widthOf(COUNTER_FONT, long) <= limit ? long : short, limit);
          }
          const made = counters.get(region.id)?.made;
          const entry = (type: ResourceType | 'win' | 'launch', n: number) => {
            const value = fmtCompact(n);
            return { type, n, value, width: widthOf(COUNTER_FONT, value), dx: 0, row: 0 };
          };
          const tally = made ? TYPES.filter((type) => view.show.types[type] && made[type] > 0).map((type) => entry(type, made[type])) : [];
          if (this.clientCount[i] > 0 && view.show.types.client_winner) tally.push(entry('client_winner', this.clientCount[i]));
          if (this.winCount[i] > 0) tally.push(entry('win', this.winCount[i]));
          if (this.trophyCount[i] > this.winCount[i]) tally.push(entry('launch', this.trophyCount[i] - this.winCount[i]));
          for (;;) {
            let dx = 0;
            let row = 0;
            for (let k = tally.length - 1; k >= 0; k--) {
              const span = (tally[k].width + 20) * sCount;
              if (dx > 0 && dx + span > w - 16) {
                dx = 0;
                row++;
              }
              tally[k].dx = dx;
              tally[k].row = row;
              dx += span;
            }
            if (row < TALLY_ROWS) break;
            tally.splice(tally.reduce((least, item, k) => (item.n < tally[least].n ? k : least), 0), 1);
          }
          this.tallies[i] = tally;
        }
        name.setVisible(view.show.regions).setAlpha(this.regionAlpha[i] === UNBORN ? 0 : this.regionAlpha[i] < 1 ? 0.6 : 1);
      });
      this.counterScale = sCount;
      if (!refit) return;
      const sGroup = clamp(10.5 / (12 * z), 1, 1.5);
      layout.groups.forEach((group, i) => {
        const text = this.groupNames[i];
        fitText(text, group.name, (group.rect.w - 16) / sGroup);
        text.setScale(sGroup).setPosition(group.rect.x + 8, group.rect.y + 5).setAlpha(0.45);
      });
      const sBuilding = clamp(9.5 / (10 * z), 1, 1.4);
      layout.buildings.forEach((b, i) => {
        const text = this.buildingNames[i];
        fitText(text, b.name, Math.max(66, b.rect.w - 8) / sBuilding);
        text.setScale(sBuilding).setPosition(b.x, b.y + b.size / 2 + 3);
      });
    }

    private paintCounters(renderer: Phaser.Renderer.Canvas.CanvasRenderer) {
      const ctx = renderer.gameContext;
      const cam = this.cameras.main;
      const zoom = cam.zoom;
      ctx.save();
      ctx.setTransform(
        zoom,
        0,
        0,
        zoom,
        cam.width / 2 - (cam.scrollX + cam.width / 2) * zoom,
        cam.height / 2 - (cam.scrollY + cam.height / 2) * zoom,
      );
      ctx.font = `${COUNTER_SIZE * this.counterScale}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = COUNTER_COLOR;
      for (let i = 0; i < layout.regions.length; i++) {
        const value = this.counterShown[i];
        if (!value || this.regionAlpha[i] === UNBORN) continue;
        ctx.globalAlpha = this.regionAlpha[i] < 1 ? 0.6 : 1;
        ctx.fillText(value, this.counterAt[i].x, this.counterAt[i].y + 1.5 * this.counterScale);
      }
      const s = this.counterScale;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (let i = 0; i < layout.regions.length; i++) {
        const tally = this.tallies[i];
        if (!tally?.length || this.regionAlpha[i] === UNBORN) continue;
        const { x, y, w, h } = layout.regions[i].rect;
        ctx.globalAlpha = this.regionAlpha[i] < 1 ? 0.6 : 1;
        for (const { type, value, width, dx, row } of tally) {
          const px = x + w - 8 - dx;
          const py = y + h - 6 - (6 + 14 * row) * s;
          ctx.fillStyle = COUNTER_COLOR;
          ctx.fillText(value, px, py + 0.5 * s);
          if (type === 'win' || type === 'launch') {
            starPath(ctx, px - (width + 8) * s, py, 5 * s);
            ctx.fillStyle = COLORS.trophy;
            ctx.strokeStyle = COLORS.trophy;
            ctx.lineWidth = 1.1 * s;
            if (type === 'win') ctx.fill();
            else ctx.stroke();
            continue;
          }
          ctx.fillStyle = RESOURCE_COLORS[type];
          resourcePath(ctx, type, px - (width + 8) * s, py, 3.4 * s);
          ctx.fill();
        }
      }
      const state = this.last;
      if (state) {
        const sb = clamp(9.5 / ((10 * zoom) / dpr), 1, 1.4);
        ctx.font = `bold ${9 * sb}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = 1;
        const bills = billsOf(app.data, app.carried.bills);
        layout.buildings.forEach((b, i) => {
          const source = bills.source(b.id);
          ctx.fillStyle = bills.income(b.id) ? COLORS.moneyIn : COLORS.moneyOut;
          if (source && view.show.sources[source] && view.show.sources.money) ctx.fillText(money(bills.total(b.id, state.t)), b.x + this.buildingNames[i].displayWidth / 2 + 4 * sb, b.y + b.size / 2 + 3 + 1.2 * sb);
        });
      }
      if (state && zoom / dpr >= CELL_ZOOM) {
        ctx.font = `${CELL_SIZE}px ${FONT}`;
        ctx.textBaseline = 'middle';
        const seen = this.inView();
        for (let i = 0; i < layout.features.length; i++) {
          const cell = layout.features[i];
          if (!seen(cell.rect)) continue;
          const f = state.features[i];
          const hot = f && f.use + f.run > 0;
          ctx.globalAlpha = hot ? 1 : 0.7;
          ctx.textAlign = 'left';
          ctx.fillStyle = hot ? '#e6ebf5' : '#9aa7c2';
          ctx.fillText(cellNames[i], cell.rect.x + 4, cell.y + 0.5);
          if (!f || f.total + f.errors <= 0) continue;
          ctx.textAlign = 'right';
          ctx.fillStyle = f.error > 0 ? COLORS.error : '#c3cbdb';
          ctx.fillText(fmtCompact(f.total || f.errors), cell.rect.x + cell.rect.w - 4, cell.y + 0.5);
        }
      }
      ctx.restore();
    }

    private foot(i: number) {
      return layout.units[i].palace && this.atHome[i] ? R * PALACE * 0.55 * this.grow + 5 : R + 3;
    }

    private float(text: Text, index: number, z: number) {
      if (index < 0 || !view.show.entities) {
        text.setVisible(false);
        return;
      }
      const name = layout.units[index].name;
      if (text.text !== name) text.setText(name);
      text
        .setVisible(true)
        .setScale(Math.max(1, 1 / z))
        .setPosition(this.ux[index], this.uy[index] + (this.foot(index) - 3) * this.grow + 3);
    }

    private planNames(z: number, selected: number, hover: number) {
      const key = `${Math.round(z * 24)}|${selected}|${hover}`;
      if (key === this.namesKey) return;
      this.namesKey = key;
      this.nameShown.fill(0);
      if (z < NAME_ZOOM) return;
      const boxes: number[] = [];
      const free = (x0: number, y0: number, x1: number, y1: number) => {
        for (let i = 0; i < boxes.length; i += 4) {
          if (x0 < boxes[i + 2] && x1 > boxes[i] && y0 < boxes[i + 3] && y1 > boxes[i + 1]) return false;
        }
        return true;
      };
      const scale = Math.max(1, 1 / z);
      for (const index of [selected, hover]) {
        if (index < 0) continue;
        const unit = layout.units[index];
        const text = index === selected ? this.floatSelected : this.floatHover;
        const half = (text.width * scale) / 2;
        boxes.push(unit.x - half, unit.y + this.foot(index), unit.x + half, unit.y + this.foot(index) + text.height * scale);
      }
      layout.units.forEach((unit, i) => {
        if (i === selected || i === hover) return;
        const half = this.names[i].width / 2 + 1;
        const top = unit.y + this.foot(i);
        if (!free(unit.x - half, top, unit.x + half, top + 12)) return;
        boxes.push(unit.x - half, top, unit.x + half, top + 12);
        this.nameShown[i] = 1;
      });
    }

    private labelUnits(state: SimState, z: number) {
      const selected = view.selected ? layout.index.get(view.selected) ?? -1 : -1;
      const hover = view.hover ? layout.index.get(view.hover) ?? -1 : -1;
      this.float(this.floatSelected, selected, z);
      this.float(this.floatHover, hover === selected ? -1 : hover, z);
      this.planNames(z, selected, hover);
      const showInitials = z >= INITIALS_ZOOM;
      for (let i = 0; i < count; i++) {
        const s = state.units[i];
        const initials = this.initials[i];
        const name = this.names[i];
        const alpha = this.ua[i];
        const door = this.homeInitials[i];
        if (door) {
          door.setVisible(showInitials && this.ha[i] > 0);
          if (door.visible) {
            paint(door, this.homeLit[i] ? '#2a1c04' : '#aab4c8')
              .setPosition(layout.units[i].x, layout.units[i].y + R * this.grow * (layout.units[i].palace ? -0.1 * PALACE : layout.units[i].kind === 'ambassador' ? 0.62 : 0.42))
              .setScale(this.grow * (layout.units[i].palace ? 1.5 : 1))
              .setAlpha(this.ha[i]);
          }
        }
        initials.setVisible(showInitials && !this.atHome[i]);
        if (initials.visible) initials.setPosition(this.ux[i], this.uy[i] + SPRITE_CHEST * this.grow).setScale(this.grow).setAlpha(alpha);
        const named = this.nameShown[i] === 1;
        name.setVisible(named && view.show.entities);
        if (name.visible) name.setPosition(this.ux[i], this.uy[i] + this.foot(i)).setAlpha(alpha * (0.7 + 0.3 * (s?.activity ?? 0)));
      }
    }
  }

  const size = () => ({
    width: Math.max(1, Math.round((parent.clientWidth || 800) * dpr)),
    height: Math.max(1, Math.round((parent.clientHeight || 600) * dpr)),
  });

  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    parent,
    backgroundColor: OCEAN,
    banner: false,
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.NONE, zoom: 1 / dpr, ...size() },
    scene: MapScene,
  });

  let portrait = window.innerHeight >= window.innerWidth;

  const sync = () => {
    const next = scale();
    const scene = game.scene.getScene('map') as MapScene | null;
    const cam = scene?.cameras?.main;
    const ratio = next / dpr;
    const cx = cam ? cam.scrollX + cam.width / 2 : 0;
    const cy = cam ? cam.scrollY + cam.height / 2 : 0;
    if (ratio !== 1) {
      dpr = next;
      RES = clamp(dpr * 2, 2, 4);
      if (cam) scene!.rescale(ratio);
    }
    const { width, height } = size();
    if (width !== game.scale.width || height !== game.scale.height) game.scale.resize(width, height);
    if (ratio !== 1) {
      game.scale.setZoom(1 / dpr);
      if (cam) cam.centerOn(cx, cy);
    }
  };
  app.onResolution(sync);

  new ResizeObserver(() => {
    sync();
    const turned = window.innerHeight >= window.innerWidth !== portrait;
    if (!turned) return;
    portrait = !portrait;
    const scene = game.scene.getScene('map') as MapScene | null;
    if (NARROW.matches && scene?.cameras?.main) scene.refit();
  }).observe(parent);

  return game;
}
