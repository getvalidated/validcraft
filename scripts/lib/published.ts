import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplayRef } from '../../src/schema';
import { BUCKET } from './bucket';

export const PUBLISHED = BUCKET ? `${BUCKET}/library` : null;
const SHARED = ['index.json', 'world.json', 'traces.json'];
const SHARED_PATTERN = '^(index|world|traces)\\.json$';

export const reason = (err: unknown) =>
  err instanceof Error && !('stderr' in err)
    ? err.message
    : String((err as { stderr?: unknown })?.stderr || (err instanceof Error ? err.message : err))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

function storage(args: string[]) {
  return execFileSync('gcloud', ['storage', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

const readIndex = (file: string): ReplayRef[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);

export function takeLibrary(dir: string) {
  if (!PUBLISHED) return { taken: [], kept: [] };
  let held: string[];
  try {
    held = storage(['ls', `${PUBLISHED}/`])
      .split('\n')
      .filter(Boolean)
      .map((url) => url.slice(url.lastIndexOf('/') + 1));
  } catch (err) {
    if (!/matched no objects/i.test(reason(err))) throw err;
    held = [];
  }
  if (!held.includes('index.json')) return { taken: [], kept: [] };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-library-'));
  storage(['cp', `${PUBLISHED}/index.json`, path.join(tmp, 'index.json')]);
  const weeks = readIndex(path.join(tmp, 'index.json'));
  fs.rmSync(tmp, { recursive: true, force: true });

  const absent = weeks.filter((ref) => !held.includes(`${ref.id}.json`)).map((ref) => ref.id);
  if (absent.length) throw new Error(`${PUBLISHED} lists ${absent.join(', ')} without the full replay.`);

  const indexFile = path.join(dir, 'index.json');
  const ours = readIndex(indexFile).filter((ref) => fs.existsSync(path.join(dir, `${ref.id}.json`)) && !weeks.some((week) => week.id === ref.id));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (id: string) => {
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    const { mtimeMs, size } = fs.statSync(file);
    return `${mtimeMs}:${size}`;
  };
  const before = new Map(weeks.map((ref) => [ref.id, stamp(ref.id)]));
  storage(['rsync', '--checksums-only', '-x', SHARED_PATTERN, PUBLISHED, dir]);
  fs.writeFileSync(indexFile, JSON.stringify([...ours, ...weeks].sort((a, b) => a.start - b.start), null, 2));
  return {
    taken: weeks.filter((ref) => before.get(ref.id) === null).map((ref) => ref.id),
    kept: weeks.filter((ref) => before.get(ref.id) !== null && before.get(ref.id) !== stamp(ref.id)).map((ref) => ref.id),
  };
}

export function putLibrary(dir: string) {
  if (!PUBLISHED) return;
  storage(['rsync', '--checksums-only', '-x', SHARED_PATTERN, dir, PUBLISHED]);
  const shared = SHARED.map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
  storage(['cp', '--gzip-local=json', ...shared, `${PUBLISHED}/`]);
}

export function putParquet(dir: string, target: string) {
  storage(['rsync', '-r', '--checksums-only', dir, target]);
}
