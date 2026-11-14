import { LEAD_STAGES, RECRUIT_REGION, RECRUIT_STAGES, WILD_REGION, type Building, type Feature, type Region, type Replay, type Unit } from './schema';
import type { Layout, LayoutBuilding, LayoutFeature, LayoutGroup, LayoutRegion, LayoutUnit, Point, Rect } from './seam';
import { sites } from './links';
import { gearSprite, unitRoles, type GearFile } from './sprites';

const UNIT_R = 11;
const PALACE = sites.lead ? `u:${sites.lead.toLowerCase()}` : null;
const PALACE_BAND = 130;
const BUILDING_SIZE = 34;
const SEAT_X = 124;
const SEAT_Y = 96;
const REGION_HEAD = 44;
const FOOTER = 56;
const FARM = 104;
const STORE = 84;
const APRON = 38;
const ROOT_HEAD = 66;
const GROUP_HEAD = 24;
export const SLOT_STEP = 12;
const STRATA_BAND = 190;
const STRATA_GAP = 40;
const JAIL_H = 330;
const HEAVEN_H = 380;
const GROUNDS_H = 470 + FOOTER;
const GROUNDS_GAP = 96;
const GROUNDS_PAD = 26;
const YARD_GAP = 14;
const YARD_HEAD = 100;
const DRILL_STEP = 40;
const DRILL_MIN = 15;
const SLOT_COLS = 4;
const SLOT_ROWS = 2;
export const MAX_AGENTS = SLOT_COLS * SLOT_ROWS;

const TOP = 40;
const BOTTOM = 30 + FOOTER;
const GROUP_BOTTOM = 40;
const SIDE = 60;
const MIN_W = 168;
const PLOT = 15;
const GAP = 46;
const PART_GAP = 12;
const ROOT_PAD = 22;
const BUILD_STEP = 86;
const BUILD_MIN = 70;
const BUILD_ROW = 72;
const BUILD_TOP = 26;
const MAX_STRETCH = 1.7;
const SIDE_STEP = 17;
const SIDE_MAX = 1400;
const OUTSIDE_GAP = 80;
const CELL_W = 88;
const CELL_H = 15;
const CELL_GAP = 3;
const CELL_W_MAX = 128;
const CELL_CHAR = 4;
const CELL_TEXT = 30;
const CELL_SHAPE = 2.5;
const RANK_MIN = 13;
const STRUCT_PAD = 6;
const STRUCT_HEAD = 54;
const STRUCT_MIN = 78;
const STRUCT_GAP = 16;
const FLANK_GAP = 30;
const WORKER_PREFIX = 'temporal:';
const NORTH = new Set(['linear', 'slack', 'notion', 'github']);
const SWAPS = [
  ['frameio', 'notion'],
];
const SQUARE = 'meet';
const PLAZA = 190;
const STORE_BY:Record<string, 'concept' | 'creative' | 'brief'> = { linear: 'concept', frameio: 'creative', notion: 'brief' };
const STORE_W = 84;

interface Structure {
  building: Building;
  features: Feature[];
  cols: number;
  cell: number;
  box: number;
  w: number;
  h: number;
}

function structureOf(building: Building, features: Feature[]): Structure {
  const n = features.length;
  const cols = n <= 1 ? 1 : n <= 6 ? 2 : Math.max(3, Math.round(Math.sqrt(n / CELL_SHAPE)));
  const rows = Math.ceil(n / cols);
  const names = features.map((f) => f.name.length).sort((a, b) => a - b);
  const cell = n ? Math.min(CELL_W_MAX, Math.max(CELL_W, names[Math.floor((n - 1) * 0.75)] * CELL_CHAR + CELL_TEXT)) : CELL_W;
  const box = Math.max(STRUCT_MIN, STRUCT_PAD * 2 + cols * cell + (cols - 1) * CELL_GAP);
  return {
    building,
    features,
    cols,
    cell,
    box,
    w: box + (STORE_BY[building.id] ? STORE_W : 0),
    h: Math.max(STORE_BY[building.id] ? 66 : 0, STRUCT_HEAD + (rows ? rows * (CELL_H + CELL_GAP) + STRUCT_PAD - CELL_GAP : 0)) + (building.id === SQUARE ? PLAZA : 0),
  };
}

