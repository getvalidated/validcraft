import { COLORS, RESOURCE_COLORS, RESOURCE_LABELS, RESOURCE_SHAPES } from './palette';
import type { ResourceType } from './schema';
import type { UnitRole } from './seam';
import { GOLD, SPRITES, type SpritePart } from './sprites';

export type Shape = 'square' | 'circle' | 'triangle' | 'pentagon' | 'hexagon' | 'diamond' | 'tag' | 'bar' | 'play' | 'flag' | 'trapezoid' | 'chevron' | 'sheet' | 'notch' | 'chart' | 'receipt' | 'envelope' | 'camera' | 'folder' | 'octagon' | 'peaks' | 'ell' | 'spark' | 'bubble' | 'shield' | 'heart' | 'arrow' | 'plane' | 'calendar' | 'bolt' | 'rocket' | 'bowtie' | 'pointer' | 'stub' | 'horn' | 'funnel' | 'gift' | 'star' | 'plus' | 'ring' | 'dashed' | 'wedge' | 'tick' | 'house';

const STAR = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  const r = i % 2 ? 3.1 : 7;
  return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
}).join(' L');

const BODY: Record<Shape, string> = {
  square: '<rect x="-5.5" y="-5.5" width="11" height="11"/>',
  circle: '<circle r="6"/>',
  triangle: '<path d="M0 -6.5 L6.5 5 L-6.5 5 Z"/>',
  pentagon: '<path d="M0 -7 L6.7 -2.2 L4.1 5.7 L-4.1 5.7 L-6.7 -2.2 Z"/>',
  hexagon: '<path d="M7 0 L3.5 6 L-3.5 6 L-7 0 L-3.5 -6 L3.5 -6 Z"/>',
  diamond: '<path d="M0 -7 L7 0 L0 7 L-7 0 Z"/>',
  tag: '<path d="M-6.5 -4.5 H2.5 L7 0 L2.5 4.5 H-6.5 Z"/>',
  bar: '<rect x="-7" y="-3" width="14" height="6"/>',
  play: '<path d="M-5 -6.5 L7 0 L-5 6.5 Z"/>',
  flag: '<path d="M-6 -7 L7 -3 L-3.5 1 V7 H-6 Z"/>',
  trapezoid: '<path d="M-3.5 -5 H3.5 L7 5 H-7 Z"/>',
  chevron: '<path d="M-6.5 -6 H0.5 L7 0 L0.5 6 H-6.5 L-0.5 0 Z"/>',
  sheet: '<path d="M-5 -7 H1.5 L5.5 -3 V7 H-5 Z"/>',
  notch: '<path d="M-6 -6 H-2 V-1 H2 V-6 H6 V6 H-6 Z"/>',
  chart: '<path d="M-6.5 6.5 V0.5 H-2.5 V-3 H1.5 V-6.5 H6.5 V6.5 Z"/>',
  receipt: '<path d="M-5 -7 H5 V7 L2.5 4.5 L0 7 L-2.5 4.5 L-5 7 Z"/>',
  envelope: '<path d="M-7 -5 L0 0.5 L7 -5 L7 5 L-7 5 Z"/>',
  camera: '<path d="M-7 -4 L2 -4 L2 -1 L7 -4.5 L7 4.5 L2 1 L2 4 L-7 4 Z"/>',
  folder: '<path d="M-7 -6 L-1 -6 L1 -4 L7 -4 L7 6 L-7 6 Z"/>',
  octagon: '<path d="M6.5 2.7 L2.7 6.5 L-2.7 6.5 L-6.5 2.7 L-6.5 -2.7 L-2.7 -6.5 L2.7 -6.5 L6.5 -2.7 Z"/>',
  peaks: '<path d="M-7 6 L-2.5 -3 L0.5 2 L3 -1.5 L7 6 Z"/>',
  ell: '<path d="M-7 -6 L7 -6 L7 -1 L1 -1 L1 6 L-7 6 Z"/>',
  spark: '<path d="M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2 Z"/>',
  bubble: '<path d="M-7 -6 L7 -6 L7 3 L-1 3 L-5 7 L-5 3 L-7 3 Z"/>',
  shield: '<path d="M-6 -6 L6 -6 L6 1 L0 7 L-6 1 Z"/>',
  heart: '<path d="M0 -3 L3 -6.5 L6.5 -4 L6.5 0 L0 7 L-6.5 0 L-6.5 -4 L-3 -6.5 Z"/>',
  arrow: '<path d="M0 -7 L6.5 0 L2.5 0 L2.5 7 L-2.5 7 L-2.5 0 L-6.5 0 Z"/>',
  plane: '<path d="M-7 -1.5 L7 -7 L2.5 7 L-0.5 1.5 Z"/>',
  calendar: '<path d="M-6 -5 L-4 -5 L-4 -7 L-2 -7 L-2 -5 L2 -5 L2 -7 L4 -7 L4 -5 L6 -5 L6 6 L-6 6 Z"/>',
  bolt: '<path d="M1.5 -7 L-5 1 L-0.5 1 L-2 7 L5 -2 L0.5 -2 L3.5 -7 Z"/>',
  rocket: '<path d="M0 -7 L3.5 -2 L3.5 3 L6 7 L0 4.5 L-6 7 L-3.5 3 L-3.5 -2 Z"/>',
  bowtie: '<path d="M-6 -6 L6 -6 L1 0 L6 6 L-6 6 L-1 0 Z"/>',
  pointer: '<path d="M-7 -2.5 L1 -2.5 L1 -6.5 L7 0 L1 6.5 L1 2.5 L-7 2.5 Z"/>',
  stub: '<path d="M-7 -4 L-2 -4 L0 -2 L2 -4 L7 -4 L7 4 L2 4 L0 2 L-2 4 L-7 4 Z"/>',
  horn: '<path d="M-7 -2 L-2 -2 L6 -6.5 L6 6.5 L-2 2 L-7 2 Z"/>',
  funnel: '<path d="M-7 -6 L7 -6 L1.5 1 L1.5 7 L-1.5 5 L-1.5 1 Z"/>',
  gift: '<path d="M-6 -2 L-2 -2 L-4.5 -6.5 L0 -3.5 L4.5 -6.5 L2 -2 L6 -2 L6 6.5 L-6 6.5 Z"/>',
  star: `<path d="M${STAR} Z"/>`,
  plus: '<path d="M-6 -2 H-2 V-6 H2 V-2 H6 V2 H2 V6 H-2 V2 H-6 Z"/>',
  ring: '<circle r="5"/>',
  dashed: '<circle r="5" stroke-dasharray="3.2 2"/>',
  wedge: '<path d="M-7.5 -4.5 L7.5 -0.8 L7.5 0.8 L-7.5 4.5 Z"/>',
  tick: '<path d="M-5 5 L5 -5"/>',
  house: '<path d="M-6 7 V-1 L0 -7 L6 -1 V7 Z"/>',
};

