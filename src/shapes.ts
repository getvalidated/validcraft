import type Phaser from 'phaser';
import type { ResourceType } from './schema';
import type { Point, UnitRole } from './seam';
import { GOLD, SPRITES, SPRITE_UNIT, type SpritePart } from './sprites';

type G = Phaser.GameObjects.Graphics;
type Pen = { beginPath(): unknown; moveTo(x: number, y: number): unknown; lineTo(x: number, y: number): unknown; closePath(): unknown; arc(x: number, y: number, r: number, from: number, to: number): unknown };

const SEGMENTS = 10;
const GILT = parseInt(GOLD.slice(1), 16);
const LX = new Float64Array(SEGMENTS + 1);
const LY = new Float64Array(SEGMENTS + 1);
const RX = new Float64Array(SEGMENTS + 1);
const RY = new Float64Array(SEGMENTS + 1);

export function polygon(g: Pen, x: number, y: number, r: number, sides: number, turn: number) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = turn + (i * 2 * Math.PI) / sides;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.closePath();
}

export function starPath(g: Pen, x: number, y: number, r: number) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const reach = i % 2 ? r * 0.45 : r;
    const px = x + Math.cos(a) * reach;
    const py = y + Math.sin(a) * reach;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.closePath();
}

export function ribbon(g: G, a: Point, c: Point, b: Point, w0: number, w1: number) {
  for (let i = 0; i <= SEGMENTS; i++) {
    const s = i / SEGMENTS;
    const u = 1 - s;
    const x = u * u * a.x + 2 * u * s * c.x + s * s * b.x;
    const y = u * u * a.y + 2 * u * s * c.y + s * s * b.y;
    const tx = u * (c.x - a.x) + s * (b.x - c.x);
    const ty = u * (c.y - a.y) + s * (b.y - c.y);
    const len = Math.hypot(tx, ty) || 1;
    const half = (w0 + (w1 - w0) * s) / 2;
    const nx = (-ty / len) * half;
    const ny = (tx / len) * half;
    LX[i] = x + nx;
    LY[i] = y + ny;
    RX[i] = x - nx;
    RY[i] = y - ny;
  }
  g.beginPath();
  g.moveTo(LX[0], LY[0]);
  for (let i = 1; i <= SEGMENTS; i++) g.lineTo(LX[i], LY[i]);
  for (let i = SEGMENTS; i >= 0; i--) g.lineTo(RX[i], RY[i]);
  g.closePath();
}

export function unitSprite(g: G, role: UnitRole | SpritePart[], x: number, y: number, r: number, fill: number, edge: number, alpha: number, width = 1.4) {
  const k = r / SPRITE_UNIT;
  for (const part of typeof role === 'string' ? SPRITES[role] : role) {
    const solid = part.paint === 'body' || part.paint === 'trim' || part.paint === 'gold';
    const gold = part.paint === 'gold' || part.paint === 'gilt';
    g.fillStyle(gold ? GILT : part.paint === 'trim' ? edge : fill, alpha);
    g.lineStyle(width, gold ? GILT : part.paint === 'cut' ? fill : edge, alpha);
    if (part.circle) {
      g.fillCircle(x + part.circle[0] * k, y + part.circle[1] * k, part.circle[2] * k);
      g.strokeCircle(x + part.circle[0] * k, y + part.circle[1] * k, part.circle[2] * k);
      continue;
    }
    const points = part.points!;
    g.beginPath();
    g.moveTo(x + points[0] * k, y + points[1] * k);
    for (let i = 2; i < points.length; i += 2) g.lineTo(x + points[i] * k, y + points[i + 1] * k);
    if (solid) {
      g.closePath();
      g.fillPath();
    }
    g.strokePath();
  }
}

