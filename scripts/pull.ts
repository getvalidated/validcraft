import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { BUCKET } from './lib/bucket';
import { loadWindow, weekId } from './lib/window';

const LANES = [
  ['pull:notion'],
  ['pull:sessions'],
  ['pull:meta-activity', 'pull:tiktok-activity'],
  ['pull:linear'],
  ['pull:slack'],
  ['pull:spend'],
  ['pull:github'],
  ['pull:sentry'],
  ['pull:ops'],
];
const AFTER = ['registry', 'pull:calendar', 'pull:workspace'];
const ALWAYS = new Set(['registry']);
const PARTIAL = 3;
const SHAPES: Record<string, number> = { linear: 3, github: 2, workspace: 2, notion: 2, slack: 2, calendar: 2, spend: 2, sessions: 2, ops: 2 };
const INPUTS: Record<string, { env: string; stamp: string }> = {
  slack: { env: 'SLACK_EXPORT', stamp: 'data/raw/slack/export/channels.json' },
};

const window = loadWindow();
const WEEK = `${BUCKET}/${weekId(window)}`;

interface Marker {
  source: string;
  raw: boolean;
  json: boolean;
  at: string;
  shape?: number;
  end?: number;
  input?: string;
}

function stamped(source: string): string | undefined {
  const stamp = INPUTS[source]?.stamp;
  if (!stamp || !fs.existsSync(stamp)) return undefined;
  const saved = JSON.parse(fs.readFileSync(stamp, 'utf8'));
  return saved.start === window.start && saved.end === window.end ? saved.input : undefined;
}

type Say = (text: string) => void;

const children = new Set<ChildProcess>();

function track(child: ChildProcess) {
  children.add(child);
  child.on('close', () => children.delete(child));
  return child;
}

function storage(args: string[], input = '') {
  return new Promise<string>((resolve, reject) => {
    const child = track(
      execFile('gcloud', ['storage', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
      ),
    );
    child.stdin?.end(input);
  });
}

const missing = (err: unknown) =>
  /matched no objects|did not find existing container/i.test(String((err as { stderr?: unknown })?.stderr ?? ''));

const reason = (err: unknown) =>
  String((err as { stderr?: unknown })?.stderr || (err instanceof Error ? err.message : err))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

async function saved() {
  if (!BUCKET) return new Map<string, Marker>();
  try {
    const lines = (await storage(['cat', `${WEEK}/*/done.json`])).split('\n').filter(Boolean);
    return new Map(lines.map((line) => JSON.parse(line) as Marker).map((m) => [m.source, m]));
  } catch (err) {
    if (missing(err)) return new Map<string, Marker>();
    throw err;
  }
}

async function restoreRaw(source: string) {
  fs.mkdirSync(`data/raw/${source}`, { recursive: true });
  await storage(['rsync', '-r', '--delete-unmatched-destination-objects', `${WEEK}/${source}/raw`, `data/raw/${source}`]);
}

async function restore(marker: Marker) {
  if (marker.raw) await restoreRaw(marker.source);
  if (marker.json) {
    fs.mkdirSync('data/sources', { recursive: true });
    await storage(['cp', `${WEEK}/${marker.source}/source.json`, `data/sources/${marker.source}.json`]);
  }
}

async function resume(source: string, say: Say) {
  if (!BUCKET || fs.existsSync(`data/raw/${source}`)) return;
  try {
    await restoreRaw(source);
    say(`resuming from the partial pull in ${WEEK}/${source}`);
  } catch (err) {
    fs.rmSync(`data/raw/${source}`, { recursive: true, force: true });
    if (!missing(err)) throw err;
  }
}

async function save(source: string, complete: boolean) {
  if (!BUCKET) return;
  const raw = fs.existsSync(`data/raw/${source}`);
  const json = fs.existsSync(`data/sources/${source}.json`);
  if (raw) await storage(['rsync', '-r', '--delete-unmatched-destination-objects', `data/raw/${source}`, `${WEEK}/${source}/raw`]);
  if (!complete) return;
  if (json) await storage(['cp', `data/sources/${source}.json`, `${WEEK}/${source}/source.json`]);
  const marker: Marker = { source, raw, json, at: new Date().toISOString(), shape: SHAPES[source] ?? 1, end: window.end, input: stamped(source) };
  await storage(['cp', '-', `${WEEK}/${source}/done.json`], `${JSON.stringify(marker)}\n`);
}

function relay(stream: Readable, say: Say) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) say(part);
  });
  stream.on('end', () => {
    if (rest) say(rest);
  });
}

function run(step: string, say: Say) {
  return new Promise<number>((resolve) => {
    const child = track(spawn('npm', ['run', '--silent', step], { stdio: ['ignore', 'pipe', 'pipe'] }));
    relay(child.stdout as Readable, say);
    relay(child.stderr as Readable, say);
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function pull(step: string, done: Map<string, Marker>) {
  const source = step.replace('pull:', '');
  const say: Say = (text) => console.log(`[${source}] ${text}`);
  const started = Date.now();
  const result = (status: string) => ({ step, status, seconds: Math.round((Date.now() - started) / 1000) });
  if (ALWAYS.has(source)) return result((await run(step, say)) === 0 ? 'ok' : 'failed');
  const marker = done.get(source);
  if (marker) {
    await restore(marker);
    say(`already in ${WEEK}/${source} since ${marker.at}, not pulled again`);
    return result('already saved');
  }
  await resume(source, say);
  const code = await run(step, say);
  const ok = code === 0;
  const status = ok ? 'ok' : code === PARTIAL ? 'ok, part of it skipped and pulled again next time' : 'failed';
  try {
    await save(source, ok);
  } catch (err) {
    say(`not saved to ${WEEK}/${source}: ${reason(err)}`);
    return result(ok ? 'ok, not saved to the bucket' : status);
  }
  return result(status);
}

async function main() {
  const started = Date.now();
  const done = await saved();
  const lanes = await Promise.all(
    LANES.map(async (lane) => {
      const out = [];
      for (const step of lane) out.push(await pull(step, done));
      return out;
    }),
  );
  const results = lanes.flat();
  for (const step of AFTER) results.push(await pull(step, done));
  console.log('');
  for (const { step, status, seconds } of results) console.log(`${step.padEnd(20)}${`${seconds}s`.padStart(6)}  ${status}`);
  console.log(`${'total'.padEnd(20)}${`${Math.round((Date.now() - started) / 1000)}s`.padStart(6)}`);
  if (results.some((r) => r.status === 'failed')) process.exit(1);
}

main().catch((err) => {
  for (const child of children) child.kill();
  console.error(`Stopped: ${reason(err)}`);
  process.exit(1);
});