const HOLLOW = new Set<Shape>(['ring', 'dashed', 'tick']);

export function glyph(shape: Shape, color: string, outline: string | null = null, width = 2) {
  const hollow = HOLLOW.has(shape);
  const fill = hollow ? 'none' : color;
  const stroke = hollow ? color : outline ?? 'none';
  return `<svg class="ico" viewBox="-8 -8 16 16" width="12" height="12" aria-hidden="true" fill="${fill}" stroke="${stroke}" stroke-width="${width}">${BODY[shape]}</svg>`;
}

export const resourceGlyph = (type: ResourceType, outline: string | null = null) =>
  glyph(RESOURCE_SHAPES[type], RESOURCE_COLORS[type], outline).replace('<svg ', `<svg data-tip="${RESOURCE_LABELS[type]}" `);

export function spriteGlyph(role: UnitRole | SpritePart[], fill: string, edge: string) {
  const parts = (typeof role === 'string' ? SPRITES[role] : role)
    .map((part) => {
      const solid = part.paint === 'body' || part.paint === 'trim' || part.paint === 'gold';
      const gold = part.paint === 'gold' || part.paint === 'gilt';
      const paint = `fill="${solid ? (gold ? GOLD : part.paint === 'trim' ? edge : fill) : 'none'}" stroke="${gold ? GOLD : part.paint === 'cut' ? fill : edge}"`;
      if (part.circle) return `<circle cx="${part.circle[0]}" cy="${part.circle[1]}" r="${part.circle[2]}" ${paint}/>`;
      const points = part.points!;
      let d = `M${points[0]} ${points[1]}`;
      for (let i = 2; i < points.length; i += 2) d += ` L${points[i]} ${points[i + 1]}`;
      return `<path d="${d}${solid ? ' Z' : ''}" ${paint}/>`;
    })
    .join('');
  return `<svg class="ico" viewBox="-15 -16 30 29" width="20" height="20" aria-hidden="true" stroke-width="1.4" stroke-linejoin="round">${parts}</svg>`;
}
