import path from 'node:path';
import type { Window } from '../../src/schema';
import { secret } from '../lib/config';
import { describeWindow, loadWindow, pacificMidnight } from '../lib/window';
import { accountsOf } from './ads/shared';
import { writeTikTokSource } from './ads/tiktok';
import { openState, pagesIn, readPage, savePage, saveState, sleep, type State } from './sessions/shared';

const RAW = path.resolve('data/raw/tiktok-activity');
const OUT = path.resolve('data/sources/tiktok-activity.json');
const CACHE = path.resolve('data/tiktok-activity-cache');
const BASE = 'https://business-api.tiktok.com/open_api/v1.3/changelog/task';
const ZONE = 'Atlantic/Reykjavik';
const GAP = 15_000;
const CHECKS = 8;
const COOL = 60_000;
const DAY = 86_400_000;
const BLOCK_DAYS = 28;
const STUCK = 30 * 60_000;
const THROTTLED = 40100;
const DENIED = 40001;
const CACHED = process.argv.includes('--cached');

interface Reply {
  code?: number;
  message?: string;
  data?: { task_id?: string; status?: string; changelog?: string };
}

class Throttled extends Error {}

let requests = 0;
let last = 0;

async function call(label: string, url: string, token: string, body?: unknown, wait = false): Promise<Reply> {
  const gap = last + GAP - Date.now();
  if (gap > 0) await sleep(gap);
  last = Date.now();
  requests++;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Access-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let reply: Reply;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Error(`TikTok change log for ${label}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (reply.code === THROTTLED && !wait) throw new Throttled(`TikTok throttled the change log for ${label}: ${reply.message}`);
  return reply;
}

const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

const blockAt = (k: number): Window => ({
  start: pacificMidnight(2025, 12, 29 + BLOCK_DAYS * k),
  end: pacificMidnight(2025, 12, 29 + BLOCK_DAYS * (k + 1)),
});

function blocksFor(window: Window) {
  let k = Math.floor((window.start - blockAt(0).start) / (BLOCK_DAYS * DAY));
  while (blockAt(k).start > window.start) k--;
  while (blockAt(k).end <= window.start) k++;
  const list: Window[] = [];
  for (; blockAt(k).start < window.end; k++) list.push(blockAt(k));
  return list;
}

const blockDir = (account: string, block: Window) => path.join(CACHE, account, `${day(block.start)}_${day(block.end)}`);

function csv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function table(changelog: string) {
  const text = String(JSON.parse(changelog).file_data ?? '')
    .replace(/^b'/, '')
    .replace(/'$/, '');
  const all = csv(text);
  const head = all.findIndex((cells) => cells[0] === 'Time');
  if (head < 0) return { header: [] as string[], lines: [] as string[][] };
  return { header: all[head], lines: all.slice(head + 1).filter((cells) => /^\d{4}-\d{2}-\d{2} /.test(cells[0])) };
}

const timeOf = (time: string) => Date.parse(`${time.replace(' ', 'T')}${time.length === 16 ? ':00' : ''}Z`);

async function pullBlock(window: Window, block: Window, label: string, account: string, token: string) {
  const dir = blockDir(account, block);
  const need = Math.min(window.end, block.end);
  let state = openState(dir, block);
  if (state.complete && (state.denied || Number(state.through) >= need)) return true;
  if (CACHED) return false;
  if (state.complete || (typeof state.task === 'string' && (Number(state.through) < need || Date.now() - Number(state.asked) > STUCK))) {
    state = { start: block.start, end: block.end, complete: false };
  }
  const query = new URLSearchParams({ advertiser_id: account });
  if (typeof state.task !== 'string') {
    const asked = Date.now();
    const created = await call(label, `${BASE}/create/`, token, {
      advertiser_id: account,
      start_time: stamp(block.start - DAY),
      end_time: stamp(block.end + DAY - 1000),
      timezone: ZONE,
    });
    if (created.code === DENIED) {
      saveState(dir, { ...state, complete: true, denied: String(created.message ?? '') });
      console.log(`${label}: no permission to read this ad account's change log, skipped`);
      return true;
    }
    if (created.code !== 0 || !created.data?.task_id) throw new Error(`TikTok change log for ${label}: ${JSON.stringify(created).slice(0, 300)}`);
    state = { ...state, task: created.data.task_id, asked, through: Math.min(asked, block.end) };
    saveState(dir, state);
  }
  query.set('task_id', String(state.task));
  let status = '';
  for (let i = 0; i < CHECKS && status !== 'SUCCESS'; i++) {
    const checked = await call(label, `${BASE}/check/?${query}`, token, undefined, true);
    if (checked.code === THROTTLED) {
      await sleep(COOL);
      continue;
    }
    if (checked.code !== 0) throw new Error(`TikTok change log for ${label}: ${JSON.stringify(checked).slice(0, 300)}`);
    status = String(checked.data?.status ?? '');
    if (status === 'FAILED') throw new Error(`TikTok change log for ${label}: the download task failed`);
  }
  if (status !== 'SUCCESS') {
    console.log(`${label} ${day(block.start)} to ${day(block.end)}: TikTok is still preparing the file, left for the next run`);
    return false;
  }
  const got = await call(label, `${BASE}/download/?${query}`, token);
  if (got.code !== 0 || typeof got.data?.changelog !== 'string') throw new Error(`TikTok change log for ${label}: ${JSON.stringify(got).slice(0, 300)}`);
  const rows = table(got.data.changelog).lines.length;
  savePage(dir, 1, got.data);
  saveState(dir, { ...state, complete: true, rows });
  console.log(`${label} ${day(block.start)} to ${day(block.end)}: ${rows} rows cached`);
  return true;
}

