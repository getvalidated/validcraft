import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_REGION, SCHEMA_VERSION, type ActorRef, type Building, type Feature, type SourceEvent, type SourceFile, type SourceMeasure, type Window } from '../../src/schema';
import { config } from '../lib/config';
import { describeWindow, loadWindow } from '../lib/window';
import { Skip, openState, pagesIn, readPage, savePage, saveState, secretOrSkip } from './sessions/shared';

const RAW = path.resolve('data/raw/spend');
const OUT = path.resolve('data/sources/spend.json');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const TZ = 'America/Los_Angeles';

const CLOUD = 'Google Cloud';
const CLAUDE_API = 'Claude API';
const OPENAI_API = 'OpenAI API';
const PREPAID = new Set([CLAUDE_API]);
const VENDORS: [RegExp, string][] = [
  [/(anthropic|claude).*\b(max|pro|team|seats?)\b|claude\.ai/i, 'claude.ai'],
  [/anthropic|claude/i, CLAUDE_API],
  [/chatgpt/i, 'ChatGPT'],
  [/openai/i, OPENAI_API],
  [/google\s*\*?\s*cloud|gcp/i, CLOUD],
];

interface CloudDay {
  day: string;
  service: string;
  cost: string;
  currency: string;
}

interface Charge {
  id: string;
  t: number;
  vendor: string;
  fund: string;
  amount: number;
  currency: string;
  who: { id: string; name: string } | null;
}

let requests = 0;

const iso = (t: number) => new Date(t).toISOString();

const wallFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallAsUtc(t: number) {
  const p = Object.fromEntries(wallFormat.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function pacific(day: string) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let t = target + 8 * HOUR;
  for (let i = 0; i < 3; i++) t += target - wallAsUtc(t);
  return t;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 24 * HOUR).toISOString().slice(0, 10);

async function getJson(label: string, url: string, headers: Record<string, string>) {
  requests++;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function pullCloud(window: Window) {
  const dir = path.join(RAW, 'gcp');
  const state = openState(dir, window);
  if (state.complete) return dir;
  const { gcpProject, gcpBillingTable } = config.spend;
  if (!gcpProject || !gcpBillingTable) throw new Skip('spend.gcpProject and spend.gcpBillingTable are not set in rts.config.json');
  if (!/^[\w.-]+$/.test(gcpBillingTable)) throw new Error('spend.gcpBillingTable is not a table name of the form project.dataset.table');
  const query = `SELECT FORMAT_DATE('%F', DATE(usage_start_time, '${TZ}')) AS day, service.description AS service,
    CAST(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS STRING) AS cost, currency
    FROM \`${gcpBillingTable}\`
    WHERE _PARTITIONTIME >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(${window.start}), INTERVAL 1 DAY)
      AND usage_start_time >= TIMESTAMP_MILLIS(${window.start}) AND usage_start_time < TIMESTAMP_MILLIS(${window.end})
    GROUP BY day, service, currency ORDER BY day, service`;
  requests++;
  const out = execFileSync('bq', ['query', `--project_id=${gcpProject}`, '--use_legacy_sql=false', '--format=json', '--max_rows=100000', query], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
  savePage(dir, 1, JSON.parse(out || '[]'));
  saveState(dir, { ...state, complete: true });
  return dir;
}

async function pullClaude(window: Window) {
  const dir = path.join(RAW, 'anthropic');
  const state = openState(dir, window);
  if (state.complete) return dir;
  const headers = { 'x-api-key': secretOrSkip('ANTHROPIC_ADMIN_KEY'), 'anthropic-version': '2026-10-21', 'User-Agent': 'rts' };
  const range = `starting_at=${iso(Math.floor(window.start / DAY) * DAY)}&ending_at=${iso(Math.ceil(window.end / DAY) * DAY)}&group_by[]=description&limit=31`;
  const saved = pagesIn(dir);
  let count = saved.length;
  let page: string | null = count ? readPage<{ has_more?: boolean; next_page?: string | null }>(saved[count - 1]).next_page ?? null : '';
  while (page !== null) {
    const body = await getJson('Anthropic cost report', `https://api.anthropic.com/v1/organizations/cost_report?${range}${page ? `&page=${encodeURIComponent(page)}` : ''}`, headers);
    savePage(dir, ++count, body);
    page = body.has_more && body.next_page ? body.next_page : null;
  }
  saveState(dir, { ...state, complete: true });
  return dir;
}

async function pullOpenAI(window: Window) {
  const dir = path.join(RAW, 'openai');
  const state = openState(dir, window);
  if (state.complete) return dir;
  const headers = { Authorization: `Bearer ${secretOrSkip('OPENAI_ADMIN_KEY')}` };
  const range = `start_time=${Math.floor(window.start / DAY) * (DAY / 1000)}&end_time=${Math.ceil(window.end / DAY) * (DAY / 1000)}&bucket_width=1d&limit=31`;
  const saved = pagesIn(dir);
  let count = saved.length;
  let page: string | null = count ? readPage<{ has_more?: boolean; next_page?: string | null }>(saved[count - 1]).next_page ?? null : '';
  while (page !== null) {
    const body = await getJson('OpenAI costs', `https://api.openai.com/v1/organization/costs?${range}${page ? `&page=${encodeURIComponent(page)}` : ''}`, headers);
    savePage(dir, ++count, body);
    page = body.has_more && body.next_page ? body.next_page : null;
  }
  saveState(dir, { ...state, complete: true });
  return dir;
}

function readRamp(window: Window): Charge[] {
  const dir = path.join(RAW, 'ramp');
  if (!openState(dir, window).complete) {
    throw new Skip('no Ramp card charges saved for this week. Ramp only answers through its MCP, so ask Claude to save the ramp_get_transactions pages for the week to data/raw/spend/ramp');
  }
  const charges: Charge[] = [];
  for (const file of pagesIn(dir)) {
    for (const t of readPage<{ transactions?: any[] }>(file).transactions ?? []) {
      const at = Date.parse(t.transaction_time ?? '');
      const amount = Number(t.amount_value);
      if (!Number.isFinite(at) || !Number.isFinite(amount) || t.state === 'DECLINED') continue;
      charges.push({
        id: `ramp:${t.transaction_uuid}`,
        t: at,
        vendor: String(t.merchant_name || 'Unknown'),
        fund: String(t.spend_allocation_name ?? ''),
        amount,
        currency: String(t.amount_currency ?? 'USD').toUpperCase(),
        who: t.spent_by_user && t.spent_by_user_uuid ? { id: String(t.spent_by_user_uuid), name: String(t.spent_by_user) } : null,
      });
    }
  }
  return charges.sort((x, y) => x.t - y.t);
}

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const measures: SourceMeasure[] = [];
  const events: SourceEvent[] = [];
  const actors = new Map<string, ActorRef>();
  const features = new Map<string, Feature>();
  const lines: string[] = [];
  let skipped = false;
  const spent: Record<string, number> = {};
  const expense = (label: string, start: number, end: number, value: number, currency: string) => {
    if (value) measures.push({ name: 'expense', start, end, value, currency, clientHint: null, actor: null, label });
  };
  const attempt = async (name: string, run: () => Promise<string> | string) => {
    try {
      lines.push(`${name.padEnd(14)}${await run()}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped = true;
      lines.push(`${name.padEnd(14)}skipped: ${err instanceof Skip ? reason : `stopped on an error (${reason.replace(/\s+/g, ' ').slice(0, 300)})`}`);
    }
  };

  await attempt('google cloud', () => {
    const rows = pagesIn(pullCloud(window)).flatMap((file) => readPage<CloudDay[]>(file));
    for (const row of rows) {
      const start = pacific(row.day);
      expense(CLOUD, start, Math.min(window.end, pacific(addDays(row.day, 1))), Number(row.cost), row.currency.toUpperCase());
    }
    return `${rows.length} service days from the billing export`;
  });

  await attempt('claude api', async () => {
    const buckets = pagesIn(await pullClaude(window)).flatMap((file) => readPage<{ data?: any[] }>(file).data ?? []);
    for (const bucket of buckets) {
      const from = Date.parse(bucket.starting_at);
      const to = Date.parse(bucket.ending_at);
      const start = Math.max(window.start, from);
      const end = Math.min(window.end, to);
      const share = (end - start) / (to - from);
      for (const result of bucket.results ?? []) if (end > start) expense(CLAUDE_API, start, end, (Number(result.amount) / 100) * share, String(result.currency ?? 'USD').toUpperCase());
    }
    return `${buckets.length} days from the cost report`;
  });

  await attempt('openai api', async () => {
    const buckets = pagesIn(await pullOpenAI(window)).flatMap((file) => readPage<{ data?: any[] }>(file).data ?? []);
    for (const bucket of buckets) {
      const from = Number(bucket.start_time) * 1000;
      const to = Number(bucket.end_time) * 1000;
      const start = Math.max(window.start, from);
      const end = Math.min(window.end, to);
      const share = (end - start) / (to - from);
      for (const result of bucket.results ?? []) if (end > start) expense(OPENAI_API, start, end, Number(result.amount?.value ?? 0) * share, String(result.amount?.currency ?? 'USD').toUpperCase());
    }
    return `${buckets.length} days from the costs report`;
  });

  const ramp: Building = { id: 'ramp', region: INTERNAL_REGION, name: 'Ramp', resource: 'bill' };
  let billed = false;
  let prepaid = false;
  await attempt('ramp', async () => {
    const charges = readRamp(window).filter((charge) => charge.t >= window.start && charge.t < window.end);
    prepaid = true;
    const system = 'ramp:system';
    const paid: Record<string, number> = {};
    for (const charge of charges) {
      const label = VENDORS.find(([test]) => test.test(`${charge.vendor} ${charge.fund}`))?.[1] ?? charge.vendor;
      expense(label, charge.t, charge.t, charge.amount, charge.currency);
      paid[charge.currency] = (paid[charge.currency] ?? 0) + charge.amount;
      let actor = system;
      if (charge.who) {
        actor = `ramp:user:${charge.who.id}`;
        actors.set(actor, { key: actor, email: null, name: charge.who.name, kind: 'person', groupHint: null, clientHint: null });
      } else actors.set(system, { key: system, email: null, name: 'Ramp', kind: 'system', groupHint: null, clientHint: null });
      const feature = `${ramp.id}/${charge.vendor.toLowerCase().replace(/\s+/g, '-')}`;
      features.set(feature, { id: feature, building: ramp.id, name: charge.vendor });
      events.push({ kind: 'create', t: charge.t, actor, via: null, resource: 'bill', resourceId: charge.id, building: ramp.id, from: null, to: null, isReturn: false, count: 1, clientHint: null, feature, amount: charge.amount, currency: charge.currency });
    }
    billed = charges.length > 0;
    return `${charges.length} card charges, ${Object.entries(paid).map(([currency, value]) => `${currency} ${value.toFixed(2)}`).join(' + ') || 'nothing'}, each a cost at its own time`;
  });
  if (prepaid) for (const m of measures) if (m.start < m.end && PREPAID.has(m.label!)) m.paidBy = ramp.id;
  for (const m of measures) {
    const key = `${m.paidBy ? `${m.label} usage, paid through Ramp` : m.label} ${m.currency}`;
    spent[key] = (spent[key] ?? 0) + m.value;
  }

  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'spend',
    window,
    actors: [...actors.values()].sort((a, b) => a.key.localeCompare(b.key)),
    buildings: billed ? [ramp] : [],
    features: [...features.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: events.sort((a, b) => a.t - b.t),
    initial: [],
    sessions: [],
    measures: measures.sort((a, b) => a.start - b.start),
    artifacts: [],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log('Spend source');
  for (const line of lines) console.log(`  ${line}`);
  for (const [label, value] of Object.entries(spent).sort()) console.log(`  ${label.padEnd(44)}${value.toFixed(2).padStart(12)}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.measures.length} measures. ${requests} requests this run.`);
  if (skipped) process.exit(3);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
