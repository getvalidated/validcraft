import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../src/schema';

export const WINDOW_FILE = path.resolve('data/window.json');

const TZ = 'America/Los_Angeles';
const HOUR = 3_600_000;
const DAYS = 7;

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function pacificParts(t: number) {
  const parts = Object.fromEntries(partsFormat.formatToParts(t).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

export function pacificMidnight(year: number, month: number, day: number) {
  const target = Date.UTC(year, month - 1, day);
  let t = target + 8 * HOUR;
  for (let i = 0; i < 3; i++) {
    const p = pacificParts(t);
    t += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return t;
}

export function computeWindow(now = Date.now()): Window {
  const today = pacificParts(now);
  return {
    start: pacificMidnight(today.year, today.month, today.day - DAYS),
    end: pacificMidnight(today.year, today.month, today.day),
  };
}

export function weekEnd(start: number) {
  const first = pacificParts(start);
  return pacificMidnight(first.year, first.month, first.day + DAYS);
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export const weekId = (window: Window) => `${day(window.start)}_${day(weekEnd(window.start))}`;

export function nextWindow(last: Window | null, now = Date.now()): Window {
  if (!last) return computeWindow(now);
  const start = now >= weekEnd(last.start) ? weekEnd(last.start) : last.start;
  return { start, end: Math.min(now, weekEnd(start)) };
}

export function readWindow(): Window | null {
  if (!fs.existsSync(WINDOW_FILE)) return null;
  const { start, end } = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
  return { start, end };
}

export function loadWindow(): Window {
  const saved = readWindow();
  if (saved) return saved;
  const window = computeWindow();
  fs.mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
  fs.writeFileSync(WINDOW_FILE, JSON.stringify(window, null, 2));
  return window;
}

export const sameWindow = (a: Window, b: Window) => a.start === b.start && a.end === b.end;

export const describeWindow = (window: Window) =>
  `${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()}`;
