import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Window } from '../../../src/schema';
import { inputId } from '../../lib/input';
import { LOOKBACK, RAW, readPage, saveJson, stripMessage, toMs, type RawMessage } from './pull';

const DIR = path.join(RAW, 'export');
const CHANNELS_FILE = path.join(DIR, 'channels.json');
const DAY = 86_400_000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const DAY_MEMBER = /\/(\d{4}-\d{2}-\d{2})\.json$/;
const LISTS = [
  { name: 'channels.json', isPrivate: false },
  { name: 'groups.json', isPrivate: true },
];

export interface ExportChannel {
  id: string;
  name: string;
  created: number | null;
  isPrivate: boolean;
  isArchived: boolean;
  members: string[];
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function rootOf(dir: string) {
  let level = [dir];
  while (level.length) {
    const hit = level.find((d) => fs.existsSync(path.join(d, 'channels.json')));
    if (hit) return hit;
    level = level.flatMap((d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX')
        .map((entry) => path.join(d, entry.name)),
    );
  }
  return null;
}

export function importExport(file: string, window: Window) {
  const zip = path.resolve(file);
  if (!fs.existsSync(zip)) throw new Error(`${file} does not exist.`);
  const members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((m) => m && !m.startsWith('__MACOSX/'));
  const lists = LISTS.flatMap(({ name }) => [
    ...(members.includes(name) ? [name] : []),
    ...(members.some((m) => m.endsWith(`/${name}`)) ? [`*/${name}`] : []),
  ]);
  if (!lists.some((list) => list.endsWith('channels.json'))) throw new Error(`${file} has no channels.json. It is not a Slack workspace export.`);

  const dates = [...new Set(members.flatMap((m) => DAY_MEMBER.exec(m)?.[1] ?? []))].sort();
  if (!dates.some((d) => d >= day(window.start) && d <= day(window.end))) {
    const covers = dates.length ? `covers ${dates[0]} to ${dates[dates.length - 1]}` : 'has no messages';
    throw new Error(`${file} ${covers}, which is outside the window. The export saved before is kept.`);
  }
  const oldest = window.start - LOOKBACK;
  const first = day(oldest - DAY);
  const last = day(window.end + DAY);
  const days = dates.filter((d) => d >= first && d <= last).map((d) => `*/${d}.json`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-export-'));
  try {
    execFileSync('unzip', ['-q', '-o', zip, ...lists, ...days, '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28 });
    const root = rootOf(tmp);
    if (!root) throw new Error(`${file} has no channels.json. It is not a Slack workspace export.`);
    const channels: ExportChannel[] = LISTS.flatMap(({ name, isPrivate }) => {
      const list = path.join(root, name);
      if (!fs.existsSync(list)) return [];
      return readPage(list).map((c: any) => ({
        id: String(c.id),
        name: String(c.name ?? ''),
        created: typeof c.created === 'number' ? c.created : null,
        isPrivate,
        isArchived: !!c.is_archived,
        members: Array.isArray(c.members) ? c.members.filter((id: unknown) => typeof id === 'string') : [],
      }));
    });
    const ids = new Map(channels.map((c) => [c.name.normalize(), c.id]));

    const found = new Map<string, Map<string, RawMessage>>();
    let skipped = 0;
    for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const files = fs.readdirSync(path.join(root, folder.name)).filter((f) => DAY_FILE.test(f));
      const id = ids.get(folder.name.normalize());
      if (!id) {
        if (files.length) skipped++;
        continue;
      }
      const byTs = found.get(id) ?? new Map<string, RawMessage>();
      found.set(id, byTs);
      for (const f of files) {
        for (const m of readPage(path.join(root, folder.name, f))) {
          if (typeof m?.ts !== 'string') continue;
          const t = toMs(m.ts);
          if (t >= oldest && t <= window.end && !byTs.has(m.ts)) byTs.set(m.ts, stripMessage(m));
        }
      }
    }

    fs.rmSync(DIR, { recursive: true, force: true });
    let messages = 0;
    for (const [id, byTs] of found) {
      if (!byTs.size) continue;
      messages += byTs.size;
      saveJson(path.join(DIR, 'history', `${id}.json`), { messages: [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts)) });
    }
    saveJson(CHANNELS_FILE, { input: inputId(zip), start: window.start, end: window.end, channels });
    console.log(`Export ${path.basename(file)}: ${channels.length} channels, ${messages} messages inside the window and its lookback.`);
    if (skipped) console.log(`Export ${path.basename(file)}: ${skipped} folders with messages are not in channels.json or groups.json and were skipped.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function readExportChannels(window: Window): ExportChannel[] {
  if (!fs.existsSync(CHANNELS_FILE)) return [];
  const saved = readPage(CHANNELS_FILE);
  return saved.start === window.start && saved.end === window.end ? saved.channels : [];
}

export function readExportMessages(channel: string): RawMessage[] {
  const file = path.join(DIR, 'history', `${channel}.json`);
  return fs.existsSync(file) ? readPage(file).messages : [];
}