const OUTLINES: Partial<Record<ResourceType, number[]>> = {
  campaign: [-6, -7, 7, -3, -3.5, 1, -3.5, 7, -6, 7],
  adset: [-3.5, -5, 3.5, -5, 7, 5, -7, 5],
  ad: [-6.5, -6, 0.5, -6, 7, 0, 0.5, 6, -6.5, 6, -0.5, 0],
  resume: [-5, -7, 1.5, -7, 5.5, -3, 5.5, 7, -5, 7],
  setting: [-6, -6, -2, -6, -2, -1, 2, -1, 2, -6, 6, -6, 6, 6, -6, 6],
  report: [-6.5, 6.5, -6.5, 0.5, -2.5, 0.5, -2.5, -3, 1.5, -3, 1.5, -6.5, 6.5, -6.5, 6.5, 6.5],
  bill: [-5, -7, 5, -7, 5, 7, 2.5, 4.5, 0, 7, -2.5, 4.5, -5, 7],
  email: [-7, -5, 0, 0.5, 7, -5, 7, 5, -7, 5],
  call: [-7, -4, 2, -4, 2, -1, 7, -4.5, 7, 4.5, 2, 1, 2, 4, -7, 4],
  doc: [-7, -6, -1, -6, 1, -4, 7, -4, 7, 6, -7, 6],
  chat: [6.5, 2.7, 2.7, 6.5, -2.7, 6.5, -6.5, 2.7, -6.5, -2.7, -2.7, -6.5, 2.7, -6.5, 6.5, -2.7],
  image: [-7, 6, -2.5, -3, 0.5, 2, 3, -1.5, 7, 6],
  board: [-7, -6, 7, -6, 7, -1, 1, -1, 1, 6, -7, 6],
  review: [0, -7, 2, -2, 7, 0, 2, 2, 0, 7, -2, 2, -7, 0, -2, -2],
  comment: [-7, -6, 7, -6, 7, 3, -1, 3, -5, 7, -5, 3, -7, 3],
  rival: [-6, -6, 6, -6, 6, 1, 0, 7, -6, 1],
  post: [0, -3, 3, -6.5, 6.5, -4, 6.5, 0, 0, 7, -6.5, 0, -6.5, -4, -3, -6.5],
  trend: [0, -7, 6.5, 0, 2.5, 0, 2.5, 7, -2.5, 7, -2.5, 0, -6.5, 0],
  outreach: [-7, -1.5, 7, -7, 2.5, 7, -0.5, 1.5],
  booking: [-6, -5, -4, -5, -4, -7, -2, -7, -2, -5, 2, -5, 2, -7, 4, -7, 4, -5, 6, -5, 6, 6, -6, 6],
  incident: [1.5, -7, -5, 1, -0.5, 1, -2, 7, 5, -2, 0.5, -2, 3.5, -7],
  deploy: [0, -7, 3.5, -2, 3.5, 3, 6, 7, 0, 4.5, -6, 7, -3.5, 3, -3.5, -2],
  build: [-6, -6, 6, -6, 1, 0, 6, 6, -6, 6, -1, 0],
  assignment: [-7, -2.5, 1, -2.5, 1, -6.5, 7, 0, 1, 6.5, 1, 2.5, -7, 2.5],
  invite: [-7, -4, -2, -4, 0, -2, 2, -4, 7, -4, 7, 4, 2, 4, 0, 2, -2, 4, -7, 4],
  ambassador: [-7, -2, -2, -2, 6, -6.5, 6, 6.5, -2, 2, -7, 2],
  lead: [-7, -6, 7, -6, 1.5, 1, 1.5, 7, -1.5, 5, -1.5, 1],
  referral: [-6, -2, -2, -2, -4.5, -6.5, 0, -3.5, 4.5, -6.5, 2, -2, 6, -2, 6, 6.5, -6, 6.5],
};

export function resourcePath(g: Pen, type: ResourceType, x: number, y: number, r: number) {
  if (type === 'client_winner') return starPath(g, x, y, r * 1.6);
  const outline = OUTLINES[type];
  if (outline) {
    const k = (r * 1.35) / 7;
    g.beginPath();
    g.moveTo(x + outline[0] * k, y + outline[1] * k);
    for (let i = 2; i < outline.length; i += 2) g.lineTo(x + outline[i] * k, y + outline[i + 1] * k);
    g.closePath();
    return;
  }
  if (type === 'ticket') return polygon(g, x, y, r * 1.3, 4, Math.PI / 4);
  if (type === 'thread') return polygon(g, x, y, r * 1.35, 3, -Math.PI / 2);
  if (type === 'pr') return polygon(g, x, y, r * 1.3, 5, -Math.PI / 2);
  if (type === 'analysis') return polygon(g, x, y, r * 1.25, 6, 0);
  if (type === 'embedding') return polygon(g, x, y, r * 1.35, 4, -Math.PI / 2);
  if (type === 'video') return polygon(g, x, y, r * 1.35, 3, 0);
  if (type === 'row' || type === 'taxonomy') {
    const w = r * 1.5;
    const h = r * 0.7;
    g.beginPath();
    g.moveTo(x - w, y - h);
    g.lineTo(x + (type === 'row' ? w : w * 0.45), y - h);
    if (type === 'taxonomy') g.lineTo(x + w, y);
    g.lineTo(x + (type === 'row' ? w : w * 0.45), y + h);
    g.lineTo(x - w, y + h);
    g.closePath();
    return;
  }
  g.beginPath();
  g.arc(x, y, r * 1.05, 0, Math.PI * 2);
  g.closePath();
}

