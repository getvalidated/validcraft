import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, type ActorRef, type Registry, type SourceBusy, type SourceFile, type Window } from '../../src/schema';
import { config, secret, setting } from '../lib/config';
import { describeWindow, loadWindow } from '../lib/window';

const RAW = path.resolve('data/raw/calendar');
const PEOPLE = path.join(RAW, 'people');
const STATE = path.join(RAW, 'state.json');
const OUT = path.resolve('data/sources/calendar.json');
const REGISTRY = path.resolve('data/registry.json');
const DOMAIN = setting(config.calendar.domain ?? config.org.domains[0], 'calendar.domain');
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const FIELDS =
  'timeZone,nextPageToken,items(id,iCalUID,status,transparency,eventType,summary,start,end,attendees(email,self,responseStatus,resource))';
const AWAY = /\b(ooo|out of (the )?office|pto|vacation|holiday|sick|time off|day off|on leave)\b/i;

interface State {
  start: number;
  end: number;
  done: Record<string, string>;
}

interface Kept {
  id: string;
  type: string;
  start: string;
  end: string;
  allDay: boolean;
  free: boolean;
  away: boolean;
  self: string | null;
  others: number;
  internal: string[];
}

interface Page {
  timeZone: string;
  events: Kept[];
}

class Skip extends Error {}

let requests = 0;

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function openState(window: Window): State {
  if (!fs.existsSync(STATE)) return { start: window.start, end: window.end, done: {} };
  const state: State = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error('data/raw/calendar was pulled for a different window than data/window.json; remove data/raw/calendar to pull this window');
  }
  return state;
}

function pagesOf(email: string) {
  const dir = path.join(PEOPLE, email);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Page);
}

function people(): string[] {
  if (!fs.existsSync(REGISTRY)) throw new Error('No data/registry.json. Run `npm run registry` first.');
  const registry: Registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const persons = new Set(registry.units.filter((u) => u.kind === 'person').map((u) => u.id));
  return Object.entries(registry.emails)
    .filter(([email, unit]) => email.endsWith(`@${DOMAIN}`) && persons.has(unit))
    .map(([email]) => email)
    .sort();
}

function loadKey(): { client_email: string; private_key: string; token_uri: string } {
  return JSON.parse(secret('GOOGLE_SERVICE_ACCOUNT_KEY'));
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

async function tokenFor(key: ReturnType<typeof loadKey>, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ iss: key.client_email, sub: email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 600 }));
  const signature = b64(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
  requests++;
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.access_token) return body.access_token as string;
  const reason = `${body.error ?? res.status}: ${String(body.error_description ?? '').slice(0, 120)}`;
  if (res.status === 400 && body.error === 'invalid_grant') throw new Skip(reason);
  throw new Error(`token for a calendar read failed (${reason})`);
}

function keep(item: any): Kept | null {
  if (item.status === 'cancelled' || !item.start || !item.end) return null;
  const attendees: any[] = (item.attendees ?? []).filter((a: any) => !a.resource);
  const self = attendees.find((a) => a.self);
  const others = attendees.filter((a) => !a.self && a.responseStatus !== 'declined');
  return {
    id: item.iCalUID ?? item.id,
    type: item.eventType ?? 'default',
    start: item.start.dateTime ?? item.start.date,
    end: item.end.dateTime ?? item.end.date,
    allDay: !item.start.dateTime,
    free: item.transparency === 'transparent',
    away: AWAY.test(item.summary ?? ''),
    self: self?.responseStatus ?? null,
    others: others.length,
    internal: others
      .map((a) => String(a.email ?? '').toLowerCase())
      .filter((email) => email.endsWith(`@${DOMAIN}`))
      .sort(),
  };
}

