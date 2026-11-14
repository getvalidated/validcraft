import type { Busy, BusyKind } from '../schema';

export interface BusyNow {
  kind: BusyKind;
  meeting: string | null;
  start: number;
  end: number;
}

export function createBusy(all: Busy[], index: Map<string, number>, unitCount: number) {
  const spans: Busy[][] = Array.from({ length: unitCount }, () => []);
  for (const span of all) {
    const i = index.get(span.unit);
    if (i !== undefined && span.end > span.start) spans[i].push(span);
  }
  for (const list of spans) list.sort((a, b) => a.start - b.start);

  const at = (t: number) =>
    (unit: number): BusyNow | null => {
      let found: Busy | null = null;
      for (const span of spans[unit]) {
        if (span.start > t) break;
        if (t >= span.end) continue;
        if (span.kind === 'ooo') return { kind: 'ooo', meeting: null, start: span.start, end: span.end };
        found = span;
      }
      return found ? { kind: found.kind, meeting: found.meeting, start: found.start, end: found.end } : null;
    };
  return { at, spans };
}
