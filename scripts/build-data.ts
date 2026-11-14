import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, type Registry, type ReplayRef, type SourceFile } from '../src/schema';
import { buildReplay, printReport } from './lib/build';
import { writeLibrary } from './lib/library';
import { readLedgers, writeTraces } from './lib/ledger';
import { liveSpans } from './lib/live';
import { computeMetrics } from './lib/metrics';
import { PUBLISHED, reason, takeLibrary } from './lib/published';
import { describeWindow, readWindow, weekId } from './lib/window';

const SOURCES = path.resolve('data/sources');
const REGISTRY = path.resolve('data/registry.json');
const OUT = path.resolve('data/replay.json');
const UNMAPPED = path.resolve('data/unmapped.json');
const LIBRARY = path.resolve('data/library');
const INDEX = path.join(LIBRARY, 'index.json');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const window = readWindow();
if (!window) fail('No data/window.json. Run `npm run pull` first.');

const files = fs.existsSync(SOURCES) ? fs.readdirSync(SOURCES).filter((f) => f.endsWith('.json')).sort() : [];
if (!files.length) fail('No files in data/sources. Run `npm run pull` first.');

const sources: SourceFile[] = files.map((f) => {
  const file = JSON.parse(fs.readFileSync(path.join(SOURCES, f), 'utf8'));
  if (file.schemaVersion !== SCHEMA_VERSION) fail(`data/sources/${f} is not schema version ${SCHEMA_VERSION}. Pull it again.`);
  return file;
});

let registry: Registry | null = null;
if (fs.existsSync(REGISTRY)) {
  registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Registry;
  if (registry.schemaVersion !== SCHEMA_VERSION) fail(`data/registry.json is not schema version ${SCHEMA_VERSION}. Run \`npm run registry\` again.`);
}

try {
  const { taken } = takeLibrary(LIBRARY);
  if (taken.length) console.log(`Took ${taken.join(', ')} from ${PUBLISHED}, not in data/library before.`);
} catch (err) {
  fail(`Could not take the weeks already in ${PUBLISHED}: ${reason(err)}`);
}

const { replay, report, unmapped, ledger } = buildReplay({ window, sources, registry, ledger: readLedgers(LIBRARY) });

console.log(`Window ${describeWindow(window)}`);
printReport(report);
if (!report.ok) fail('Reconciliation failed. data/replay.json was not written.');
replay.metrics = computeMetrics(window);
fs.writeFileSync(OUT, JSON.stringify(replay));
fs.writeFileSync(UNMAPPED, JSON.stringify(unmapped, null, 2));
const id = weekId(window);
fs.mkdirSync(LIBRARY, { recursive: true });
fs.copyFileSync(OUT, path.join(LIBRARY, `${id}.json`));
const library: ReplayRef[] = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
fs.writeFileSync(
  INDEX,
  JSON.stringify([...library.filter((entry) => entry.id !== id), { id, ...window }].sort((a, b) => a.start - b.start), null, 2),
);
console.log(
  `Wrote ${path.relative(process.cwd(), OUT)}: ${replay.events.length} events, ${replay.units.length} units, ${replay.sources.join(' + ')}.`,
);
console.log(`Wrote data/library/${id}.json, ${library.some((entry) => entry.id === id) ? 'replacing the one in' : 'added to'} the replay library.`);
console.log(
  `Wrote ${path.relative(process.cwd(), UNMAPPED)}: ${unmapped.actors.length} actors, ${unmapped.clientHints.length} client hints.`,
);

const world = writeLibrary(LIBRARY);
if (world) {
  console.log(
    `Wrote data/library/world.json: ${world.units} units, ${world.regions} regions, ${world.buildings} buildings across ${world.weeks} weeks, and each week's activity bins and closing totals in data/library/index.json.`,
  );
}
ledger.live = liveSpans([...readLedgers(LIBRARY), ledger]);
const traced = writeTraces(LIBRARY, ledger);
console.log(`Wrote data/library/${ledger.id}.links.json and data/library/traces.json: ${traced.traces.length} concept traces across ${traced.weeks} weeks.`);
