import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../../src/schema';
import { secret } from '../../lib/config';
import { describeWindow } from '../../lib/window';

export const RAW = path.resolve('data/raw/notion');
const STATE_FILE = path.join(RAW, 'state.json');
const SEARCH_DIR = path.join(RAW, 'search');
const USERS_DIR = path.join(RAW, 'users');
const COMMENTS_DIR = path.join(RAW, 'comments');
const BLOCKS_DIR = path.join(RAW, 'blocks');
const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const PAGE_SIZE = 100;

export const OWNER_NAMES = ['owner', 'assignee', 'assigned', 'assigned to', 'dri', 'lead'];

export interface RawUser {
  id: string;
  type: string | null;
  name: string | null;
  email: string | null;
}

export interface RawPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  created_by: string | null;
  last_edited_by: string | null;
  archived: boolean;
  parent: { type: string; id: string | null } | null;
  people: { name: string | null; ids: string[] }[];
}

export interface RawComment {
  id: string;
  discussion_id: string | null;
  created_time: string;
  last_edited_time: string | null;
  created_by: string | null;
  mentions: string[];
  text?: string;
  links?: string[];
}

export interface RawBlock {
  id: string;
  created_time: string;
  created_by: string | null;
  last_edited_time: string;
  last_edited_by: string | null;
}

export interface RawList<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

interface State {
  start: number;
  end: number;
  complete: boolean;
  shape?: number;
}

const SHAPE = 2;

let apiToken: string | null = null;
let requests = 0;

function token() {
  apiToken ??= secret('NOTION_API_KEY');
  return apiToken;
}

function errorOf(text: string) {
  try {
    const body = JSON.parse(text);
    return `${body.code}: ${body.message}`;
  } catch {
    return text.slice(0, 300);
  }
}