export function table(g: G, x: number, y: number, r: number, top: number, edge: number, width: number, alpha: number) {
  g.fillStyle(0x05070b, 0.5 * alpha);
  g.fillEllipse(x, y + r * 0.22 + 2, r * 2.15, r * 2.05);
  g.fillStyle(top, alpha);
  g.lineStyle(width, edge, alpha);
  g.fillCircle(x, y, r);
  g.strokeCircle(x, y, r);
  g.lineStyle(width * 0.6, edge, alpha * 0.45);
  g.strokeCircle(x, y, r * 0.62);
}

function closed(g: G, points: number[]) {
  g.beginPath();
  g.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) g.lineTo(points[i], points[i + 1]);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

function box(g: G, x: number, y: number, w: number, h: number) {
  g.fillRect(x, y, w, h);
  g.strokeRect(x, y, w, h);
}

export function home(g: G, x: number, y: number, r: number, wall: number, roof: number, edge: number, alpha: number, glow: number | null) {
  if (glow !== null) {
    g.fillStyle(glow, 0.16 * alpha);
    g.fillCircle(x, y + r * 0.2, r * 1.7);
  }
  g.lineStyle(Math.max(0.7, r * 0.12), edge, alpha);
  g.fillStyle(wall, alpha);
  box(g, x - r * 0.85, y - r * 0.12, r * 1.7, r * 1.1);
  g.fillStyle(roof, alpha);
  closed(g, [x - r * 1.1, y - r * 0.12, x, y - r * 1.1, x + r * 1.1, y - r * 0.12]);
}

export function stall(g: G, x: number, y: number, r: number, wall: number, roof: number, edge: number, alpha: number, glow: number | null) {
  if (glow !== null) {
    g.fillStyle(glow, 0.16 * alpha);
    g.fillCircle(x, y + r * 0.2, r * 1.7);
  }
  g.lineStyle(Math.max(0.7, r * 0.12), edge, alpha);
  g.lineBetween(x - r * 0.8, y - r * 0.4, x - r * 0.8, y + r * 0.3);
  g.lineBetween(x + r * 0.8, y - r * 0.4, x + r * 0.8, y + r * 0.3);
  g.fillStyle(wall, alpha);
  box(g, x - r * 0.95, y + r * 0.25, r * 1.9, r * 0.75);
  g.fillStyle(roof, alpha);
  closed(g, [x - r * 1.15, y - r * 0.35, x - r * 0.8, y - r, x + r * 0.8, y - r, x + r * 1.15, y - r * 0.35]);
  g.lineBetween(x - r * 0.27, y - r, x - r * 0.38, y - r * 0.35);
  g.lineBetween(x + r * 0.27, y - r, x + r * 0.38, y - r * 0.35);
}

export function palace(g: G, x: number, y: number, r: number, wall: number, roof: number, edge: number, alpha: number, glow: number | null) {
  const at = (points: number[]) => points.map((v, i) => (i % 2 ? y : x) + v * r);
  if (glow !== null) {
    g.fillStyle(glow, 0.16 * alpha);
    g.fillCircle(x, y - r * 0.1, r * 1.6);
  }
  g.lineStyle(Math.max(0.8, r * 0.05), edge, alpha);
  for (const side of [-1, 1]) {
    g.fillStyle(wall, alpha);
    box(g, x + (side < 0 ? -1 : 0.72) * r, y - r * 0.35, r * 0.28, r * 0.9);
    g.fillStyle(roof, alpha);
    closed(g, at([side * 1.07, -0.35, side * 0.86, -0.82, side * 0.65, -0.35]));
  }
  g.fillStyle(wall, alpha);
  box(g, x - r * 0.72, y, r * 1.44, r * 0.55);
  box(g, x - r * 0.36, y - r * 0.45, r * 0.72, r);
  g.fillStyle(roof, alpha);
  closed(g, at([-0.46, -0.45, 0, -1, 0.46, -0.45]));
  g.lineBetween(x, y - r, x, y - r * 1.3);
  closed(g, at([0, -1.3, 0.24, -1.21, 0, -1.12]));
  g.fillStyle(edge, alpha);
  g.fillRect(x - r * 0.1, y + r * 0.27, r * 0.2, r * 0.28);
  for (const side of [-1, 1]) g.fillRect(x + side * 0.54 * r - r * 0.05, y + r * 0.18, r * 0.1, r * 0.16);
}

