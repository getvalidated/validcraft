import fs from 'node:fs';
import path from 'node:path';
import { parquetWriteBuffer, type BasicType } from 'hyparquet-writer';
import { SCHEMA_VERSION, type Replay, type ReplayEvent, type ReplayRef } from '../src/schema';
import { BUCKET, PARQUET_PREFIX } from './lib/bucket';
import { readLedgers } from './lib/ledger';
import { writeLibrary } from './lib/library';
import { buildTraces } from './lib/lineage';
import { PUBLISHED, putLibrary, putParquet, reason, takeLibrary } from './lib/published';
import { pacificMidnight, weekEnd } from './lib/window';

const LIBRARY = path.resolve('data/library');
const OUT = path.resolve('data/parquet');
const EVENTS = path.join(OUT, 'events');
const WEEKS = path.join(OUT, 'weeks');
const ROW_GROUP = 5000;

const COLUMNS: [name: keyof ReplayEvent, type: BasicType, required?: boolean][] = [
  ['t', 'TIMESTAMP', true],
  ['kind', 'STRING', true],
  ['source', 'STRING', true],
  ['actor', 'STRING', true],
  ['via', 'STRING'],
  ['resource', 'STRING'],
  ['resourceId', 'STRING'],
  ['building', 'STRING'],
  ['from', 'STRING'],
  ['to', 'STRING'],
  ['isReturn', 'BOOLEAN', true],
  ['count', 'INT32', true],
  ['region', 'STRING'],
  ['feature', 'STRING'],
  ['status', 'STRING'],
  ['ours', 'INT32'],
  ['parent', 'STRING'],
  ['amount', 'DOUBLE'],
  ['currency', 'STRING'],
  ['trace', 'STRING'],
];

interface Day {
  id: string;
  week: string;
  start: number;
  end: number;
  events: ReplayEvent[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

try {
  const { taken, kept } = takeLibrary(LIBRARY);
  if (taken.length) console.log(`Took ${taken.join(', ')} from ${PUBLISHED}, not in data/library before.`);
  for (const id of kept) console.log(`${id} is already in ${PUBLISHED} and stays as it is there; data/library/${id}.json now matches it.`);
} catch (err) {
  fail(`Could not take the weeks already in ${PUBLISHED}: ${reason(err)}`);
}
if (!writeLibrary(LIBRARY)) fail('No weeks in data/library. Run `npm run build:data` first.');
fs.writeFileSync(path.join(LIBRARY, 'traces.json'), JSON.stringify(buildTraces(readLedgers(LIBRARY)).traces));
const refs: ReplayRef[] = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'index.json'), 'utf8'));

fs.mkdirSync(EVENTS, { recursive: true });
fs.mkdirSync(WEEKS, { recursive: true });
const days = new Map<string, Day>();
const dayOf = (t: number, week: string) => {
  const id = dayFormat.format(t);
  if (!days.has(id)) {
    const [year, month, date] = id.split('-').map(Number);
    days.set(id, { id, week, start: pacificMidnight(year, month, date), end: pacificMidnight(year, month, date + 1), events: [] });
  }
  const day = days.get(id)!;
  if (day.week !== week) fail(`${id} has events from both ${day.week} and ${week}. Weeks must not share a day.`);
  return day;
};

let read = 0;
for (const ref of refs) {
  const replay: Replay = JSON.parse(fs.readFileSync(path.join(LIBRARY, `${ref.id}.json`), 'utf8'));
  if (replay.schemaVersion !== SCHEMA_VERSION) fail(`data/library/${ref.id}.json is not schema version ${SCHEMA_VERSION}. Build it again.`);
  const last = weekEnd(ref.start) - 1;
  let day: Day | undefined;
  for (const e of replay.events) {
    const t = Math.min(last, Math.max(ref.start, e.t));
    if (!day || t < day.start || t >= day.end) day = dayOf(t, ref.id);
    day.events.push(e);
  }
  read += replay.events.length;
  fs.writeFileSync(path.join(WEEKS, `${ref.id}.json`), JSON.stringify({ ...replay, events: [] }));
}

let bytes = 0;
const index = [...days.values()]
  .sort((a, b) => a.start - b.start)
  .map(({ id, week, start, end, events }) => {
    events.sort((a, b) => a.t - b.t);
    const buffer = parquetWriteBuffer({
      columnData: COLUMNS.map(([name, type, required]) => ({ name, type, nullable: !required, data: events.map((e) => e[name] ?? null) })),
      rowGroupSize: ROW_GROUP,
      kvMetadata: [{ key: 'schemaVersion', value: String(SCHEMA_VERSION) }],
    });
    const file = path.join(EVENTS, `${id}.parquet`);
    fs.writeFileSync(`${file}.tmp`, new Uint8Array(buffer));
    fs.renameSync(`${file}.tmp`, file);
    bytes += buffer.byteLength;
    return { id, week, start, end, rows: events.length, bytes: buffer.byteLength };
  });

const written = index.reduce((n, day) => n + day.rows, 0);
if (written !== read) fail(`Wrote ${written} events but read ${read} from data/library.`);
fs.writeFileSync(path.join(OUT, 'index.json'), `[\n${index.map((day) => JSON.stringify(day)).join(',\n')}\n]\n`);
console.log(`Wrote data/parquet/events: ${written} events from ${refs.length} weeks into ${index.length} day files, ${(bytes / 1e6).toFixed(1)} MB, listed in data/parquet/index.json, and each week without its events in data/parquet/weeks.`);

if (!BUCKET) process.exit(0);
const target = `${BUCKET}/${PARQUET_PREFIX}`;
try {
  putParquet(OUT, target);
  putLibrary(LIBRARY);
} catch (err) {
  fail(`The files are in data/parquet but could not be uploaded to ${target}: ${reason(err)}`);
}
console.log(`Uploaded to ${target} and ${PUBLISHED}.`);
