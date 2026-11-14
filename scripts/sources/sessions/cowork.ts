import path from 'node:path';
import type { SourceSession, Window } from '../../../src/schema';
import { config } from '../../lib/config';
import {
  RAW,
  Skip,
  emailActor,
  failure,
  gcloud,
  iso,
  openState,
  pagesIn,
  parseTime,
  readPage,
  savePage,
  saveState,
  sleep,
  toSession,
  type Collected,
  type SkillUse,
} from './shared';

const DIR = path.join(RAW, 'cowork');
const LIMIT = 1000;
const PAUSE = 1000;
const TOKEN_LABELS = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'] as const;
const UNUSED_LABELS = ['skill.source', 'invocation_trigger', 'plugin.name', 'model', 'cost_usd_micros', 'cowork.surface'] as const;
const HIDDEN = 'custom_skill';

interface Entry {
  id: string;
  t: string;
  session: string;
  email: string;
  tokens: number[] | null;
  event?: string;
  skill?: string;
  prompt?: string;
  seq?: number;
  unused?: Record<string, string>;
}

interface Page {
  cursor: string;
  atCursor: string[];
  more: boolean;
  entries: Entry[];
}

interface LogEntry {
  insertId: string;
  timestamp: string;
  labels?: Record<string, string>;
}

function strip(entry: LogEntry): Entry {
  const labels = entry.labels ?? {};
  const hasTokens = TOKEN_LABELS.some((label) => labels[label] !== undefined && labels[label] !== '');
  const out: Entry = {
    id: entry.insertId,
    t: entry.timestamp,
    session: labels['session.id'] ?? '',
    email: (labels['user.email'] ?? '').trim().toLowerCase(),
    tokens: hasTokens ? TOKEN_LABELS.map((label) => Math.trunc(Number(labels[label]) || 0)) : null,
  };
  if (labels['skill.name']) {
    out.event = labels['event.name'] ?? '';
    out.skill = labels['skill.name'];
    out.prompt = labels['prompt.id'] ?? '';
    out.seq = Number(labels['event.sequence']) || 0;
    out.unused = Object.fromEntries(UNUSED_LABELS.filter((label) => labels[label]).map((label) => [label, labels[label]]));
  }
  return out;
}

async function read(filter: string, project: string): Promise<LogEntry[]> {
  for (;;) {
    try {
      const out = gcloud([
        'logging',
        'read',
        filter,
        `--project=${project}`,
        '--order=asc',
        `--limit=${LIMIT}`,
        '--format=json',
      ]);
      return JSON.parse(out || '[]');
    } catch (err) {
      const text = failure(err);
      if (!/RESOURCE_EXHAUSTED|\b429\b|quota exceeded/i.test(text)) throw new Error(`gcloud logging read failed: ${text}`);
      const wait = Number(/retry[- ]?(?:after|delay)\D{0,12}(\d+)/i.exec(text)?.[1]) || 60;
      console.log(`cowork: Cloud Logging read quota reached, waiting ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

async function pull(window: Window) {
  const state = openState(DIR, window);
  if (state.complete) return;
  const project = config.sessions.gcpProject;
  if (!project) throw new Skip('sessions.gcpProject is not set in rts.config.json');
  saveState(DIR, state);
  const saved = pagesIn(DIR);
  let count = saved.length;
  let cursor = iso(window.start);
  let atCursor: string[] = [];
  let more = true;
  if (count) ({ cursor, atCursor, more } = readPage<Page>(saved[count - 1]));
  const end = iso(window.end);
  while (more) {
    const raw = await read(`labels."service.name"="cowork" AND timestamp>="${cursor}" AND timestamp<"${end}"`, project);
    const seen = new Set(atCursor);
    const fresh = raw.filter((e) => !(e.timestamp === cursor && seen.has(e.insertId)));
    if (raw.length === LIMIT && !fresh.length) {
      throw new Error(`more than ${LIMIT} cowork log entries share the timestamp ${cursor}`);
    }
    const last = raw.length ? raw[raw.length - 1].timestamp : cursor;
    const ids = raw.filter((e) => e.timestamp === last).map((e) => e.insertId);
    atCursor = last === cursor ? [...new Set([...atCursor, ...ids])] : ids;
    cursor = last;
    more = raw.length === LIMIT;
    count++;
    savePage(DIR, count, { cursor, atCursor, more, entries: fresh.map(strip) } satisfies Page);
    console.log(`cowork page ${count}: ${fresh.length} events · up to ${cursor}`);
    if (more) await sleep(PAUSE);
  }
  state.complete = true;
  saveState(DIR, state);
}

export async function collectCowork(window: Window): Promise<Collected> {
  await pull(window);
  const bySession = new Map<string, { email: string; times: number[]; tokens: number | null }>();
  const named = new Map<string, (Entry & { at: number })[]>();
  for (const file of pagesIn(DIR)) {
    for (const entry of readPage<Page>(file).entries) {
      const t = parseTime(entry.t);
      if (!entry.session || !Number.isFinite(t) || t < window.start || t >= window.end) continue;
      let session = bySession.get(entry.session);
      if (!session) bySession.set(entry.session, (session = { email: '', times: [], tokens: null }));
      if (!session.email && entry.email) session.email = entry.email;
      session.times.push(t);
      if (entry.tokens) session.tokens = (session.tokens ?? 0) + entry.tokens[0] + entry.tokens[1] + entry.tokens[2];
      if (entry.skill) {
        if (!named.has(entry.session)) named.set(entry.session, []);
        named.get(entry.session)!.push({ ...entry, at: t });
      }
    }
  }
  const uses: SkillUse[] = [];
  for (const [id, list] of named) {
    const email = bySession.get(id)!.email;
    if (!email) continue;
    list.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
    list.forEach((entry, i) => {
      if (entry.event !== 'skill_activated') return;
      let skill = entry.skill!;
      if (skill === HIDDEN) {
        const later = list.slice(i + 1).filter((e) => e.event === 'api_request');
        skill = (later.find((e) => e.prompt === entry.prompt) ?? later[0])?.skill ?? HIDDEN;
      }
      uses.push({ t: entry.at, email, session: `cowork:${id}`, skill });
    });
  }
  const sessions: SourceSession[] = [];
  const emails = new Set<string>();
  let noEmail = 0;
  for (const [id, session] of bySession) {
    if (!session.email) {
      noEmail++;
      continue;
    }
    emails.add(session.email);
    sessions.push(
      toSession(`cowork:${id}`, `sessions:email:${session.email}`, 'cowork', session.times.sort((a, b) => a - b), session.tokens),
    );
  }
  if (noEmail) console.log(`cowork: ${noEmail} sessions carry no user email and were left out`);
  return { sessions, actors: [...emails].map(emailActor), uses };
}