export function barn(g: G, x: number, y: number, scale: number, wall: number, roof: number, edge: number) {
  g.save();
  g.translateCanvas(x, y);
  g.scaleCanvas(scale, scale);
  g.fillStyle(0x05070b, 0.55);
  g.fillEllipse(0, 16, 44, 7);
  g.lineStyle(1.3, edge, 1);
  g.fillStyle(wall, 1);
  box(g, -15, -2, 30, 17);
  g.fillStyle(roof, 1);
  closed(g, [-18, -2, -13, -11, 0, -18, 13, -11, 18, -2]);
  g.fillStyle(edge, 1);
  g.fillRect(-5, 4, 10, 11);
  g.lineStyle(1.1, wall, 1);
  g.lineBetween(-5, 4, 5, 15);
  g.lineBetween(5, 4, -5, 15);
  g.restore();
}

export function building(
  g: G,
  resource: ResourceType | null,
  x: number,
  y: number,
  scale: number,
  wall: number,
  roof: number,
  edge: number,
  alpha: number,
) {
  g.save();
  g.translateCanvas(x, y);
  g.scaleCanvas(scale, scale);
  g.fillStyle(0x05070b, 0.55 * alpha);
  g.fillEllipse(0, 16, 40, 7);
  g.lineStyle(1.3, edge, alpha);
  if (resource === 'ticket') {
    g.fillStyle(wall, alpha);
    box(g, -14, -3, 28, 18);
    g.fillStyle(roof, alpha);
    closed(g, [-18, -3, 0, -17, 18, -3]);
    g.fillStyle(edge, alpha);
    g.fillRect(-3.5, 5, 7, 10);
    g.fillRect(-11, 1, 4, 4);
    g.fillRect(7, 1, 4, 4);
  } else if (resource === 'page') {
    g.fillStyle(wall, alpha);
    box(g, -17, 11, 34, 4);
    for (const cx of [-13, -6, 1, 8]) box(g, cx, -5, 4, 16);
    g.fillStyle(roof, alpha);
    box(g, -16, -8, 32, 3);
    closed(g, [-17, -8, 0, -17, 17, -8]);
  } else if (resource === 'thread') {
    g.fillStyle(wall, alpha);
    closed(g, [-8, 15, 8, 15, 4, -5, -4, -5]);
    g.fillStyle(roof, alpha);
    box(g, -8, -8, 16, 3);
    g.lineBetween(0, -8, 0, -16);
    g.fillStyle(edge, alpha);
    g.fillCircle(0, -16, 2);
    g.beginPath();
    g.arc(0, -16, 6, -Math.PI * 0.3, Math.PI * 0.3);
    g.strokePath();
    g.beginPath();
    g.arc(0, -16, 6, Math.PI * 0.7, Math.PI * 1.3);
    g.strokePath();
  } else if (resource === 'resume') {
    g.fillStyle(wall, alpha);
    closed(g, [-17, 15, -9, -6, 9, -6, 17, 15]);
    g.fillStyle(roof, alpha);
    closed(g, [-12, -6, 0, -13, 12, -6]);
    g.lineBetween(0, -13, 0, -21);
    closed(g, [0, -21, 9, -18.5, 0, -16]);
    g.fillStyle(edge, alpha);
    closed(g, [-4, 15, 0, 2, 4, 15]);
  } else {
    g.fillStyle(wall, alpha);
    box(g, 8, -17, 5, 16);
    box(g, -16, -1, 32, 16);
    g.fillStyle(roof, alpha);
    closed(g, [-16, -1, -16, -10, -6, -1, -6, -10, 4, -1, 4, -10, 14, -1]);
    g.fillStyle(edge, alpha);
    g.fillRect(-11, 5, 5, 5);
    g.fillRect(-2, 5, 5, 5);
  }
  g.restore();
}