function wrapStructures(list: Structure[], width: number) {
  const rows: { items: Structure[]; w: number; h: number }[] = [];
  for (const item of list) {
    const last = rows[rows.length - 1];
    if (last && last.w + STRUCT_GAP + item.w <= width) {
      last.items.push(item);
      last.w += STRUCT_GAP + item.w;
      last.h = Math.max(last.h, item.h);
    } else {
      rows.push({ items: [item], w: item.w, h: item.h });
    }
  }
  return { rows, h: rows.reduce((sum, row) => sum + row.h + STRUCT_GAP + APRON, 0) };
}

export function unitLabel(name: string) {
  const local = name.split('@')[0].trim();
  const words = local.split(/\s+/).filter(Boolean);
  if (words.length < 2) return local.slice(0, 10);
  return `${words[0].slice(0, 8)} ${words[words.length - 1][0].toUpperCase()}.`;
}

export function unitInitials(name: string) {
  const local = name.split('@')[0].trim();
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

type Cell = { unit: Unit; building?: undefined } | { building: Building; unit?: undefined };

function grid(count: number, cols: number): Point[] {
  const rows = Math.ceil(count / cols);
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = i - row * cols;
    out.push({ x: (col - (inRow - 1) / 2) * SEAT_X, y: (row - (rows - 1) / 2) * SEAT_Y });
  }
  return out.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y) || p.y - q.y || p.x - q.x);
}

function seatsIn(rect: Rect, head: number, bottom: number, count: number): Point[] {
  if (!count) return [];
  const fitCols = Math.max(1, Math.floor((rect.w - SIDE * 2) / SEAT_X) + 1);
  const rows = Math.ceil(count / fitCols);
  const cols = Math.ceil(count / rows);
  const first = rect.y + head + TOP;
  const last = rect.y + rect.h - bottom;
  const cy = Math.max(first + ((rows - 1) * SEAT_Y) / 2, (first + last) / 2);
  const cx = rect.x + rect.w / 2;
  return grid(count, cols).map((p) => ({ x: cx + p.x, y: cy + p.y }));
}

const naturalW = (cells: number, rows: number) =>
  Math.max(MIN_W, (Math.max(1, Math.ceil(cells / rows)) - 1) * SEAT_X + SIDE * 2);
const fieldW = (plots: number) => Math.ceil(plots / Math.floor((FARM - 12) / PLOT)) * PLOT + 24;
const bandH = (rows: number) => REGION_HEAD + TOP + (rows - 1) * SEAT_Y + BOTTOM + FARM;

function buildingsPerRow(inner: number, count: number) {
  const step = Math.max(BUILD_MIN, Math.min(BUILD_STEP, inner / Math.max(1, count)));
  return Math.max(1, Math.floor(inner / step + 0.001));
}

function slots(x: number, y: number) {
  const out: Point[] = [];
  for (let row = 0; row < SLOT_ROWS; row++) {
    for (let col = 0; col < SLOT_COLS; col++) {
      out.push({ x: x + (col - (SLOT_COLS - 1) / 2) * SLOT_STEP, y: y - UNIT_R - 7 - row * SLOT_STEP });
    }
  }
  return out;
}

interface Item {
  region: Region;
  cells: Cell[];
  min?: number;
}

interface Part {
  id: string;
  name: string;
  units: Unit[];
  w: number;
  h: number;
}

interface Segment {
  side: 'L' | 'R' | 'F';
  cap: number;
  sum: number;
  items: number[];
}

interface Ring {
  score: number;
  rows: number;
  rowH: number;
  side: number;
  width: number;
  centreW: number;
  centreH: number;
  left: Segment[];
  right: Segment[];
  full: Segment[];
  widths: number[];
}

function assign(order: number[], widths: number[], segments: Segment[]) {
  for (const i of order) {
    const w = widths[i];
    let best: Segment | null = null;
    let bestFill = Infinity;
    for (const seg of segments) {
      const next = seg.sum + w + (seg.items.length ? GAP : 0);
      if (next > seg.cap + 0.01) continue;
      const fill = next / seg.cap;
      if (fill < bestFill) {
        bestFill = fill;
        best = seg;
      }
    }
    if (!best) return false;
    best.sum += w + (best.items.length ? GAP : 0);
    best.items.push(i);
  }
  return segments.every((seg) => seg.items.length > 0);
}

