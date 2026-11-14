import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { SourceSession, Window } from '../../../src/schema';
import { RAW, Skip, clampTimes, openState, pagesIn, readPage, savePage, saveState, toSession, type Collected } from './shared';

const DIR = path.join(RAW, 'local');
const CONFIG_DIRS = [...new Set([process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter((d): d is string => !!d).map((d) => path.resolve(d)))];
const PAGE = 200;
const OWNER = 'sessions:local';

interface Transcript {
  id: string;
  parent: string | null;
  events: number[];
  usage: [number, number, string][];
  before: number | null;
  after: number | null;
}

function projectRoots() {
  const roots = new Set<string>();
  for (const dir of CONFIG_DIRS) {
    const projects = path.join(dir, 'projects');
    if (fs.existsSync(projects)) roots.add(fs.realpathSync(projects));
  }
  return [...roots];
}

function ownerEmail(): string | null {
  if (process.env.RTS_OWNER_EMAIL) return process.env.RTS_OWNER_EMAIL.trim().toLowerCase();
  const files = [...CONFIG_DIRS.map((d) => path.join(d, '.claude.json')), path.join(os.homedir(), '.claude.json')];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const email = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.emailAddress;
      if (typeof email === 'string' && email) return email.trim().toLowerCase();
    } catch {
      continue;
    }
  }
  return null;
}

function transcriptFiles(root: string, window: Window) {
  const found: { file: string; id: string; parent: string | null }[] = [];
  const seen = new Set<string>();
  for (const rel of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.jsonl')) continue;
    const stat = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs < window.start) continue;
    const file = fs.realpathSync(path.join(root, rel));
    if (seen.has(file)) continue;
    seen.add(file);
    const parts = file.split(path.sep);
    const base = parts[parts.length - 1].slice(0, -'.jsonl'.length);
    const sub = parts.indexOf('subagents');
    const parent = sub > 0 ? parts[sub - 1] : null;
    found.push({ file, id: parent ? `${parent}:${base}` : base, parent });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

async function scan(file: string, id: string, parent: string | null, window: Window): Promise<Transcript> {
  const out: Transcript = { id, parent, events: [], usage: [], before: null, after: null };
  const seen = new Set<string>();
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"timestamp"')) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t < window.start) {
      if (out.before === null || t > out.before) out.before = t;
      continue;
    }
    if (t >= window.end) {
      if (out.after === null || t < out.after) out.after = t;
      continue;
    }
    out.events.push(t);
    const message = row.message;
    const usage = message?.usage;
    if (row.type !== 'assistant' || !usage || typeof message.id !== 'string' || seen.has(message.id)) continue;
    seen.add(message.id);
    const tokens =
      (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
    out.usage.push([t, tokens, message.id]);
  }
  return out;
}

async function pull(window: Window) {
  const state = openState(DIR, window);
  if (state.complete) return;
  const roots = projectRoots();
  if (!roots.length) throw new Skip('no Claude projects folder on this machine');
  fs.rmSync(DIR, { recursive: true, force: true });
  saveState(DIR, state);
  let page: Transcript[] = [];
  let pages = 0;
  let read = 0;
  const flush = () => {
    if (!page.length) return;
    pages++;
    savePage(DIR, pages, page);
    console.log(`local page ${pages}: ${page.length} transcripts with activity in the window · ${read} files read`);
    page = [];
  };
  for (const root of roots) {
    for (const { file, id, parent } of transcriptFiles(root, window)) {
      const transcript = await scan(file, id, parent, window);
      read++;
      if (!transcript.events.length) continue;
      page.push(transcript);
      if (page.length === PAGE) flush();
    }
  }
  flush();
  state.complete = true;
  saveState(DIR, state);
}

export async function collectLocal(window: Window): Promise<Collected> {
  await pull(window);
  const transcripts = pagesIn(DIR).flatMap((file) => readPage<Transcript[]>(file));
  const ids = new Set(transcripts.map((t) => t.id));
  const counted = new Set<string>();
  const sessions: SourceSession[] = [];
  for (const t of transcripts) {
    let tokens = 0;
    for (const [, count, messageId] of t.usage) {
      if (counted.has(messageId)) continue;
      counted.add(messageId);
      tokens += count;
    }
    const parent = t.parent && ids.has(t.parent) ? `local:${t.parent}` : null;
    sessions.push(
      toSession(`local:${t.id}`, OWNER, 'coding_agent', clampTimes(t.events, t.before, t.after, window), tokens, parent),
    );
  }
  return {
    sessions,
    actors: [{ key: OWNER, email: ownerEmail(), name: null, kind: 'person', groupHint: null, clientHint: null }],
  };
}
