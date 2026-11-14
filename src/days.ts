import { parquetReadObjects } from 'hyparquet';
import { SCHEMA_VERSION, type Replay, type ReplayEvent, type ReplayRef } from './schema';

export interface DayRef {
  id: string;
  week: string;
  start: number;
  end: number;
  rows: number;
  bytes: number;
}

const BASES = ['/__rts', '/data/parquet'];
let base = BASES[0];
const OPTIONAL = ['feature', 'status', 'ours', 'parent', 'amount', 'currency', 'trace'] as const;
const parsers = { timestampFromMilliseconds: (millis: bigint) => Number(millis) };

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchDay(day: DayRef): Promise<ReplayEvent[] | null> {
  try {
    const res = await fetch(`${base}/events/${day.id}.parquet`, { cache: 'no-store' });
    if (!res.ok) return null;
    const rows = (await parquetReadObjects({ file: await res.arrayBuffer(), parsers })) as unknown as ReplayEvent[];
    if (rows.length !== day.rows) return null;
    for (const e of rows) for (const key of OPTIONAL) if (e[key] == null) delete e[key];
    return rows;
  } catch {
    return null;
  }
}

export async function fetchDays(): Promise<DayRef[]> {
  for (const from of BASES) {
    const list = await fetchJson<DayRef[]>(`${from}/index.json`);
    if (Array.isArray(list) && list.length) {
      base = from;
      return list;
    }
  }
  return [];
}

export async function fetchWeek(ref: ReplayRef, days: DayRef[]): Promise<Replay | null> {
  const own = days.filter((day) => day.week === ref.id).sort((a, b) => a.start - b.start);
  if (!own.length) return null;
  const [week, ...parts] = await Promise.all([fetchJson<Replay>(`${base}/weeks/${ref.id}.json`), ...own.map(fetchDay)]);
  if (week?.schemaVersion !== SCHEMA_VERSION || parts.some((part) => !part)) return null;
  week.events = (parts as ReplayEvent[][]).flat();
  return week;
}
