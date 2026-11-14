import type { RegionKind } from './schema';
import type { Layout, Point } from './seam';

export interface Island {
  region: string;
  points: Point[];
  coast: string;
}

export interface Terrain {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  scale: number;
  islands: Island[];
}

export const OCEAN = '#0a1a2c';
const OCEAN_LIGHT = '#12304a';
const SHALLOWS = '#2a7a8c';
const MARGIN = 220;
const PAD = 6;
const WOBBLE = 14;
const CORNER = 26;
const STEP = 9;
const MAX_PIXELS = 6_000_000;

interface Biome {
  land: string;
  hill: string;
  low: string;
  sand: string;
}

const BIOMES: Biome[] = [
  { land: '#1e3a2a', hill: '#2c5239', low: '#162c20', sand: '#7a7650' },
  { land: '#2a3f24', hill: '#3b5731', low: '#1f301b', sand: '#827c50' },
  { land: '#3a3b22', hill: '#50502e', low: '#2b2c19', sand: '#8f8354' },
  { land: '#473c26', hill: '#5f5032', low: '#372e1d', sand: '#a08c5c' },
  { land: '#22393a', hill: '#2f4c4d', low: '#192b2c', sand: '#74867e' },
  { land: '#2f3a2a', hill: '#435040', low: '#232c20', sand: '#7c7c62' },
];
const HOME: Biome = { land: '#1c3030', hill: '#28423f', low: '#152524', sand: '#7d8a78' };
const ROCK: Biome = { land: '#2a2c31', hill: '#3a3c42', low: '#202227', sand: '#70727a' };
const DRILL: Biome = { land: '#4a3b2a', hill: '#5b4933', low: '#3a2e21', sand: '#b39a6b' };

const WOOD = '#8a6a44';
const BARK = '#4e3a24';
const STRAW = '#c9a85c';
const CHALK = '#e2d6bd';
const CLOTH = '#c9684f';
const STEEL = '#b9c0c9';

type Ctx = CanvasRenderingContext2D;

function stroke(ctx: Ctx, color: string, width: number, points: number[]) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