async function call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
  for (;;) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Notion-Version': VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    requests++;
    if (res.status === 429) {
      const header = res.headers.get('retry-after');
      const wait = Number(header);
      if (header === null || !Number.isFinite(wait) || wait < 0) {
        throw new Error('Notion HTTP 429 without a usable Retry-After.');
      }
      console.log(`rate limited: waiting ${wait}s as the server asked`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Notion HTTP ${res.status} on ${method} ${route.split('?')[0]}: ${errorOf(text)}`);
    return JSON.parse(text);
  }
}

const idOf = (ref: any): string | null => (ref && typeof ref.id === 'string' ? ref.id : null);
const isId = (id: string | null): id is string => !!id;

function ownerName(name: string): string | null {
  const plain = name.trim().toLowerCase();
  return OWNER_NAMES.includes(plain) ? plain : null;
}

function stripUser(u: any): RawUser {
  return {
    id: u.id,
    type: typeof u.type === 'string' ? u.type : null,
    name: typeof u.name === 'string' ? u.name : null,
    email: typeof u.person?.email === 'string' ? u.person.email : null,
  };
}

function stripPage(p: any): RawPage {
  const parentId = p.parent ? p.parent[p.parent.type] : null;
  return {
    id: p.id,
    created_time: p.created_time,
    last_edited_time: p.last_edited_time,
    created_by: idOf(p.created_by),
    last_edited_by: idOf(p.last_edited_by),
    archived: !!(p.archived || p.in_trash),
    parent: p.parent ? { type: p.parent.type, id: typeof parentId === 'string' ? parentId : null } : null,
    people: Object.entries(p.properties ?? {})
      .filter(([, value]) => (value as any)?.type === 'people')
      .map(([name, value]) => ({ name: ownerName(name), ids: ((value as any).people ?? []).map(idOf).filter(isId) })),
  };
}

function stripComment(c: any): RawComment {
  return {
    id: c.id,
    discussion_id: typeof c.discussion_id === 'string' ? c.discussion_id : null,
    created_time: c.created_time,
    last_edited_time: typeof c.last_edited_time === 'string' ? c.last_edited_time : null,
    created_by: idOf(c.created_by),
    mentions: (c.rich_text ?? [])
      .filter((part: any) => part?.type === 'mention' && part.mention?.type === 'user')
      .map((part: any) => idOf(part.mention.user))
      .filter(isId),
    text: (c.rich_text ?? []).map((part: any) => (typeof part?.plain_text === 'string' ? part.plain_text : '')).join(''),
    links: [...new Set<string>((c.rich_text ?? []).map((part: any) => part?.href).filter((href: unknown) => typeof href === 'string'))],
  };
}

function stripBlock(b: any): RawBlock {
  return {
    id: b.id,
    created_time: b.created_time,
    created_by: idOf(b.created_by),
    last_edited_time: b.last_edited_time,
    last_edited_by: idOf(b.last_edited_by),
  };
}

function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function savePage(dir: string, n: number, page: RawList<unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(n).padStart(5, '0')}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(page));
  fs.renameSync(tmp, file);
}

const readPage = <T>(file: string): RawList<T> => JSON.parse(fs.readFileSync(file, 'utf8'));
const readAll = <T>(dir: string): T[] => pagesIn(dir).flatMap((file) => readPage<T>(file).results);
const hasNext = (page: RawList<unknown>) => page.has_more && !!page.next_cursor;

async function pageThrough<T>(opts: {
  dir: string;
  label: string | null;
  fetchPage: (cursor: string | null) => Promise<any>;
  strip: (row: any) => T;
  more: (page: RawList<T>) => boolean;
}) {
  const saved = pagesIn(opts.dir);
  let count = saved.length;
  let last: RawList<T> | null = count ? readPage<T>(saved[count - 1]) : null;
  while (!last || opts.more(last)) {
    const body = await opts.fetchPage(last?.next_cursor ?? null);
    last = {
      results: (body.results ?? []).map(opts.strip),
      has_more: !!body.has_more,
      next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
    };
    count++;
    savePage(opts.dir, count, last);
    if (opts.label) console.log(`${opts.label} page ${count}: ${last.results.length} rows`);
  }
}

function saveState(state: State) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export const requestCount = () => requests;

export function pageInWindow(page: RawPage, window: Window) {
  const inside = (iso: string) => {
    const t = Date.parse(iso);
    return t >= window.start && t <= window.end;
  };
  return inside(page.created_time) || inside(page.last_edited_time);
}

export function readRaw() {
  const seen = new Set<string>();
  const pages = readAll<RawPage>(SEARCH_DIR).filter((page) => !seen.has(page.id) && !!seen.add(page.id));
  const comments = new Map<string, RawComment[]>();
  const blocks = new Map<string, RawBlock[]>();
  for (const page of pages) {
    const dir = path.join(COMMENTS_DIR, page.id);
    if (fs.existsSync(dir)) comments.set(page.id, readAll<RawComment>(dir));
    const held = path.join(BLOCKS_DIR, page.id);
    if (fs.existsSync(held)) blocks.set(page.id, readAll<RawBlock>(held));
  }
  return { users: readAll<RawUser>(USERS_DIR), pages, comments, blocks };
}

export async function pull(window: Window) {
  const resumed = fs.existsSync(STATE_FILE);
  const state: State = resumed
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { start: window.start, end: window.end, complete: false, shape: SHAPE };
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error(
      'data/raw/notion was pulled for a different window than data/window.json. Remove data/raw/notion to pull this window.',
    );
  }
  if (state.shape !== SHAPE) {
    console.log('data/raw/notion was pulled before comments kept their text and links. Pulling the comments that exist again.');
    for (const id of fs.existsSync(COMMENTS_DIR) ? fs.readdirSync(COMMENTS_DIR) : []) {
      if (readAll<RawComment>(path.join(COMMENTS_DIR, id)).length) fs.rmSync(path.join(COMMENTS_DIR, id), { recursive: true, force: true });
    }
    Object.assign(state, { complete: false, shape: SHAPE });
  }
  saveState(state);
  console.log(`Window ${describeWindow(window)}${resumed ? ' (resuming data/raw/notion)' : ''}`);
  if (state.complete) {
    console.log('This window is already fully pulled. Remove data/window.json and data/raw to pull a new week.');
    return;
  }

  const cursorQuery = (cursor: string | null) => (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');

  await pageThrough<RawUser>({
    dir: USERS_DIR,
    label: 'users',
    fetchPage: (cursor) => call('GET', `/users?page_size=${PAGE_SIZE}${cursorQuery(cursor)}`),
    strip: stripUser,
    more: hasNext,
  });

  await pageThrough<RawPage>({
    dir: SEARCH_DIR,
    label: 'pages',
    fetchPage: (cursor) =>
      call('POST', '/search', {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    strip: stripPage,
    more: (page) =>
      hasNext(page) &&
      page.results.length > 0 &&
      Date.parse(page.results[page.results.length - 1].last_edited_time) >= window.start,
  });

  const pages = readRaw().pages.filter((page) => pageInWindow(page, window));
  let done = 0;
  for (const page of pages) {
    await pageThrough<RawComment>({
      dir: path.join(COMMENTS_DIR, page.id),
      label: null,
      fetchPage: (cursor) =>
        call('GET', `/comments?block_id=${encodeURIComponent(page.id)}&page_size=${PAGE_SIZE}${cursorQuery(cursor)}`),
      strip: stripComment,
      more: hasNext,
    });
    await pageThrough<RawBlock>({
      dir: path.join(BLOCKS_DIR, page.id),
      label: null,
      fetchPage: (cursor) =>
        call('GET', `/blocks/${encodeURIComponent(page.id)}/children?page_size=${PAGE_SIZE}${cursorQuery(cursor)}`).catch((err) => {
          if (err instanceof Error && err.message.includes('HTTP 404')) return { results: [], has_more: false, next_cursor: null };
          throw err;
        }),
      strip: stripBlock,
      more: hasNext,
    });
    done++;
    if (done % 100 === 0 || done === pages.length) {
      console.log(`comments and blocks: ${done} of ${pages.length} pages · ${requests} API requests this run`);
    }
  }

  state.complete = true;
  saveState(state);
  console.log(`Pull complete: ${pages.length} pages in window, ${requests} API requests this run.`);
}
