import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_REGION, SCHEMA_VERSION, type ActorRef, type Feature, type SourceEvent, type SourceFile, type Window } from '../../src/schema';
import { config, secret, setting } from '../lib/config';
import { describeWindow, loadWindow } from '../lib/window';

const RAW = path.resolve('data/raw/sentry');
const PAGES = path.join(RAW, 'events');
const STATE = path.join(RAW, 'state.json');
const OUT = path.resolve('data/sources/sentry.json');
const FIELDS = ['timestamp', 'issue.id', 'level', 'transaction', 'url', 'user.email'];
const MINUTE = 60_000;
const ID = /^(\[.*\]|%5b.*|\d+|(?=.*\d)[\w.-]{8,}|[\w-]{32,})$/;
const SYSTEM: ActorRef = { key: 'sentry:system', email: null, name: 'Sentry', kind: 'system', groupHint: null, clientHint: null };

interface State {
  start: number;
  end: number;
  complete: boolean;
}

interface Row {
  t: number;
  issue: string;
  level: string;
  segment: string | null;
  email: string | null;
}

interface Page {
  rows: Row[];
  next: string | null;
}

let token = '';
let requests = 0;

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function openState(window: Window): State {
  if (!fs.existsSync(STATE)) return { start: window.start, end: window.end, complete: false };
  const state: State = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error('data/raw/sentry was pulled for a different window than data/window.json; remove data/raw/sentry to pull this window');
  }
  return state;
}

function pages() {
  if (!fs.existsSync(PAGES)) return [];
  return fs
    .readdirSync(PAGES)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(PAGES, f));
}

const readPage = (file: string): Page => JSON.parse(fs.readFileSync(file, 'utf8'));

function segmentOf(page: unknown) {
  if (typeof page !== 'string' || !page.trim()) return null;
  const parts = page
    .trim()
    .replace(/^[A-Z]+\s+/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/?#]*/i, '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (!parts.length) return 'home';
  return parts.find((part) => !ID.test(part)) ?? 'page-by-id';
}

function strip(row: any): Row {
  const email = row['user.email'];
  return {
    t: Date.parse(row.timestamp),
    issue: String(row['issue.id']),
    level: String(row.level ?? ''),
    segment: segmentOf(row.url) ?? segmentOf(row.transaction),
    email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null,
  };
}

const utc = (t: number) => new Date(t).toISOString().slice(0, 19);

async function fetchPage(window: Window, cursor: string | null): Promise<Page> {
  token ||= secret('SENTRY_AUTH_TOKEN');
  const params = new URLSearchParams([
    ...FIELDS.map((field) => ['field', field]),
    ['dataset', 'errors'],
    ['project', setting(config.sentry.project, 'sentry.project')],
    ['start', utc(window.start)],
    ['end', utc(window.end)],
    ['sort', 'timestamp'],
    ['per_page', '100'],
    ...(cursor ? [['cursor', cursor]] : []),
  ]);
  requests++;
  const res = await fetch(`${config.sentry.api}/organizations/${setting(config.sentry.org, 'sentry.org')}/events/?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sentry HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
  const body = await res.json();
  const next = /rel="next"; results="true"; cursor="([^"]+)"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  return { rows: (body.data ?? []).map(strip), next };
}

async function pull(window: Window) {
  const state = openState(window);
  if (state.complete) return;
  writeJson(STATE, state);
  const saved = pages();
  let n = saved.length;
  let last = n ? readPage(saved[n - 1]) : null;
  while (!last || last.next) {
    last = await fetchPage(window, last?.next ?? null);
    writeJson(path.join(PAGES, `${String(++n).padStart(5, '0')}.json`), last);
    console.log(`page ${n}: ${last.rows.length} rows`);
  }
  state.complete = true;
  writeJson(STATE, state);
}

const titleCase = (segment: string) =>
  segment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

function convert(window: Window) {
  const rows = pages()
    .flatMap((file) => readPage(file).rows)
    .filter((r) => r.t >= window.start && r.t < window.end);
  const featureOf = (r: Row) => r.segment ?? 'no-page';
  const bySegment = new Map<string, number>();
  for (const r of rows) bump(bySegment, featureOf(r));
  const kept = [...bySegment].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([segment]) => segment);
  const actors = new Map<string, ActorRef>();
  const grouped = new Map<string, SourceEvent>();
  const byFeature = new Map<string, number>();
  for (const r of rows) {
    const actor: ActorRef = r.email
      ? { key: `sentry:email:${r.email}`, email: r.email, name: null, kind: 'person', groupHint: null, clientHint: null }
      : SYSTEM;
    actors.set(actor.key, actor);
    const feature = `dashboard/${featureOf(r)}`;
    bump(byFeature, feature);
    const t = Math.floor(r.t / MINUTE) * MINUTE;
    const key = `${actor.key}|${feature}|${t}`;
    const event = grouped.get(key);
    if (event) event.count++;
    else
      grouped.set(key, {
        kind: 'error',
        t,
        actor: actor.key,
        via: null,
        resource: null,
        resourceId: null,
        building: 'dashboard',
        from: null,
        to: null,
        isReturn: false,
        count: 1,
        clientHint: null,
        feature,
      });
  }
  const features: Feature[] = kept.map((segment) => ({
    id: `dashboard/${segment}`,
    building: 'dashboard',
    name: titleCase(segment),
  }));
  const events = [...grouped.values()].sort((a, b) => a.t - b.t || a.actor.localeCompare(b.actor) || a.feature!.localeCompare(b.feature!));
  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'sentry',
    window,
    actors: [...actors.values()].sort((a, b) => a.key.localeCompare(b.key)),
    buildings: [{ id: 'dashboard', region: INTERNAL_REGION, name: 'Dashboard', resource: null }],
    features,
    events,
    initial: [],
    sessions: [],
    measures: [],
    artifacts: [],
  };
  return { file, rows, byFeature };
}

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  await pull(window);
  const { file, rows, byFeature } = convert(window);
  writeJson(OUT, file);
  const levels = new Map<string, number>();
  for (const r of rows) bump(levels, r.level || 'none');
  const withUser = rows.filter((r) => r.email);
  console.log('Sentry source');
  console.log(`  error events read         ${rows.length}`);
  console.log(`  distinct issues           ${new Set(rows.map((r) => r.issue)).size}`);
  console.log(`  levels                    ${[...levels].map(([level, n]) => `${level} ${n}`).join(', ')}`);
  console.log(`  with a user               ${withUser.length} (${new Set(withUser.map((r) => r.email)).size} users)`);
  console.log(`  without a user            ${rows.length - withUser.length}`);
  console.log(`  without a page            ${rows.filter((r) => !r.segment).length}`);
  console.log(`  features                  ${file.features!.length}`);
  for (const feature of file.features!) console.log(`    ${feature.id.padEnd(32)}${byFeature.get(feature.id)}`);
  console.log(`  events written            ${file.events.length}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}. ${requests} API requests this run.`);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
