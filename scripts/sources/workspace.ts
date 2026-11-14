import fs from 'node:fs';
import path from 'node:path';
import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type EventKind,
  type Feature,
  type Registry,
  type ResourceType,
  type SourceEvent,
  type SourceFile,
  type Window,
} from '../../src/schema';
import { config, setting } from '../lib/config';
import { serviceToken } from '../lib/google';
import { describeWindow, loadWindow } from '../lib/window';
import { Skip, iso, openState, pagesIn, readPage, savePage, saveState, type State } from './sessions/shared';
import { MAIL_SHAPE, MORE_APPS, convertActions, mailCell, type App } from './workspace/actions';

const RAW = path.resolve('data/raw/workspace');
const OUT = path.resolve('data/sources/workspace.json');
const REGISTRY = path.resolve('data/registry.json');
const DOMAIN = setting(config.workspace.domain, 'workspace.domain');
const ADMIN = process.env.REPORTS_SUBJECT ?? setting(config.workspace.admin, 'workspace.admin');
const REPORTS_SCOPE = 'https://www.googleapis.com/auth/admin.reports.audit.readonly';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MINUTE = 60_000;
const TERMS_PER_QUERY = 25;
const GETS_AT_ONCE = 8;
const SHARED_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com']);

interface Activity {
  t: number;
  email: string | null;
  event: string;
  params: Record<string, string | number | boolean>;
}

interface Mail {
  id: string;
  t: number;
  from: string | null;
  to: string[];
  reply?: boolean;
}

const APPS: { name: string; app: string; events: string[]; keep: string[] }[] = [
  { name: 'meet', app: 'meet', events: ['call_ended'], keep: ['conference_id', 'duration_seconds', 'identifier', 'identifier_type', 'is_external'] },
  { name: 'drive', app: 'drive', events: ['create', 'edit', 'upload'], keep: ['doc_id', 'doc_type', 'primary_event'] },
  { name: 'chat', app: 'chat', events: ['message_posted'], keep: ['conversation_type'] },
  { name: 'gemini', app: 'gemini_in_workspace_apps', events: ['feature_utilization'], keep: ['app_name', 'action'] },
];

let requests = 0;

async function getJson(label: string, url: string, token: string) {
  requests++;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function tokenFor(scope: string, email: string) {
  requests++;
  try {
    return await serviceToken(scope, email);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/invalid_grant|unauthorized_client/.test(reason)) throw new Skip(reason);
    throw err;
  }
}

const load = <T>(...parts: string[]) => pagesIn(path.join(RAW, ...parts)).flatMap((file) => readPage<T[]>(file));

async function pullReports(window: Window, apps: App[] = APPS) {
  let token: string | null = null;
  for (const { name, app, events, keep, filters } of apps) {
    for (const eventName of events) {
      const dir = path.join(RAW, name, eventName);
      const state = openState(dir, window) as State & { next?: string | null };
      if (state.complete) continue;
      token ??= await tokenFor(REPORTS_SCOPE, ADMIN);
      if (!state.next) fs.rmSync(dir, { recursive: true, force: true });
      for (let page = pagesIn(dir).length + 1; ; page++) {
        const query = new URLSearchParams({ startTime: iso(window.start), endTime: iso(window.end), maxResults: '1000', eventName });
        if (state.next) query.set('pageToken', state.next);
        if (filters) query.set('filters', filters);
        const body = await getJson(`Workspace ${name} activity`, `${REPORTS}/${app}?${query}`, token);
        const rows: Activity[] = [];
        for (const item of body.items ?? []) {
          for (const event of item.events ?? []) {
            if (event.name !== eventName) continue;
            const params: Activity['params'] = {};
            for (const p of event.parameters ?? []) {
              if (keep.includes(p.name)) params[p.name] = p.value ?? p.boolValue ?? (p.intValue !== undefined ? Number(p.intValue) : '');
            }
            rows.push({ t: Date.parse(item.id?.time), email: item.actor?.email?.toLowerCase() || null, event: eventName, params });
          }
        }
        savePage(dir, page, rows);
        state.next = body.nextPageToken ?? null;
        saveState(dir, state);
        if (!state.next) break;
      }
      saveState(dir, { ...state, complete: true });
      console.log(`${name} ${eventName}: ${load<Activity>(name, eventName).length} rows`);
    }
  }
}

