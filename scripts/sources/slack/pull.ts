import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../../src/schema';
import { secret } from '../../lib/config';
import { describeWindow } from '../../lib/window';

export const RAW = path.resolve('data/raw/slack');
const STATE_FILE = path.join(RAW, 'state.json');
const AUTH_FILE = path.join(RAW, 'auth.json');
const SECRETS = ['SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN_2'].filter((name, index) => !index || process.env[name]?.trim());
export const LOOKBACK = 14 * 86_400_000;
const PAGE = 200;
const SPACING = 1500;
const SHAPE = 2;

const MESSAGE_KEYS = [
  'ts',
  'thread_ts',
  'user',
  'bot_id',
  'subtype',
  'team',
  'user_team',
  'reply_count',
  'latest_reply',
] as const;
const CHANNEL_KEYS = [
  'id',
  'created',
  'is_private',
  'is_member',
  'is_archived',
  'is_shared',
  'is_ext_shared',
  'is_org_shared',
  'context_team_id',
  'shared_team_ids',
  'num_members',
] as const;
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g;
const MESSAGE_SUBTYPES = new Set<string | undefined>([undefined, 'thread_broadcast', 'file_share', 'bot_message']);
const NO_ACCESS = new Set(['not_in_channel', 'missing_scope']);

export interface RawMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  team?: string;
  user_team?: string;
  reply_count?: number;
  latest_reply?: string;
  mentions: string[];
  links?: string[];
  files?: RawFile[];
}

export interface RawFile {
  id: string;
  name: string;
  mimetype: string;
  created: number;
  user: string | null;
}

export interface Channel {
  id: string;
  tokens: number[];
}

interface State {
  start: number;
  end: number;
  complete: boolean;
  shape?: number;
}

type Params = Record<string, string | number | boolean>;

export class SlackError extends Error {
  constructor(
    public method: string,
    public code: string,
  ) {
    super(`Slack ${method}: ${code}`);
  }
}

export const toMs = (ts: string) => Math.round(Number(ts) * 1000);
export const isMessage = (m: RawMessage) => MESSAGE_SUBTYPES.has(m.subtype) && !!(m.bot_id || m.user);
export const isTopLevel = (m: RawMessage) => !m.thread_ts || m.thread_ts === m.ts;

export function stripMessage(m: any): RawMessage {
  const out: any = {};
  for (const key of MESSAGE_KEYS) if (m[key] !== undefined) out[key] = m[key];
  const text = typeof m.text === 'string' ? m.text : '';
  out.mentions = [...new Set([...text.matchAll(MENTION)].map((match) => match[1]))];
  const links = [...text.matchAll(LINK)].map((match) => match[1].replace(/&amp;/g, '&'));
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) for (const link of [a?.from_url, a?.original_url]) if (typeof link === 'string') links.push(link);
  if (links.length) out.links = [...new Set(links)];
  const files = (Array.isArray(m.files) ? m.files : [])
    .filter((f: any) => typeof f?.id === 'string' && typeof f.mimetype === 'string')
    .map((f: any): RawFile => ({ id: f.id, name: String(f.name ?? ''), mimetype: f.mimetype, created: Number(f.created) || 0, user: typeof f.user === 'string' ? f.user : null }));
  if (files.length) out.files = files;
  return out;
}

function stripChannel(c: any) {
  const out: any = {};
  for (const key of CHANNEL_KEYS) if (c[key] !== undefined) out[key] = c[key];
  return out;
}

const tokens: (string | null)[] = SECRETS.map(() => null);
let requests = 0;
let lastCall = 0;

function token(index: number) {
  tokens[index] ??= secret(SECRETS[index]);
  return tokens[index]!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method: string, tokenIndex: number, params: Params) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const auth = token(tokenIndex);
  for (;;) {
    const wait = lastCall + SPACING - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(`https://slack.com/api/${method}?${query}`, { headers: { Authorization: `Bearer ${auth}` } });
    requests++;
    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const seconds = Number(header);
      if (header === null || !Number.isFinite(seconds)) throw new Error(`Slack ${method}: HTTP 429 without Retry-After`);
      console.log(`${method}: rate limited, waiting ${seconds}s`);
      await sleep(seconds * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new SlackError(method, String(body.error));
    return body;
  }
}

export function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function saveJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export const readPage = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function pageThrough(opts: {
  dir: string;
  method: string;
  token: number;
  params: Params;
  strip: (body: any) => Record<string, unknown>;
}) {
  const saved = pagesIn(opts.dir);
  let count = saved.length;
  let cursor: string = count ? readPage(saved[count - 1]).next_cursor : '';
  while (!count || cursor) {
    const body = await call(opts.method, opts.token, { ...opts.params, limit: PAGE, ...(cursor ? { cursor } : {}) });
    cursor = body.response_metadata?.next_cursor ?? '';
    count++;
    saveJson(path.join(opts.dir, `${String(count).padStart(5, '0')}.json`), { ...opts.strip(body), next_cursor: cursor });
  }
  return count;
}

