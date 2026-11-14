import type { Window } from '../schema';
import type { Tick } from '../seam';

const TZ = 'America/Los_Angeles';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function sinceMidnight(t: number) {
  const parts = Object.fromEntries(partsFormat.formatToParts(t).map((p) => [p.type, Number(p.value)]));
  return parts.hour * HOUR + parts.minute * MINUTE + parts.second * 1000 + (((t % 1000) + 1000) % 1000);
}

function snap(t: number) {
  const elapsed = sinceMidnight(t);
  if (elapsed === 0) return t;
  return elapsed < DAY / 2 ? t - elapsed : t + (DAY - elapsed);
}

export function createTicker(window: Window) {
  const starts = [snap(window.start - sinceMidnight(window.start))];
  while (starts[starts.length - 1] + DAY / 2 < window.end) starts.push(snap(starts[starts.length - 1] + DAY));

  return (t: number): Tick => {
    let day = 0;
    while (day + 1 < starts.length && starts[day + 1] <= t) day++;
    return { day, minute: Math.max(0, Math.floor((t - starts[day]) / MINUTE)) };
  };
}