function readRegistry(): Registry {
  if (!fs.existsSync(REGISTRY)) throw new Error('No data/registry.json. Run `npm run registry` first.');
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}

const domainOf = (email: string) => email.slice(email.indexOf('@') + 1);
const addresses = (value: unknown) => [...String(value ?? '').toLowerCase().matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0]);

async function pullMail(window: Window, registry: Registry) {
  const dir = path.join(RAW, 'gmail');
  let state = openState(dir, window) as State & { done?: Record<string, string>; shape?: number };
  if (state.shape !== MAIL_SHAPE) {
    fs.rmSync(dir, { recursive: true, force: true });
    state = { start: window.start, end: window.end, complete: false, shape: MAIL_SHAPE };
  }
  if (state.complete) return;
  state.done ??= {};
  const persons = new Set(registry.units.filter((u) => u.kind === 'person').map((u) => u.id));
  const people = Object.entries(registry.emails)
    .filter(([email, unit]) => email.endsWith(`@${DOMAIN}`) && persons.has(unit))
    .map(([email]) => email)
    .sort();
  const outside = Object.keys(registry.emails).filter((email) => !email.endsWith(`@${DOMAIN}`));
  const terms = [...new Set(outside.map((email) => (SHARED_MAIL.has(domainOf(email)) ? email : domainOf(email))))].sort();
  const known = (email: string) => email.endsWith(`@${DOMAIN}`) || terms.includes(email) || terms.includes(domainOf(email));
  const range = `after:${Math.floor(window.start / 1000)} before:${Math.floor(window.end / 1000)}`;
  for (const email of people) {
    if (email in state.done) continue;
    let token: string;
    try {
      token = await tokenFor(GMAIL_SCOPE, email);
    } catch (err) {
      if (!(err instanceof Skip)) throw err;
      state.done[email] = 'no mailbox access';
      saveState(dir, state);
      continue;
    }
    const ids = new Set<string>();
    for (let i = 0; i < terms.length; i += TERMS_PER_QUERY) {
      const any = terms.slice(i, i + TERMS_PER_QUERY).flatMap((term) => [`from:${term}`, `to:${term}`, `cc:${term}`]).join(' ');
      let next = '';
      do {
        const query = new URLSearchParams({ q: `${range} {${any}}`, maxResults: '500', fields: 'messages/id,nextPageToken' });
        if (next) query.set('pageToken', next);
        const body = await getJson('Gmail message list', `${GMAIL}/messages?${query}`, token);
        for (const m of body.messages ?? []) ids.add(m.id);
        next = body.nextPageToken ?? '';
      } while (next);
    }
    const mails: Mail[] = [];
    const todo = [...ids];
    for (let i = 0; i < todo.length; i += GETS_AT_ONCE) {
      const bodies = await Promise.all(
        todo
          .slice(i, i + GETS_AT_ONCE)
          .map((id) => getJson('Gmail message headers', `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&fields=id,threadId,internalDate,payload/headers`, token)),
      );
      for (const body of bodies) {
        const header = (name: string) => (body.payload?.headers ?? []).filter((h: any) => String(h.name).toLowerCase() === name).map((h: any) => h.value).join(', ');
        mails.push({
          id: header('message-id') || `${email}:${body.id}`,
          t: Number(body.internalDate),
          from: addresses(header('from')).filter(known)[0] ?? null,
          to: [...new Set([...addresses(header('to')), ...addresses(header('cc'))])].filter(known),
          reply: !!header('in-reply-to') || (!!body.threadId && body.threadId !== body.id),
        });
      }
    }
    fs.rmSync(path.join(dir, email), { recursive: true, force: true });
    savePage(path.join(dir, email), 1, mails);
    state.done[email] = `${mails.length} messages`;
    saveState(dir, state);
    console.log(`gmail ${people.indexOf(email) + 1}/${people.length}: ${mails.length} messages with known contacts`);
  }
  saveState(dir, { ...state, complete: true });
}

