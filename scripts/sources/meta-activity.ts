import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../src/schema';
import { secret } from '../lib/config';
import { describeWindow, loadWindow } from '../lib/window';
import { writeMetaSource } from './ads/meta';
import { accountsOf, type Account } from './ads/shared';
import { openState, pagesIn, readPage, savePage, saveState, writeJson } from './sessions/shared';

const RAW = path.resolve('data/raw/meta-activity');
const OUT = path.resolve('data/sources/meta-activity.json');
const VERSION = 'v26.0';
const LIMIT = Number(process.env.META_LIMIT) || 100;
const CEILING = 50;
const SLICE = (Number(process.env.META_SLICE_DAYS) || 1) * 86_400_000;
const STREAMS = 2;
const PAUSE = Number(process.env.META_PAUSE_MS) || 0;
const [PART, PARTS] = (process.env.META_PART ?? `-1/${STREAMS}`).split('/').map(Number);
const FIELDS =
  'actor_id,actor_name,application_id,application_name,date_time_in_timezone,event_time,event_type,extra_data,object_id,object_name,object_type,translated_event_type';
const USAGE_HEADERS = ['x-business-use-case-usage', 'x-ad-account-usage', 'x-app-usage'];

interface Call {
  page: number;
  at: number;
  ms: number;
  rows: number;
  pct: number;
  usage: Record<string, unknown>;
}

let requests = 0;

const callsOf = (dir: string): Call[] => (fs.existsSync(path.join(dir, 'calls.json')) ? readPage<Call[]>(path.join(dir, 'calls.json')) : []);

function busiest(usage: Record<string, unknown>) {
  let pct = 0;
  const buc = usage['x-business-use-case-usage'];
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        pct = Math.max(pct, Number(entry?.call_count) || 0, Number(entry?.total_cputime) || 0, Number(entry?.total_time) || 0);
      }
    }
  }
  return pct;
}

async function pullAccount(window: Window, account: Account, token: string) {
  const dir = path.join(RAW, account.account);
  const state = openState(dir, window);
  if (state.complete) return;
  const calls = callsOf(dir);
  let page = pagesIn(dir).length;
  const seen = new Set(pagesIn(dir).flatMap((file) => readPage<unknown[]>(file).map((row) => JSON.stringify(row))));
  let from = typeof state.from === 'number' ? state.from : window.start;
  let url: string | null = typeof state.next === 'string' ? state.next : null;
  const whole = url !== null && typeof state.from !== 'number';
  if (url) {
    const saved = new URL(url);
    saved.searchParams.set('limit', String(LIMIT));
    url = saved.toString();
  }
  while (from < window.end) {
    const to = whole ? window.end : Math.min(from + SLICE, window.end);
    url ??= `https://graph.facebook.com/${VERSION}/act_${account.account}/activities?${new URLSearchParams({
      fields: FIELDS,
      since: String(Math.floor(from / 1000)),
      until: String(Math.floor(to / 1000)),
      limit: String(LIMIT),
    })}`;
    while (url) {
      if (PAUSE) await new Promise((done) => setTimeout(done, PAUSE));
      requests++;
      const at = Date.now();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      const usage: Record<string, unknown> = {};
      for (const name of USAGE_HEADERS) {
        const value = res.headers.get(name);
        if (!value) continue;
        try {
          usage[name] = JSON.parse(value);
        } catch {
          usage[name] = value;
        }
      }
      if (body.error?.code === 200) {
        saveState(dir, { ...state, complete: true, denied: String(body.error.message ?? '') });
        console.log(`${account.name} act_${account.account}: no permission to read this ad account, skipped`);
        return;
      }
      if (!res.ok || !Array.isArray(body.data)) {
        throw new Error(`Meta activities for ${account.name} act_${account.account}: HTTP ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
      }
      page++;
      const rows = body.data.filter((row: unknown) => !seen.has(JSON.stringify(row)));
      for (const row of rows) seen.add(JSON.stringify(row));
      savePage(dir, page, rows);
      const pct = busiest(usage);
      calls.push({ page, at, ms: Date.now() - at, rows: rows.length, pct, usage });
      writeJson(path.join(dir, 'calls.json'), calls);
      url = null;
      if (typeof body.paging?.next === 'string') {
        const next = new URL(body.paging.next);
        next.searchParams.delete('access_token');
        url = next.toString();
      }
      saveState(dir, { ...state, from, next: url, complete: false });
      console.log(`${account.name} act_${account.account} page ${page}: ${rows.length} rows, quota ${pct}%`);
      if (url && pct >= CEILING) throw new Error(`Meta quota for ${account.name} act_${account.account} is at ${pct}%, at or above the ${CEILING}% ceiling`);
    }
    from = to;
    saveState(dir, { ...state, from, next: null, complete: from >= window.end });
  }
}

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const list = accountsOf('metaAccounts');
  const token = secret('META_ACCESS_TOKEN');
  const ids = [...new Set(list.map((a) => a.account))].sort();
  const stream = async (part: number) => {
    for (const account of list) if (ids.indexOf(account.account) % PARTS === part) await pullAccount(window, account, token);
  };
  await Promise.all(PART >= 0 ? [stream(PART)] : Array.from({ length: PARTS }, (_, part) => stream(part)));
  console.log('Meta activity source');
  let events = 0;
  let total = 0;
  const owners = new Map<string, string[]>();
  for (const account of list) owners.set(account.account, [...(owners.get(account.account) ?? []), account.name]);
  for (const [id, names] of owners) {
    const calls = callsOf(path.join(RAW, id));
    const rows = calls.reduce((n, c) => n + c.rows, 0);
    events += rows;
    total += calls.length;
    const denied = openState(path.join(RAW, id), window).denied;
    console.log(
      `  ${names.join(', ').padEnd(12)}${`act_${id}`.padEnd(22)}${String(rows).padStart(7)} events${String(calls.length).padStart(5)} calls   ${denied ? 'no permission' : `peak quota ${Math.max(0, ...calls.map((c) => c.pct))}%`}`,
    );
  }
  console.log(`Saved under ${path.relative(process.cwd(), RAW)}: ${events} events from ${owners.size} ad accounts in ${total} calls. ${requests} Meta requests this run.`);
  writeMetaSource(window, RAW, list, OUT);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} Meta requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