function planRing(items: Item[], centre: { w: number; h: number }, aspect: number, beside: number): Ring | null {
  if (!items.length) return null;
  let best: Ring | null = null;
  const maxCells = Math.max(1, ...items.map((item) => item.cells.length));
  const segment = (side: Segment['side'], cap: number): Segment => ({ side, cap, sum: 0, items: [] });

  for (let rows = 1; rows <= Math.min(4, maxCells); rows++) {
    const rowH = bandH(rows);
    const widths = items.map((item) => Math.max(naturalW(item.cells.length, rows), item.min ?? 0));
    const order = items.map((_, i) => i).sort((a, b) => widths[b] - widths[a] || a - b);
    const total = widths.reduce((sum, w) => sum + w + GAP, 0);
    const minW = Math.min(...widths);
    const maxW = Math.max(...widths);
    const sideRowsMax = Math.max(1, Math.floor((centre.h + GAP) / (rowH + GAP)));
    const configs: [number, number][] = [[0, 0]];
    for (let a = 1; a <= sideRowsMax; a++) {
      configs.push([a, a]);
      if (a > 1) configs.push([a, a - 1]);
    }

    for (const [nL, nR] of configs) {
      const sides = nL + nR;
      const sideTop = sides ? Math.min(SIDE_MAX, total) : 0;
      for (let side = sides ? minW : 0; side <= sideTop; side += SIDE_STEP) {
        const width = Math.max(maxW, centre.w + (sides ? 2 * (side + GAP) : 0));
        const centreW = width - (sides ? 2 * (side + GAP) : 0);
        const centreH = Math.max(centre.h, nL ? nL * rowH + (nL - 1) * GAP : 0);
        const need = total - sides * (side + GAP);
        const fullMin = Math.max(0, Math.ceil(need / (width + GAP)));
        for (let full = fullMin; full <= fullMin + 2; full++) {
          if (!sides && !full) continue;
          const left = Array.from({ length: nL }, () => segment('L', side));
          const right = Array.from({ length: nR }, () => segment('R', side));
          const rowsFull = Array.from({ length: full }, () => segment('F', width));
          const segments = [...left, ...right, ...rowsFull];
          if (!assign(order, widths, segments)) continue;
          const height = centreH + full * (rowH + GAP);
          const zoom = Math.min(aspect / (width + beside), 1 / height);
          let stretch = 1;
          for (const seg of segments) {
            const gaps = (seg.items.length - 1) * GAP;
            stretch = Math.max(stretch, (seg.cap - gaps) / (seg.sum - gaps));
          }
          const tall = nR ? (centreH - (nR - 1) * GAP) / nR / rowH : 1;
          const score = zoom / (1 + 0.3 * Math.max(0, stretch - 1.3) + 0.15 * Math.max(0, tall - 1.3));
          if (!best || score > best.score) {
            best = { score, rows, rowH, side: sides ? side : 0, width, centreW, centreH, left, right, full: rowsFull, widths };
          }
        }
        if (!sides) break;
      }
    }
  }
  return best;
}

