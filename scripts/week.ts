import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../src/schema';
import { describeWindow, nextWindow, pacificMidnight, readWindow, weekEnd, weekId, WINDOW_FILE } from './lib/window';

const DATA = path.resolve('data');
const ARCHIVE = path.join(DATA, 'archive');
const PARTS = ['raw', 'sources', 'registry.json', 'registry-report.json', 'unmapped.json', 'replay.json', 'window.json'];
const CLIENT_LOG = path.join('raw', 'client-log.jsonl');

const arg = process.argv[2];
const current = readWindow();
const dated = arg ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg) : null;
let fresh: Window | null = null;
if (dated) {
  const start = pacificMidnight(Number(dated[1]), Number(dated[2]), Number(dated[3]));
  fresh = { start, end: Math.min(Date.now(), weekEnd(start)) };
} else if (!arg) fresh = nextWindow(current);
const archived = (id: string) => fs.existsSync(path.join(ARCHIVE, id, 'window.json'));
const kept = fresh && (!current || weekId(fresh) !== weekId(current)) && archived(weekId(fresh)) ? weekId(fresh) : undefined;
const target = fresh ? kept : arg;
if (target && !archived(target)) {
  const have = fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE).sort() : [];
  console.error(`No data/archive/${target}. Archived weeks: ${have.join(', ') || 'none'}.`);
  process.exit(1);
}

if (current) {
  const dir = path.join(ARCHIVE, weekId(current));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const part of PARTS) if (fs.existsSync(path.join(DATA, part))) fs.renameSync(path.join(DATA, part), path.join(dir, part));
  if (fs.existsSync(path.join(dir, CLIENT_LOG))) {
    fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
    fs.renameSync(path.join(dir, CLIENT_LOG), path.join(DATA, CLIENT_LOG));
  }
  console.log(`Kept ${describeWindow(current)} in data/archive/${weekId(current)}.`);
}

if (target) {
  const dir = path.join(ARCHIVE, target);
  for (const part of PARTS) {
    if (!fs.existsSync(path.join(dir, part))) continue;
    if (part === 'raw' && fs.existsSync(path.join(DATA, CLIENT_LOG))) fs.renameSync(path.join(DATA, CLIENT_LOG), path.join(dir, CLIENT_LOG));
    fs.rmSync(path.join(DATA, part), { recursive: true, force: true });
    fs.renameSync(path.join(dir, part), path.join(DATA, part));
  }
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  fs.writeFileSync(WINDOW_FILE, JSON.stringify(fresh, null, 2));
}
const window = readWindow()!;
console.log(`data/ now holds week ${weekId(window)}, window ${describeWindow(window)}.`);
