import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, type SourceFile } from '../src/schema';
import { loadWindow } from './lib/window';
import { derive, type Overrides } from './registry/derive';
import { pull, readRaw } from './registry/pull';
import { requestCount } from './registry/raw';

const SOURCES = path.resolve('data/sources');
const OVERRIDES = path.resolve('data/registry-overrides.json');
const OUT = path.resolve('data/registry.json');
const REPORT = path.resolve('data/registry-report.json');

function readSources(): SourceFile[] {
  if (!fs.existsSync(SOURCES)) return [];
  return fs
    .readdirSync(SOURCES)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = JSON.parse(fs.readFileSync(path.join(SOURCES, f), 'utf8')) as SourceFile;
      if (file.schemaVersion !== SCHEMA_VERSION) throw new Error(`data/sources/${f} is not schema version ${SCHEMA_VERSION}. Pull it again.`);
      return file;
    });
}

function readOverrides(): Overrides {
  const saved = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};
  return {
    identities: saved.identities ?? {},
    clientHints: saved.clientHints ?? {},
    ignoreChannels: saved.ignoreChannels ?? [],
  };
}

async function main() {
  const window = loadWindow();
  await pull(window);
  const sources = readSources();
  const { registry, report } = derive(readRaw(window), sources, readOverrides());
  fs.writeFileSync(OUT, JSON.stringify(registry));
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('Registry');
  row('API requests this run', requestCount());
  row('source files read', sources.length);
  row('regions', report.regions.total);
  row('  client', report.regions.client);
  row('groups', report.groups);
  row('units', report.units.total);
  row('  person', report.units.person);
  row('  client', report.units.client);
  row('  automation', report.units.automation);
  row('  prospect', report.units.prospect);
  row('  recruit', report.units.recruit);
  row('identities', report.identities.total);
  row('  slack', report.identities.slack);
  row('  linear', report.identities.linear);
  row('  notion', report.identities.notion);
  row('  other', report.identities.other);
  row('emails', report.emails);
  row('client hints', Object.values(report.clientHints).reduce((sum, n) => sum + n, 0));
  for (const [kind, count] of Object.entries(report.clientHints)) row(`  ${kind}`, count);
  row('shared channels', report.sharedChannels.total);
  row('  matched nothing', report.sharedChannels.unmatched.length);
  row('source actors', report.sourceActors.total);
  row('  still unmapped', report.sourceActors.unmapped.length);
  row('linear projects', report.linearProjects.total);
  row('  matched nothing', report.linearProjects.unmatched.length);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} and ${path.relative(process.cwd(), REPORT)}.`);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requestCount()} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