export function buildLayout(replay: Replay, aspect = 1.6, planted: Map<string, number> = new Map(), gear: GearFile['entities'] = {}): Layout {
  const weight = new Map<string, number>();
  for (const e of replay.events) {
    if (e.kind !== 'send') continue;
    for (const id of [e.from, e.to]) if (id) weight.set(id, (weight.get(id) ?? 0) + 1);
  }
  const byWeight = (a: Unit, b: Unit) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || a.id.localeCompare(b.id);
  const membersOf = (region: Region) => replay.units.filter((u) => u.region === region.id).sort(byWeight);
  const housedIn = (region: Region) => replay.buildings.filter((b) => b.region === region.id);

  const regions: LayoutRegion[] = [];
  const groups: LayoutGroup[] = [];
  const buildings: LayoutBuilding[] = [];
  const features: LayoutFeature[] = [];
  const units: LayoutUnit[] = [];
  const roles = unitRoles(replay.units, replay.events);
  const activity = new Map<string, number>();
  for (const e of replay.events) if (e.feature) activity.set(e.feature, (activity.get(e.feature) ?? 0) + e.count);
  for (const s of replay.sessions) activity.set(`claude/${s.tool}`, (activity.get(`claude/${s.tool}`) ?? 0) + 1);
  const featuresOf = (b: Building) => {
    const list = (replay.features ?? []).filter((f) => f.building === b.id);
    return list.length < RANK_MIN ? list : list.sort((x, y) => (activity.get(y.id) ?? 0) - (activity.get(x.id) ?? 0));
  };

  const seatUnit = (unit: Unit, p: Point) =>
    units.push({
      id: unit.id,
      index: units.length,
      kind: unit.kind,
      role: roles.get(unit.id) ?? 'townsfolk',
      sprite: gearSprite(roles.get(unit.id) ?? 'townsfolk', gear[unit.id]?.gear),
      name: unit.name,
      label: unitLabel(unit.name),
      region: unit.region,
      group: unit.group,
      x: p.x,
      y: p.y,
      slots: slots(p.x, p.y),
      palace: unit.id === PALACE || undefined,
      since: unit.since,
      until: unit.until,
      into: unit.into,
      stages: unit.stages,
      calls: unit.calls,
      visits: unit.visits,
      origin: unit.origin,
    });
  const seatBuilding = (b: Building, p: Point) =>
    buildings.push({
      id: b.id,
      region: b.region,
      name: b.name,
      resource: b.resource,
      x: p.x,
      y: p.y,
      size: BUILDING_SIZE,
      rect: { x: p.x - BUILDING_SIZE / 2 - 4, y: p.y - BUILDING_SIZE / 2 - 4, w: BUILDING_SIZE + 8, h: BUILDING_SIZE + 20 },
      features: [],
    });
  const seatStructure = (s: Structure, x: number, y: number) => {
    const cells: LayoutFeature[] = s.features.map((f, i) => {
      const rect: Rect = {
        x: x + STRUCT_PAD + (i % s.cols) * (s.cell + CELL_GAP),
        y: y + STRUCT_HEAD + Math.floor(i / s.cols) * (CELL_H + CELL_GAP),
        w: (s.box - STRUCT_PAD * 2 - (s.cols - 1) * CELL_GAP) / s.cols,
        h: CELL_H,
      };
      return { id: f.id, building: f.building, name: f.name, rect, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    });
    features.push(...cells);
    const body = s.h - (s.building.id === SQUARE ? PLAZA : 0);
    if (s.building.id === SQUARE) square = { x: x + 4, y: y + body + APRON, w: s.box - 8, h: PLAZA - APRON - 4 };
    const kept = STORE_BY[s.building.id];
    if (kept) storeAt[kept] = { x: x + s.box + STORE_W / 2 + 2, y: y + 26 };
    buildings.push({
      id: s.building.id,
      region: s.building.region,
      name: s.building.name,
      resource: s.building.resource,
      x: x + s.box / 2,
      y: y + 22,
      size: BUILDING_SIZE,
      rect: { x, y, w: s.box, h: body },
      features: cells,
    });
  };

  const placeCells = (region: Region, rect: Rect, cells: Cell[]) => {
    regions.push({
      id: region.id,
      kind: region.kind,
      name: region.name,
      rect,
      headcount: cells.filter((cell) => cell.unit).length,
      since: region.since,
      foot: FOOTER,
      ...(region.kind === 'client' ? { farm: { x: rect.x + 12, y: rect.y + rect.h - FOOTER - FARM + 4, w: rect.w - 24, h: FARM - 12 } } : {}),
    });
    const seats = seatsIn(rect, REGION_HEAD, BOTTOM + FARM, cells.length);
    cells.forEach((cell, i) => (cell.unit ? seatUnit(cell.unit, seats[i]) : seatBuilding(cell.building, seats[i])));
  };

  const cellsOf = (region: Region): Cell[] => [
    ...membersOf(region).map((unit) => ({ unit })),
    ...housedIn(region).map((building) => ({ building })),
  ];

  const root = replay.regions.find((region) => region.kind === 'internal') ?? null;
  const ringItems: Item[] = replay.regions
    .filter((region) => region !== root && region.kind !== 'unmapped' && region.kind !== 'recruiting')
    .map((region) => ({ region, cells: cellsOf(region), min: fieldW(planted.get(region.id) ?? 0) }))
    .sort((a, b) => b.cells.length - a.cells.length || a.region.name.localeCompare(b.region.name));
  const outside: Item[] = replay.regions
    .filter((region) => region.kind === 'unmapped' && region.id !== WILD_REGION && replay.units.some((u) => u.region === region.id))
    .map((region) => ({ region, cells: cellsOf(region) }));

  let parts: Part[] = [];
  let partRows: Part[][] = [];
  let housed: Building[] = [];
  const storeAt: { concept?: Point; creative?: Point; brief?: Point } = {};
  let square: Layout['square'];
  const shelf = () => (housed.some((h) => STORE_BY[h.id] === 'concept') && housed.some((h) => STORE_BY[h.id] === 'creative') && housed.some((h) => STORE_BY[h.id] === 'brief') ? 0 : STORE);
  let structures: Structure[] = [];
  let north: Structure[] = [];
  let south: Structure[] = [];
  const west: Structure[] = [];
  const east: Structure[] = [];
  const stackW = (list: Structure[]) => Math.max(0, ...list.map((s) => s.w));
  const stackH = (list: Structure[]) => list.reduce((sum, s) => sum + s.h + STRUCT_GAP + APRON, 0);
  const flank = (list: Structure[]) => (list.length ? stackW(list) + FLANK_GAP : 0);
  let innerW = 0;
  const centre = { w: 0, h: 0 };
  let lord: Unit | null = null;

  if (root) {
    const everyone = membersOf(root);
    lord = everyone.find((u) => u.id === PALACE) ?? null;
    const members = everyone.filter((u) => u !== lord);
    housed = housedIn(root);
    const own = replay.groups.filter((g) => g.region === root.id);
    const ownIds = new Set(own.map((g) => g.id));
    const loose = members.filter((u) => !u.group || !ownIds.has(u.group));
    parts = [
      ...own.map((g) => ({ id: g.id, name: g.name, units: members.filter((u) => u.group === g.id) })),
      { id: `${root.id}/~`, name: loose.every((u) => u.kind === 'system') ? 'Systems' : 'Other', units: loose },
    ]
      .filter((part) => part.units.length)
      .map((part) => {
        const n = part.units.length + (part.units.every((u) => u.kind === 'automation') ? 1 : 0);
        const cols = Math.ceil(Math.sqrt(n * 1.5));
        const rows = Math.ceil(n / cols);
        return {
          ...part,
          w: Math.max(MIN_W, (cols - 1) * SEAT_X + SIDE * 2),
          h: GROUP_HEAD + TOP + (rows - 1) * SEAT_Y + GROUP_BOTTOM,
        };
      })
      .sort((a, b) => b.w - a.w || b.units.length - a.units.length || a.name.localeCompare(b.name));

    if (parts.length) {
      const area = parts.reduce((sum, p) => sum + (p.w + PART_GAP) * (p.h + PART_GAP), 0);
      const lineW = parts.reduce((sum, p) => sum + p.w + PART_GAP, 0);
      const rowCount = Math.min(parts.length, Math.max(1, Math.round(lineW / Math.sqrt(area * 1.7))));
      partRows = Array.from({ length: rowCount }, () => [] as Part[]);
      const sums = partRows.map(() => 0);
      for (const part of parts) {
        let k = 0;
        for (let i = 1; i < rowCount; i++) if (sums[i] < sums[k]) k = i;
        partRows[k].push(part);
        sums[k] += part.w + PART_GAP;
      }
      partRows = partRows
        .filter((row) => row.length)
        .sort((a, b) => b.reduce((s, p) => s + p.units.length, 0) - a.reduce((s, p) => s + p.units.length, 0));
      innerW = Math.max(...partRows.map((row) => row.reduce((sum, p) => sum + p.w, 0) + (row.length - 1) * PART_GAP));
    }
    structures = housed.map((b) => structureOf(b, featuresOf(b)));
    const workers = structures.filter((s) => s.building.id.startsWith(WORKER_PREFIX)).sort((a, b) => b.h - a.h || a.building.id.localeCompare(b.building.id));
    north = structures.filter((s) => NORTH.has(s.building.id));
    south = structures.filter((s) => !NORTH.has(s.building.id) && !s.building.id.startsWith(WORKER_PREFIX)).sort((a, b) => b.h - a.h);
    workers.forEach((s, i) => (i % 2 ? east : west).push(s));
    const spotOf = (id: string) => {
      for (const list of [north, south, west, east]) {
        const i = list.findIndex((s) => s.building.id === id);
        if (i >= 0) return { list, i };
      }
      return null;
    };
    for (const [one, other] of SWAPS) {
      const a = spotOf(one);
      const b = spotOf(other);
      if (a && b) [a.list[a.i], b.list[b.i]] = [b.list[b.i], a.list[a.i]];
    }
    const rowsH = partRows.reduce((sum, row) => sum + Math.max(...row.map((p) => p.h)) + PART_GAP, 0) - (partRows.length ? PART_GAP : 0);
    innerW = Math.max(Math.max(innerW, 260) + flank(west) + flank(east), ...structures.map((s) => s.w));
    centre.w = innerW + ROOT_PAD * 2;
    centre.h =
      ROOT_HEAD +
      wrapStructures(north, innerW).h +
      Math.max(rowsH + (lord ? PALACE_BAND : 0), stackH(west), stackH(east)) +
      wrapStructures(south, innerW).h +
      ROOT_PAD +
      shelf() +
      FOOTER;
  }

  let barn: Layout['barn'];
  let stores: Layout['stores'];
  const placeRoot = (rect: Rect) => {
    if (!root) return;
    regions.push({
      id: root.id,
      kind: root.kind,
      name: root.name,
      rect,
      headcount: parts.reduce((n, p) => n + p.units.length, lord ? 1 : 0),
      foot: FOOTER,
    });
    const full = rect.w - ROOT_PAD * 2;
    const seatBand = (list: Structure[], from: number) => {
      const band = wrapStructures(list, full);
      let sy = from;
      for (const row of band.rows) {
        const slack = (full - row.w) / (row.items.length + 1);
        let sx = rect.x + ROOT_PAD + slack;
        for (const s of row.items) {
          seatStructure(s, sx, sy + (row.h - s.h) / 2);
          sx += s.w + STRUCT_GAP + slack;
        }
        sy += row.h + STRUCT_GAP + APRON;
      }
      return band.h;
    };
    const top = rect.y + ROOT_HEAD + seatBand(north, rect.y + ROOT_HEAD);
    const southH = wrapStructures(south, full).h;
    const floor = rect.y + rect.h - ROOT_PAD - shelf() - FOOTER - southH;
    seatBand(south, floor + STRUCT_GAP);
    const seatStack = (list: Structure[], x: number) => {
      const slack = Math.max(0, floor - top - stackH(list)) / (list.length + 1);
      let sy = top + slack;
      for (const s of list) {
        seatStructure(s, x + (stackW(list) - s.w) / 2, sy);
        sy += s.h + STRUCT_GAP + APRON + slack;
      }
    };
    seatStack(west, rect.x + ROOT_PAD);
    seatStack(east, rect.x + rect.w - ROOT_PAD - stackW(east));
    const low = rect.y + rect.h - FOOTER - STORE / 2 - 2;
    stores = { concept: storeAt.concept ?? { x: rect.x + rect.w * 0.36, y: low }, creative: storeAt.creative ?? { x: rect.x + rect.w * 0.64, y: low }, brief: storeAt.brief ?? { x: rect.x + rect.w * 0.5, y: low } };
    const inner = full - flank(west) - flank(east);
    const middle = rect.x + ROOT_PAD + flank(west) + inner / 2;
    if (!partRows.length) {
      if (lord) seatUnit(lord, { x: middle, y: (top + floor) / 2 });
      return;
    }
    const natural = partRows.map((row) => Math.max(...row.map((p) => p.h)));
    const spare = floor - top - natural.reduce((sum, h) => sum + h, 0) - (partRows.length - 1) * PART_GAP - (lord ? PALACE_BAND : 0);
    const extra = Math.max(0, spare) / partRows.length;
    let y = top;
    partRows.forEach((row, r) => {
      const h = natural[r] + extra;
      const sum = row.reduce((s, p) => s + p.w, 0);
      const k = (inner - (row.length - 1) * PART_GAP) / sum;
      let x = rect.x + ROOT_PAD + flank(west);
      for (const part of row) {
        const box: Rect = { x, y, w: part.w * k, h };
        groups.push({ id: part.id, region: root.id, name: part.name, rect: box });
        const stabled = part.units.every((u) => u.kind === 'automation');
        const seats = seatsIn(box, GROUP_HEAD, GROUP_BOTTOM, part.units.length + (stabled ? 1 : 0));
        if (stabled) barn = { ...seats.shift()!, group: part.id };
        part.units.forEach((unit, i) => seatUnit(unit, seats[i]));
        x += box.w + PART_GAP;
      }
      y += h + PART_GAP;
      if (lord && r === Math.ceil(partRows.length / 2) - 1) {
        seatUnit(lord, { x: middle, y: y - PART_GAP / 2 + PALACE_BAND / 2 });
        y += PALACE_BAND;
      }
    });
  };

  const outsideRows = (item: Item) => Math.max(1, Math.ceil(Math.sqrt(item.cells.length / 1.5)));
  const beside = outside.length
    ? OUTSIDE_GAP + Math.max(...outside.map((item) => naturalW(item.cells.length, outsideRows(item))))
    : 0;
  const plan = planRing(ringItems, centre, aspect, beside);
  let mapW = centre.w;
  let centreTop = 0;
  let centreH = centre.h;

  if (!plan) {
    if (root) placeRoot({ x: 0, y: 0, w: centre.w, h: centre.h });
  } else {
    const step = plan.rowH + GAP;
    const topRows = Math.ceil(plan.full.length / 2);
    const sided = plan.left.length + plan.right.length > 0;
    const centreX = sided ? plan.side + GAP : 0;
    centreTop = topRows * step;
    centreH = plan.centreH;
    mapW = plan.width;
    if (root) placeRoot({ x: centreX, y: centreTop, w: plan.centreW, h: plan.centreH });

    const fillSegment = (seg: Segment, x: number, y: number, h: number) => {
      const gaps = (seg.items.length - 1) * GAP;
      const natural = seg.sum - gaps;
      const k = Math.min(MAX_STRETCH, (seg.cap - gaps) / natural);
      let at = x + (seg.cap - gaps - natural * k) / 2;
      for (const i of seg.items) {
        const w = plan.widths[i] * k;
        placeCells(ringItems[i].region, { x: at, y, w, h }, ringItems[i].cells);
        at += w + GAP;
      }
    };
    const column = (segs: Segment[], x: number) => {
      const h = (plan.centreH - (segs.length - 1) * GAP) / segs.length;
      segs.forEach((seg, i) => fillSegment(seg, x, centreTop + i * (h + GAP), h));
    };
    column(plan.left, 0);
    column(plan.right, centreX + plan.centreW + GAP);
    plan.full.forEach((seg, j) => {
      const n = Math.floor(j / 2);
      const y = j % 2 === 0 ? centreTop - (n + 1) * step : centreTop + plan.centreH + GAP + n * step;
      fillSegment(seg, 0, y, plan.rowH);
    });
  }

  const outsideH = outside.reduce((sum, item) => sum + bandH(outsideRows(item)) + GAP, -GAP);
  let outsideY = centreTop + (centreH - outsideH) / 2;
  for (const item of outside) {
    const rows = outsideRows(item);
    const w = naturalW(item.cells.length, rows);
    const h = bandH(rows);
    placeCells(item.region, { x: mapW + OUTSIDE_GAP, y: outsideY, w, h }, item.cells);
    outsideY += h + GAP;
  }

  const left = Math.min(0, ...regions.map((r) => r.rect.x));
  const top = Math.min(0, ...regions.map((r) => r.rect.y));
  const right = Math.max(1, ...regions.map((r) => r.rect.x + r.rect.w));
  const low = Math.max(1, ...regions.map((r) => r.rect.y + r.rect.h));
  const core: Rect = { x: left, y: top, w: right - left, h: low - top };
  const staged = replay.units.some((unit) => unit.stages?.length);
  const margin = staged ? STRATA_GAP + STRATA_BAND * LEAD_STAGES.length : 0;
  let bounds: Rect = { x: core.x - margin, y: core.y, w: core.w + margin, h: core.h };

  const camp = replay.regions.find((region) => region.id === RECRUIT_REGION);
  let grounds: Layout['grounds'];
  if (camp) {
    const rect: Rect = { x: core.x, y: core.y - GROUNDS_GAP - GROUNDS_H, w: core.w, h: GROUNDS_H };
    const members = membersOf(camp);
    const staff = members.filter((unit) => unit.kind !== 'recruit');
    const recruits = members.filter((unit) => unit.kind === 'recruit');
    const posts = housedIn(camp).map((b) => structureOf(b, featuresOf(b)));
    const staffRows = Math.max(1, Math.ceil(staff.length / 4));
    const quarters = Math.min(rect.w * 0.34, Math.max(stackW(posts), staff.length ? naturalW(staff.length, staffRows) : 0, 150));
    regions.push({ id: camp.id, kind: camp.kind, name: camp.name, rect, headcount: members.length, foot: FOOTER });
    let sy = rect.y + REGION_HEAD + 20;
    for (const s of posts) {
      seatStructure(s, rect.x + GROUNDS_PAD + (quarters - s.w) / 2, sy);
      sy += s.h + STRUCT_GAP;
    }
    const mess: Rect = { x: rect.x + GROUNDS_PAD, y: sy - TOP + 24, w: quarters, h: rect.y + rect.h - sy + TOP - 24 };
    seatsIn(mess, 0, BOTTOM, staff.length).forEach((p, i) => seatUnit(staff[i], p));

    const left = rect.x + GROUNDS_PAD * 2 + quarters;
    const yardW = (rect.x + rect.w - GROUNDS_PAD - left - YARD_GAP * (RECRUIT_STAGES.length - 1)) / RECRUIT_STAGES.length;
    const yards: Rect[] = RECRUIT_STAGES.map((_, i) => ({ x: left + i * (yardW + YARD_GAP), y: rect.y + REGION_HEAD, w: yardW, h: rect.h - REGION_HEAD - GROUNDS_PAD - FOOTER }));
    const level = (value: number) => Math.min(RECRUIT_STAGES.length - 1, Math.max(1, value));
    const ranks: { unit: Unit; step: number; t: number }[][] = yards.map(() => []);
    for (const unit of recruits) {
      const stages = unit.stages?.length ? unit.stages : [[unit.since ?? 0, 1] as [number, number]];
      stages.forEach(([t, value], step) => {
        if (step === stages.length - 1 || stages[step + 1][0] > replay.window.start) ranks[level(value)].push({ unit, step, t });
      });
    }
    const spots = new Map<string, Point[]>();
    ranks.forEach((rank, i) => {
      const yard = yards[i];
      const field = { w: yard.w - 28, h: yard.h - YARD_HEAD - 22 };
      const step = Math.min(DRILL_STEP, Math.max(DRILL_MIN, Math.sqrt((field.w * field.h) / Math.max(1, rank.length))));
      const cols = Math.max(1, Math.floor(field.w / step) + 1);
      const rows = Math.ceil(rank.length / cols);
      const stepY = rows > 1 ? Math.min(step * 1.2, field.h / (rows - 1)) : 0;
      const sizes = new Map<string | undefined, number>();
      for (const { unit } of rank) sizes.set(unit.role, (sizes.get(unit.role) ?? 0) + 1);
      rank
        .sort((a, b) => sizes.get(a.unit.role)! - sizes.get(b.unit.role)! || a.t - b.t || a.unit.id.localeCompare(b.unit.id))
        .forEach(({ unit, step: k }, n) => {
          const row = Math.floor(n / cols);
          const inRow = row === rows - 1 ? rank.length - row * cols : cols;
          const list = spots.get(unit.id) ?? [];
          list[k] = { x: yard.x + yard.w / 2 + ((n % cols) - (inRow - 1) / 2) * step, y: yard.y + YARD_HEAD + row * stepY };
          spots.set(unit.id, list);
        });
    });
    for (const unit of recruits) {
      const list = spots.get(unit.id)!;
      const last = list[list.length - 1];
      for (let k = 0; k < list.length; k++) list[k] ??= last;
      seatUnit(unit, last);
      units[units.length - 1].spots = list;
    }
    grounds = { rect, yards, posts: yards.map((yard) => ({ x: yard.x + yard.w / 2, y: yard.y + (yard.h + YARD_HEAD - 22) / 2 })) };
    bounds = { x: bounds.x, y: rect.y, w: bounds.w, h: bounds.h + core.y - rect.y };
  }
  replay.units
    .filter((unit) => unit.region === WILD_REGION)
    .forEach((unit, i) => seatUnit(unit, { x: core.x + core.w * ((i * 0.618034) % 1), y: core.y + core.h * ((i * 0.381966 + 0.25) % 1) }));

  return {
    regions,
    groups,
    buildings,
    barn,
    stores,
    square,
    features,
    units,
    index: new Map(units.map((u) => [u.id, u.index])),
    bounds,
    unitRadius: UNIT_R,
    ...(grounds ? { grounds } : {}),
    ...(staged
      ? {
          strata: {
            core,
            band: STRATA_BAND,
            gap: STRATA_GAP,
            top: core.y + HEAVEN_H + STRATA_GAP,
            height: core.h - JAIL_H - HEAVEN_H - STRATA_GAP * 2,
            jail: { x: core.x - margin, y: core.y + core.h - JAIL_H, w: STRATA_BAND * LEAD_STAGES.length - 10, h: JAIL_H },
            heaven: { x: core.x - margin, y: core.y, w: STRATA_BAND * LEAD_STAGES.length - 10, h: HEAVEN_H },
          },
        }
      : {}),
  };
}