function cut(window: Window, state: State, account: string, blocks: Window[]) {
  const dir = path.join(RAW, account);
  const rows: ({ at: number } & Record<string, string | number>)[] = [];
  let denied = '';
  for (const block of blocks) {
    const from = blockDir(account, block);
    const cached = openState(from, block);
    if (cached.denied) {
      denied = String(cached.denied);
      continue;
    }
    const { header, lines } = table(readPage<{ changelog: string }>(path.join(from, '00001.json')).changelog);
    for (const cells of lines) {
      const at = timeOf(cells[0]);
      if (!(at >= Math.max(window.start, block.start) && at < Math.min(window.end, block.end))) continue;
      rows.push({ ...Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])), at });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  if (!denied) savePage(dir, 1, rows);
  saveState(dir, { ...state, complete: true, rows: rows.length, ...(denied ? { denied } : {}) });
  return rows.length;
}

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const list = accountsOf('tiktokAdvertisers');
  const token = CACHED ? '' : secret('TIKTOK_ACCESS_TOKEN');
  const owners = new Map<string, string[]>();
  for (const account of list) owners.set(account.account, [...(owners.get(account.account) ?? []), account.name]);
  const blocks = blocksFor(window);
  let skipped = 0;
  let throttled = '';
  for (const [id, names] of owners) {
    const state = openState(path.join(RAW, id), window);
    if (state.complete) continue;
    const label = `${names.join(', ')} ${id}`;
    try {
      let ready = true;
      for (const block of blocks) if (!(await pullBlock(window, block, label, id, token))) ready = false;
      if (ready) cut(window, state, id, blocks);
      else skipped++;
    } catch (err) {
      if (!(err instanceof Throttled)) throw err;
      throttled = err.message;
      break;
    }
  }
  console.log('TikTok activity source');
  let events = 0;
  let left = 0;
  for (const [id, names] of owners) {
    const state = openState(path.join(RAW, id), window);
    const rows = Number(state.rows) || 0;
    events += rows;
    if (!state.complete) left++;
    console.log(`  ${names.join(', ').padEnd(12)}${id.padEnd(22)}${state.denied ? 'no permission' : state.complete ? `${String(rows).padStart(7)} rows` : 'not pulled yet'}`);
  }
  console.log(
    `Saved under ${path.relative(process.cwd(), RAW)}: ${events} rows this week from ${owners.size} ad accounts, cut from the ${BLOCK_DAYS}-day files in ${path.relative(process.cwd(), CACHE)}. ${requests} TikTok requests this run.`,
  );
  writeTikTokSource(window, RAW, list, OUT);
  if (throttled) console.log(`${throttled}. ${left} ad accounts are left for the next run.`);
  if (throttled || skipped) process.exit(3);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} TikTok requests this run. Saved files are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