export function readChannels(): Channel[] {
  const channels = new Map<string, Channel>();
  SECRETS.forEach((_, index) => {
    for (const file of pagesIn(path.join(RAW, 'channels', String(index)))) {
      for (const c of readPage(file).channels) {
        if (!channels.has(c.id)) channels.set(c.id, { id: c.id, tokens: [] });
        if (c.is_member !== false) channels.get(c.id)!.tokens.push(index);
      }
    }
  });
  return [...channels.values()];
}

export const readTeamId = (): string => readPage(AUTH_FILE).team_id;

const unreadableFile = (channel: string) => path.join(RAW, 'history', channel, 'unreadable.json');

async function pullHistory(channel: Channel, params: Params) {
  const dir = path.join(RAW, 'history', channel.id);
  if (fs.existsSync(unreadableFile(channel.id))) return null;
  const saved = pagesIn(dir);
  const order: number[] = saved.length ? [readPage(saved[0]).token] : channel.tokens;
  const errors: string[] = [];
  for (const index of order) {
    try {
      await pageThrough({
        dir,
        method: 'conversations.history',
        token: index,
        params,
        strip: (body) => ({ token: index, messages: body.messages.map(stripMessage) }),
      });
      return index;
    } catch (err) {
      if (!(err instanceof SlackError && NO_ACCESS.has(err.code)) || pagesIn(dir).length) throw err;
      errors.push(err.code);
    }
  }
  if (order.length) saveJson(unreadableFile(channel.id), { tried: order, errors });
  return null;
}

function saveState(state: State) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export const requestCount = () => requests;

export async function pull(window: Window) {
  const old: State | null = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
  if (old && old.shape !== SHAPE && old.start === window.start && old.end === window.end) {
    console.log('data/raw/slack was pulled before messages kept their links and files. Pulling the messages again.');
    for (const name of ['history', 'replies', 'state.json']) fs.rmSync(path.join(RAW, name), { recursive: true, force: true });
  }
  const resumed = fs.existsSync(STATE_FILE);
  const state: State = resumed
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { start: window.start, end: window.end, complete: false, shape: SHAPE };
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error(
      'data/raw/slack was pulled for a different window than data/window.json. Remove data/raw/slack to pull this window.',
    );
  }
  if (!resumed) saveState(state);
  console.log(`Window ${describeWindow(window)}${resumed ? ' (resuming data/raw/slack)' : ''}`);
  if (state.complete) {
    console.log('This window is already fully pulled. Remove data/window.json and data/raw to pull a new week.');
    return;
  }

  if (!fs.existsSync(AUTH_FILE)) {
    const body = await call('auth.test', 0, {});
    saveJson(AUTH_FILE, { team_id: body.team_id });
  }

  for (let index = 0; index < SECRETS.length; index++) {
    const pages = await pageThrough({
      dir: path.join(RAW, 'channels', String(index)),
      method: 'conversations.list',
      token: index,
      params: { types: 'public_channel,private_channel', exclude_archived: true },
      strip: (body) => ({ channels: body.channels.map(stripChannel) }),
    });
    console.log(`channels, bot ${index + 1}: ${pages} pages`);
  }

  const channels = readChannels();
  const oldest = ((window.start - LOOKBACK) / 1000).toFixed(6);
  const latest = (window.end / 1000).toFixed(6);
  let threads = 0;
  for (const [i, channel] of channels.entries()) {
    const index = await pullHistory(channel, { channel: channel.id, oldest, latest, inclusive: true });
    if (index === null) continue;
    let messages = 0;
    let fetched = 0;
    for (const file of pagesIn(path.join(RAW, 'history', channel.id))) {
      for (const m of readPage(file).messages as RawMessage[]) {
        messages++;
        if (!isTopLevel(m) || !isMessage(m) || !m.reply_count || !m.latest_reply) continue;
        if (toMs(m.latest_reply) < window.start) continue;
        await pageThrough({
          dir: path.join(RAW, 'replies', channel.id, m.ts),
          method: 'conversations.replies',
          token: index,
          params: { channel: channel.id, ts: m.ts, latest, inclusive: true },
          strip: (body) => ({ messages: body.messages.map(stripMessage) }),
        });
        fetched++;
      }
    }
    threads += fetched;
    console.log(`channel ${i + 1}/${channels.length} ${channel.id}: ${messages} messages, ${fetched} threads with replies`);
  }

  state.complete = true;
  saveState(state);
  console.log(`Pull complete: ${channels.length} channels, ${threads} threads with replies, ${requests} API requests this run.`);
}