const MEET: Building = { id: 'meet', region: INTERNAL_REGION, name: 'Google Meet', resource: 'call' };
const DOCS: Building = { id: 'google-docs', region: INTERNAL_REGION, name: 'Google Docs', resource: 'doc' };
const CHAT: Building = { id: 'google-chat', region: INTERNAL_REGION, name: 'Google Chat', resource: 'chat' };
const GEMINI: Building = { id: 'gemini', region: INTERNAL_REGION, name: 'Gemini', resource: null };
const MAIL: Building = { id: 'gmail', region: INTERNAL_REGION, name: 'Gmail', resource: 'email' };
const DOC_TYPES: Record<string, string> = {
  document: 'Docs',
  spreadsheet: 'Sheets',
  presentation: 'Slides',
  form: 'Forms',
  drawing: 'Drawings',
  script: 'Apps Script',
  shortcut: 'Shortcuts',
  pdf: 'PDFs',
  video: 'Videos',
  mp4: 'Videos',
  quicktime: 'Videos',
  mpeg: 'Videos',
  jpeg: 'Images',
  png: 'Images',
  gif: 'Images',
  msexcel: 'Excel files',
  msword: 'Word files',
  mspowerpoint: 'PowerPoint files',
  html: 'HTML files',
  unknown: 'Untyped files',
};
const words = (value: string) => value.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const registry = readRegistry();
  const actors = new Map<string, ActorRef>();
  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const grouped = new Map<string, SourceEvent>();
  const lines: string[] = [];
  let skipped = false;
  const actor = (email: string) => {
    const key = `workspace:email:${email}`;
    if (!actors.has(key)) actors.set(key, { key, email, name: null, kind: 'person', groupHint: null, clientHint: null });
    return key;
  };
  const staff = (email: string | null) => (email?.endsWith(`@${DOMAIN}`) ? actor(email) : null);
  const add = (
    kind: EventKind,
    resource: ResourceType | null,
    t: number,
    who: string | null,
    building: Building,
    slug: string,
    name: string,
    rest: { id?: string; from?: string; to?: string; hint?: string | null } = {},
  ) => {
    if (!who || !(t >= window.start && t < window.end)) return false;
    buildings.set(building.id, building);
    const feature = `${building.id}/${slug}`;
    features.set(feature, { id: feature, building: building.id, name });
    const minute = Math.floor(t / MINUTE) * MINUTE;
    const key = `${kind}|${who}|${feature}|${rest.id ?? minute}|${rest.to ?? ''}`;
    const event = grouped.get(key);
    if (event) event.count++;
    else {
      grouped.set(key, {
        kind,
        t: rest.id ? t : minute,
        actor: who,
        via: null,
        resource,
        resourceId: resource ? rest.id ?? `${resource}:${slug}:${who}:${minute}` : null,
        building: building.id,
        from: rest.from ?? null,
        to: rest.to ?? null,
        isReturn: false,
        count: 1,
        clientHint: rest.hint ?? null,
        feature,
      });
    }
    return true;
  };
  const attempt = async (name: string, run: () => Promise<string>) => {
    try {
      lines.push(`${name.padEnd(10)}${await run()}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped = true;
      lines.push(`${name.padEnd(10)}skipped: ${err instanceof Skip ? reason : `stopped on an error (${reason.replace(/\s+/g, ' ').slice(0, 300)})`}`);
    }
  };

  await attempt('activity', async () => {
    await pullReports(window);
    const guests = new Set<string>();
    const calls = load<Activity>('meet', 'call_ended');
    for (const call of calls) if (call.params.is_external === true && call.params.conference_id) guests.add(String(call.params.conference_id));
    let attended = 0;
    for (const call of calls) {
      const email = call.email ?? (call.params.identifier_type === 'email_address' ? String(call.params.identifier).toLowerCase() : null);
      const conference = String(call.params.conference_id ?? '');
      const seconds = Number(call.params.duration_seconds ?? 0);
      if (!conference || seconds < 60) continue;
      const outside = guests.has(conference);
      if (add('create', 'call', Math.max(window.start, call.t - seconds * 1000), staff(email), MEET, outside ? 'guests' : 'internal', outside ? 'With guests' : 'Internal', { id: `meet:${conference}:${email}` })) attended++;
    }
    let docs = 0;
    for (const event of ['create', 'upload', 'edit']) {
      for (const row of load<Activity>('drive', event)) {
        const type = String(row.params.doc_type ?? 'unknown');
        if (row.params.primary_event === false || type === 'folder' || !row.params.doc_id) continue;
        const name = DOC_TYPES[type] ?? `${type.toUpperCase()} files`;
        const made = event !== 'edit';
        if (add(made ? 'create' : 'edit', 'doc', row.t, staff(row.email), DOCS, name.toLowerCase().replace(/\s+/g, '-'), name, made ? { id: `gdoc:${row.params.doc_id}` } : {})) docs++;
      }
    }
    let chats = 0;
    for (const row of load<Activity>('chat', 'message_posted')) {
      const type = String(row.params.conversation_type ?? 'unspecified').toLowerCase();
      if (add('create', 'chat', row.t, staff(row.email), CHAT, type, words(type))) chats++;
    }
    let prompts = 0;
    for (const row of load<Activity>('gemini', 'feature_utilization')) {
      const app = String(row.params.app_name ?? 'unspecified').toLowerCase();
      if (add('use', null, row.t, staff(row.email), GEMINI, app, words(app))) prompts++;
    }
    return `${attended} call attendances, ${docs} doc creates and edits, ${chats} chat messages, ${prompts} Gemini uses`;
  });

  await attempt('actions', async () => {
    await pullReports(window, MORE_APPS);
    return convertActions({ load: (...parts) => load<Activity>(...parts), add, staff, buildings: { meet: MEET, docs: DOCS, chat: CHAT } });
  });

  await attempt('gmail', async () => {
    await pullMail(window, registry);
    const state = openState(path.join(RAW, 'gmail'), window) as State & { done?: Record<string, string> };
    const seen = new Set<string>();
    let sent = 0;
    let received = 0;
    for (const owner of Object.keys(state.done ?? {}).sort()) {
      for (const mail of load<Mail>('gmail', owner)) {
        if (!mail.from) continue;
        if (mail.from.endsWith(`@${DOMAIN}`) && !(mail.from in (state.done ?? {}))) continue;
        const inside = mail.from.endsWith(`@${DOMAIN}`);
        const others = inside ? mail.to.filter((email) => !email.endsWith(`@${DOMAIN}`)) : mail.to.includes(owner) ? [owner] : [];
        for (const other of others) {
          const key = `${mail.id}|${other}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const contact = inside ? other : mail.from;
          const hint = `email-domain:${domainOf(contact)}`;
          const shown = add('send', 'email', mail.t, actor(mail.from), MAIL, ...mailCell(inside, !!mail.reply), {
            id: `gmail:${mail.id}`,
            from: actor(mail.from),
            to: actor(other),
            hint: hint in registry.clientHints ? hint : null,
          });
          if (shown && inside) sent++;
          else if (shown) received++;
        }
      }
    }
    const denied = Object.values(state.done ?? {}).filter((note) => note === 'no mailbox access').length;
    return `${sent} emails to known contacts, ${received} from them, across ${Object.keys(state.done ?? {}).length - denied} mailboxes${denied ? `, ${denied} without access` : ''}`;
  });

  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'workspace',
    window,
    actors: [...actors.values()].sort((a, b) => a.key.localeCompare(b.key)),
    buildings: [...buildings.values()],
    features: [...features.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: [...grouped.values()].sort((a, b) => a.t - b.t),
    initial: [],
    sessions: [],
    measures: [],
    artifacts: [],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log('Workspace source');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors. ${requests} requests this run.`);
  if (skipped) process.exit(3);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