async function pull(window: Window) {
  const state = openState(window);
  const todo = people().filter((email) => !(email in state.done));
  if (!todo.length) return state;
  const key = loadKey();
  for (const email of todo) {
    let token: string;
    try {
      token = await tokenFor(key, email);
    } catch (err) {
      if (!(err instanceof Skip)) throw err;
      state.done[email] = `skipped: ${err.message}`;
      writeJson(STATE, state);
      continue;
    }
    fs.rmSync(path.join(PEOPLE, email), { recursive: true, force: true });
    let pageToken = '';
    let page = 0;
    let skipped = '';
    do {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.search = new URLSearchParams({
        timeMin: new Date(window.start).toISOString(),
        timeMax: new Date(window.end).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        fields: FIELDS,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      requests++;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404 || (res.status === 403 && (await res.clone().text()).includes('notACalendarUser'))) {
        skipped = 'skipped: no calendar';
        break;
      }
      if (!res.ok) throw new Error(`calendar read failed with ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
      const body = await res.json();
      const events = (body.items ?? []).map(keep).filter((e: Kept | null): e is Kept => e !== null);
      writeJson(path.join(PEOPLE, email, `${String(++page).padStart(5, '0')}.json`), { timeZone: body.timeZone ?? 'UTC', events } satisfies Page);
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    state.done[email] = skipped || 'ok';
    writeJson(STATE, state);
  }
  return state;
}

function zonedMidnight(date: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(t).map((part) => [part.type, Number(part.value)]));
    t += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return t;
}

const actorKey = (email: string) => `calendar:email:${email}`;

function convert(window: Window, state: State) {
  const busy: SourceBusy[] = [];
  const actors: ActorRef[] = [];
  const meetings = new Set<string>();
  let away = 0;
  for (const email of Object.keys(state.done).sort()) {
    if (state.done[email] !== 'ok') continue;
    const seen = new Set<string>();
    let any = false;
    for (const page of pagesOf(email)) {
      for (const e of page.events) {
        if (e.type === 'workingLocation' || e.self === 'declined') continue;
        const at = (value: string) => (e.allDay ? zonedMidnight(value, page.timeZone) : Date.parse(value));
        const start = Math.max(window.start, at(e.start));
        const end = Math.min(window.end, at(e.end));
        if (!(end > start)) continue;
        const key = `${e.id}@${start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (e.type === 'outOfOffice' || (e.away && (e.allDay || e.others === 0))) {
          busy.push({ actor: actorKey(email), kind: 'ooo', start, end, meeting: null });
          away++;
          any = true;
        } else if (e.type === 'default' && !e.allDay && !e.free && e.others > 0) {
          busy.push({ actor: actorKey(email), kind: 'meeting', start, end, meeting: key });
          meetings.add(key);
          any = true;
        }
      }
    }
    if (any) actors.push({ key: actorKey(email), email, name: null, kind: 'person', groupHint: null, clientHint: null });
  }
  busy.sort((a, b) => a.start - b.start);
  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'calendar',
    window,
    actors,
    buildings: [],
    events: [],
    initial: [],
    sessions: [],
    measures: [],
    artifacts: [],
    busy,
  };
  return { file, meetings: meetings.size, away };
}

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const state = await pull(window);
  const outcomes = Object.values(state.done);
  const { file, meetings, away } = convert(window, state);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  const skipped = Object.entries(state.done).filter(([, outcome]) => outcome !== 'ok');
  console.log('Calendar source');
  console.log(`  calendars read            ${outcomes.filter((o) => o === 'ok').length}`);
  console.log(`  calendars skipped         ${skipped.length}`);
  for (const [email, outcome] of skipped) console.log(`    ${email} ${outcome}`);
  console.log(`  people with busy time     ${file.actors.filter((actor) => actor.kind === 'person').length}`);
  console.log(`  meetings                  ${meetings}`);
  console.log(`  meeting attendances       ${file.busy!.filter((b) => b.kind === 'meeting').length}`);
  console.log(`  out of office spans       ${away}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}. ${requests} API requests this run.`);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