function solid(ctx: Ctx, color: string, points: number[]) {
  ctx.fillStyle = color;
  ctx.strokeStyle = BARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function disc(ctx: Ctx, color: string, x: number, y: number, r: number) {
  ctx.fillStyle = color;
  ctx.strokeStyle = BARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

const stake = (ctx: Ctx, x: number, y: number, h: number) => solid(ctx, WOOD, [x - 2.6, y, x - 2.6, y - h + 3, x, y - h, x + 2.6, y - h + 3, x + 2.6, y]);

function pennant(ctx: Ctx, x: number, y: number, h: number) {
  stroke(ctx, BARK, 2, [x, y, x, y - h]);
  solid(ctx, CLOTH, [x, y - h, x + 15, y - h + 5, x, y - h + 10]);
}

const PROPS: ((ctx: Ctx, x: number, y: number) => void)[] = [
  (ctx, x, y) => {
    stroke(ctx, WOOD, 3, [x - 15, y, x - 15, y - 30]);
    stroke(ctx, WOOD, 3, [x + 15, y, x + 15, y - 30]);
    solid(ctx, '#6b5237', [x - 20, y - 32, x + 20, y - 32, x + 20, y - 12, x - 20, y - 12]);
    for (const [dx, dy, w] of [[-14, -27, 12], [3, -27, 11], [-14, -20, 9], [3, -20, 13]]) stroke(ctx, CHALK, 1.6, [x + dx, y + dy, x + dx + w, y + dy]);
    for (const dx of [30, 38, 34]) solid(ctx, CHALK, [x + dx, y - (dx === 34 ? 9 : 4), x + dx + 9, y - (dx === 34 ? 9 : 4), x + dx + 9, y - (dx === 34 ? 5 : 0), x + dx, y - (dx === 34 ? 5 : 0)]);
  },
  (ctx, x, y) => {
    for (const dx of [-32, 0, 32]) {
      stroke(ctx, WOOD, 3, [x + dx, y, x + dx, y - 26]);
      stroke(ctx, WOOD, 3, [x + dx - 11, y - 19, x + dx + 11, y - 19]);
      solid(ctx, STRAW, [x + dx - 6, y - 23, x + dx + 6, y - 23, x + dx + 7, y - 9, x + dx - 7, y - 9]);
      disc(ctx, STRAW, x + dx, y - 29, 5);
    }
  },
  (ctx, x, y) => {
    for (const dx of [-34, 0, 34]) {
      stroke(ctx, WOOD, 2.4, [x + dx - 9, y, x + dx, y - 15, x + dx + 9, y]);
      disc(ctx, CHALK, x + dx, y - 19, 12);
      disc(ctx, CLOTH, x + dx, y - 19, 8);
      disc(ctx, CHALK, x + dx, y - 19, 4.2);
      disc(ctx, CLOTH, x + dx, y - 19, 1.6);
    }
  },
  (ctx, x, y) => {
    stroke(ctx, WOOD, 3, [x - 26, y, x - 26, y - 24]);
    stroke(ctx, WOOD, 3, [x + 26, y, x + 26, y - 24]);
    stroke(ctx, WOOD, 3, [x - 29, y - 19, x + 29, y - 19]);
    for (const dx of [-17, -6, 5, 16]) {
      stroke(ctx, STEEL, 2, [x + dx - 2, y - 2, x + dx + 3, y - 34]);
      stroke(ctx, BARK, 2, [x + dx - 4.5, y - 9, x + dx + 3.5, y - 10.5]);
    }
  },
  (ctx, x, y) => {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = CHALK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y - 20, 21, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    stroke(ctx, STEEL, 2.2, [x - 11, y - 9, x + 11, y - 31]);
    stroke(ctx, STEEL, 2.2, [x + 11, y - 9, x - 11, y - 31]);
    stroke(ctx, BARK, 2.2, [x - 10.5, y - 14.5, x - 5.5, y - 9.5]);
    stroke(ctx, BARK, 2.2, [x + 10.5, y - 14.5, x + 5.5, y - 9.5]);
  },
  (ctx, x, y) => {
    solid(ctx, WOOD, [x - 24, y, x - 24, y - 8, x + 24, y - 8, x + 24, y]);
    solid(ctx, WOOD, [x - 14, y - 8, x - 14, y - 16, x + 14, y - 16, x + 14, y - 8]);
    pennant(ctx, x, y - 16, 28);
  },
];

function drawGrounds(ctx: Ctx, grounds: NonNullable<Layout['grounds']>) {
  const { rect, yards } = grounds;
  const gate = yards[0] ? yards[0].x + yards[0].w / 2 : rect.x + rect.w / 2;
  for (let x = rect.x - 6; x <= rect.x + rect.w + 6; x += 8.5) {
    if (Math.abs(x - gate) > 24) stake(ctx, x, rect.y - 1, 13);
    stake(ctx, x, rect.y + rect.h + 13, 13);
  }
  for (let y = rect.y + 8; y <= rect.y + rect.h + 6; y += 8.5) {
    stake(ctx, rect.x - 8, y, 12);
    stake(ctx, rect.x + rect.w + 8, y, 12);
  }
  stake(ctx, gate - 26, rect.y + 1, 22);
  stake(ctx, gate + 26, rect.y + 1, 22);
  yards.forEach((yard, i) => {
    ctx.fillStyle = '#6f583b';
    ctx.globalAlpha = 0.42 + 0.05 * i;
    ctx.beginPath();
    ctx.roundRect(yard.x, yard.y, yard.w, yard.h, 18);
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([9, 6]);
    ctx.strokeStyle = CHALK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.save();
    ctx.translate(yard.x + yard.w / 2, yard.y + 76);
    ctx.scale(1.5, 1.5);
    PROPS[i % PROPS.length](ctx, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  });
  ctx.globalAlpha = 0.9;
  for (const x of [rect.x + 8, rect.x + rect.w - 22]) pennant(ctx, x, rect.y + rect.h - 4, 30);
  ctx.globalAlpha = 1;
}

function drawSquare(ctx: Ctx, square: NonNullable<Layout['square']>) {
  const tile = 22;
  ctx.save();
  trace(ctx, outline(square.x, square.y, square.w, square.h, hash('square')));
  ctx.clip();
  ctx.fillStyle = CHALK;
  for (let row = 0; row * tile < square.h + tile; row++) {
    for (let col = 0; col * tile < square.w + tile; col++) {
      ctx.globalAlpha = (row + col) % 2 ? 0.035 : 0.085;
      ctx.fillRect(square.x - tile / 2 + col * tile, square.y - tile / 2 + row * tile, tile, tile);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function outline(x: number, y: number, w: number, h: number, seed: number): Point[] {
  const rnd = rng(seed);
  const r = Math.min(Math.max(CORNER, Math.min(w, h) * 0.3), 44, w / 2, h / 2);
  const x0 = x - PAD;
  const y0 = y - PAD;
  const x1 = x + w + PAD;
  const y1 = y + h + PAD;
  const sides = [x1 - x0 - 2 * r, y1 - y0 - 2 * r];
  const arc = (Math.PI / 2) * r;
  const total = 2 * (sides[0] + sides[1]) + 4 * arc;
  const waves = [2, 3, 5, 7, 11].map((k, i) => ({ k, phase: rnd() * Math.PI * 2, weight: 1 / (1 + i * 0.7) }));
  const norm = waves.reduce((sum, wave) => sum + wave.weight, 0);
  const count = Math.max(24, Math.round(total / STEP));
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    let s = (i / count) * total;
    let px = 0;
    let py = 0;
    let nx = 0;
    let ny = 0;
    const corner = (cx: number, cy: number, from: number, along: number) => {
      const a = from + (along / arc) * (Math.PI / 2);
      nx = Math.cos(a);
      ny = Math.sin(a);
      px = cx + nx * r;
      py = cy + ny * r;
    };
    if (s < sides[0]) [px, py, nx, ny] = [x0 + r + s, y0, 0, -1];
    else if ((s -= sides[0]) < arc) corner(x1 - r, y0 + r, -Math.PI / 2, s);
    else if ((s -= arc) < sides[1]) [px, py, nx, ny] = [x1, y0 + r + s, 1, 0];
    else if ((s -= sides[1]) < arc) corner(x1 - r, y1 - r, 0, s);
    else if ((s -= arc) < sides[0]) [px, py, nx, ny] = [x1 - r - s, y1, 0, 1];
    else if ((s -= sides[0]) < arc) corner(x0 + r, y1 - r, Math.PI / 2, s);
    else if ((s -= arc) < sides[1]) [px, py, nx, ny] = [x0, y1 - r - s, -1, 0];
    else corner(x0 + r, y0 + r, Math.PI, s - sides[1]);
    const turn = (i / count) * Math.PI * 2;
    let lift = 0;
    for (const wave of waves) lift += Math.sin(turn * wave.k + wave.phase) * wave.weight;
    const out = WOBBLE * (0.5 + (0.5 * lift) / norm);
    points.push({ x: px + nx * out, y: py + ny * out });
  }
  return points;
}

function trace(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  const n = points.length;
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(points[n - 1], points[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const next = mid(points[i], points[(i + 1) % n]);
    ctx.quadraticCurveTo(points[i].x, points[i].y, next.x, next.y);
  }
  ctx.closePath();
}

const biomeOf = (kind: RegionKind, seed: number) =>
  kind === 'internal' ? HOME : kind === 'unmapped' ? ROCK : kind === 'recruiting' ? DRILL : BIOMES[seed % BIOMES.length];

export function buildTerrain(layout: Layout): Terrain {
  const b = layout.bounds;
  const width = b.w + MARGIN * 2;
  const height = b.h + MARGIN * 2;
  const scale = Math.min(1.5, Math.sqrt(MAX_PIXELS / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(MARGIN - b.x, MARGIN - b.y);
  ctx.lineJoin = 'round';

  const sea = rng(hash('ocean'));
  for (let i = 0; i < 26; i++) {
    const cx = b.x + sea() * b.w;
    const cy = b.y + sea() * b.h;
    const radius = 140 + sea() * 260;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, `${OCEAN_LIGHT}66`);
    glow.addColorStop(1, `${OCEAN_LIGHT}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  const islands: Island[] = layout.regions.map((region) => {
    const seed = hash(region.id);
    const { x, y, w, h } = region.rect;
    return { region: region.id, points: outline(x, y, w, h, seed), coast: biomeOf(region.kind, seed).sand };
  });

  layout.regions.forEach((region, i) => {
    trace(ctx, islands[i].points);
    for (const [line, alpha] of [
      [46, 0.07],
      [28, 0.1],
      [14, 0.16],
    ]) {
      ctx.lineWidth = line;
      ctx.strokeStyle = SHALLOWS;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });

  layout.regions.forEach((region, i) => {
    const seed = hash(region.id);
    const biome = biomeOf(region.kind, seed);
    const rnd = rng(seed ^ 0x9e3779b9);
    const { x, y, w, h } = region.rect;
    ctx.save();
    trace(ctx, islands[i].points);
    ctx.fillStyle = biome.land;
    ctx.fill();
    ctx.clip();
    const blots = Math.max(6, Math.round((w * h) / 2600));
    for (let k = 0; k < blots; k++) {
      const cx = x + rnd() * w;
      const cy = y + rnd() * h;
      const radius = 26 + rnd() * 70;
      const shade = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      const color = rnd() < 0.55 ? biome.hill : biome.low;
      shade.addColorStop(0, `${color}b0`);
      shade.addColorStop(1, `${color}00`);
      ctx.fillStyle = shade;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
    trace(ctx, islands[i].points);
    ctx.lineWidth = 9;
    ctx.strokeStyle = biome.sand;
    ctx.globalAlpha = 0.34;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (region.kind === 'recruiting' && layout.grounds) drawGrounds(ctx, layout.grounds);
    if (region.kind === 'internal' && layout.square) drawSquare(ctx, layout.square);
    ctx.restore();
  });

  return { canvas, x: b.x - MARGIN, y: b.y - MARGIN, scale, islands };
}
