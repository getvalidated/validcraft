import fs from 'node:fs';
import path from 'node:path';
import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type EventKind,
  type Registry,
  type ResourceType,
  type SessionTool,
  type SourceEvent,
  type SourceFile,
  type SourceName,
  type SourceSession,
  type Unit,
  type UnitKind,
  type Window,
} from '../src/schema';
import { buildReplay, printReport } from './lib/build';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SINCE = Date.parse('2026-01-05T08:00:00Z');
const UNTIL = SINCE + 2 * DAY;
const WINDOW: Window = { start: SINCE, end: UNTIL };
const OUT = path.resolve('fixtures/replay.sample.json');

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(4789);
const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);

interface Person {
  id: string;
  name: string;
  email: string | null;
  kind: UnitKind;
  team: string | null;
  client: string | null;
}

const TEAMS: Record<string, string[]> = {
  OPS: ['Ada Quill', 'Bram Solis', 'Calla Vance', 'Dax Moreno', 'Edda Lind'],
  DSN: ['Fitz Okoro', 'Gia Tran', 'Hugo Bell', 'Ines Park', 'Jude Amari'],
  PLT: ['Kit Rowan', 'Lena Voss', 'Milo Reyes', 'Nell Farrow'],
};

const CLIENTS = [
  { id: 'harbor', name: 'Harbor Foods', currency: 'USD', project: 'Harbor Launch', people: ['Odile Marsh', 'Pax Loring', 'Quin Hale'] },
  { id: 'atlas', name: 'Atlas Fitness', currency: 'USD', project: 'Atlas Refresh', people: ['Rhea Stone', 'Sol Varga'] },
  { id: 'ledger', name: 'Ledger Bank', currency: 'EUR', project: 'Ledger Cleanup', people: ['Tove Brandt'] },
  { id: 'pine', name: 'Pinecone Travel', currency: 'EUR', project: null, people: ['Uma Castell', 'Vik Doran'] },
];

const handle = (name: string) => name.toLowerCase().replace(' ', '.');
const people = new Map<string, Person>();
const members: Record<string, string[]> = {};
const clientPeople: Record<string, string[]> = {};
let n = 0;
for (const [team, names] of Object.entries(TEAMS)) {
  members[team] = names.map((name) => {
    const id = `u${String(++n).padStart(2, '0')}`;
    people.set(id, { id, name, email: `${handle(name)}@example.test`, kind: 'person', team, client: null });
    return id;
  });
}
n = 0;
for (const client of CLIENTS) {
  clientPeople[client.id] = client.people.map((name) => {
    const id = `c${String(++n).padStart(2, '0')}`;
    people.set(id, { id, name, email: `${handle(name)}@${client.id}.example.test`, kind: 'client', team: null, client: client.id });
    return id;
  });
}
const AUTOMATION = 'a01';
const STRANGER = 'x99';
people.set(AUTOMATION, { id: AUTOMATION, name: 'Relay Sync', email: null, kind: 'automation', team: 'OPS', client: null });
people.set(STRANGER, { id: STRANGER, name: 'Rook Halden', email: 'rook@nowhere.example.test', kind: 'client', team: null, client: null });
const BOTS = ['Intake', 'Workflow'];
for (const bot of BOTS) people.set(`bot:${bot}`, { id: `bot:${bot}`, name: bot, email: null, kind: 'system', team: null, client: null });

const EVERYONE = Object.values(members).flat();
const TEAM_KEYS = Object.keys(TEAMS);
const regionId = (client: string) => `client:${client}`;

const workTime = () => SINCE + pick([0, 1]) * DAY + between(9, 18) * HOUR;
function workTimeAfter(start: number) {
  for (let i = 0; i < 30; i++) {
    const t = workTime();
    if (t > start) return t;
  }
  return Math.min(UNTIL - MIN, start + rnd() * HOUR);
}

const sessions: SourceSession[] = [];
function addSession(owner: string, tool: SessionTool, start: number, minutes: number, parent: string | null = null) {
  const end = Math.min(UNTIL - MIN, start + minutes * MIN);
  const active: [number, number][] = [];
  let at = start;
  while (at < end) {
    const run = Math.min(end, at + between(3, 25) * MIN);
    active.push([Math.round(at), Math.round(run)]);
    at = run + between(2, 30) * MIN;
  }
  const id = `ses-${String(sessions.length + 1).padStart(3, '0')}`;
  sessions.push({
    id,
    owner: `sessions:${owner}`,
    tool,
    start: Math.round(start),
    end: Math.round(end),
    parent,
    tokens: Math.round(between(20, 900)) * 1000,
    active,
  });
  return { id, start, end };
}

const SESSION_OWNERS = ['u01', 'u03', 'u06', 'u07', 'u11', 'u12'];
const WITH_SUBAGENTS = ['u03', 'u11'];
for (const owner of SESSION_OWNERS) {
  for (let i = 0; i < 4; i++) {
    const parent = addSession(owner, pick<SessionTool>(['coding_agent', 'coding_agent', 'chat', 'cowork', 'other']), workTime(), between(20, 180));
    if (i === 0 && WITH_SUBAGENTS.includes(owner)) {
      for (let k = 0; k < 2; k++) {
        const start = between(parent.start + 2 * MIN, Math.max(parent.start + 3 * MIN, parent.end - 10 * MIN));
        addSession(owner, 'coding_agent', start, between(5, 30), parent.id);
      }
    }
  }
}
for (const day of [0, 1]) addSession('u12', 'scheduled', SINCE + day * DAY + 3 * HOUR, 40);
addSession(AUTOMATION, 'scheduled', SINCE + DAY + 5 * HOUR, 25);

function viaFor(actor: string, t: number) {
  const running = sessions.filter((s) => s.owner === `sessions:${actor}` && s.start <= t && t < s.end);
  return running.length && chance(0.6) ? pick(running).id : null;
}

interface Draft {
  source: SourceName;
  buildings: Building[];
  events: SourceEvent[];
  initial: SourceFile['initial'];
  sessions: SourceFile['sessions'];
  measures: SourceFile['measures'];
  artifacts: SourceFile['artifacts'];
}

const draft = (source: SourceName, buildings: Building[]): Draft => ({
  source,
  buildings,
  events: [],
  initial: [],
  sessions: [],
  measures: [],
  artifacts: [],
});

const building = (id: string, name: string, resource: ResourceType | null): Building => ({
  id,
  region: INTERNAL_REGION,
  name,
  resource,
});

function lifecycle(o: {
  into: Draft;
  resource: ResourceType;
  building: string;
  id: string;
  hint: string | null;
  team: string[];
  wide: string[];
  creator: string;
  steps: number;
  comments: number;
  edits: number;
  done: boolean;
  commenter?: string;
}) {
  const key = (id: string) => `${o.into.source}:${id}`;
  const fresh = chance(0.45);
  const createdAt = fresh ? workTime() : SINCE - between(2, 90) * HOUR;
  let holder: string | null = fresh ? null : chance(0.8) ? pick(o.team) : null;
  const held = new Set<string>(holder ? [holder] : []);
  const emit = (kind: EventKind, t: number, actor: string, rest: Partial<SourceEvent> = {}) =>
    o.into.events.push({
      kind,
      t: Math.round(t),
      actor: key(actor),
      via: viaFor(actor, t),
      resource: o.resource,
      resourceId: o.id,
      building: o.building,
      from: null,
      to: null,
      isReturn: false,
      count: 1,
      clientHint: o.hint,
      ...rest,
    });

  if (fresh) emit('create', createdAt, o.creator);
  else o.into.initial.push({ resource: o.resource, resourceId: o.id, holder: holder ? key(holder) : null, building: o.building });

  const start = Math.max(createdAt + 5 * MIN, SINCE + 9 * HOUR);
  const ops = [
    ...Array.from({ length: o.steps }, () => ({ op: 'move', t: workTimeAfter(start) })),
    ...Array.from({ length: o.comments }, () => ({ op: 'comment', t: workTimeAfter(start) })),
    ...Array.from({ length: o.edits }, () => ({ op: 'edit', t: workTimeAfter(start) })),
    ...(o.commenter ? [{ op: 'auto', t: workTimeAfter(start) }] : []),
  ].sort((a, b) => a.t - b.t);

  for (const { op, t } of ops) {
    if (op === 'move') {
      let to: string;
      if (!holder) {
        to = pick(o.team);
        emit('assign', t, pick(o.team.filter((m) => m !== to)), { to: key(to) });
      } else {
        const from: string = holder;
        const prior = [...held].filter((h) => h !== from);
        to = prior.length && chance(0.4) ? pick(prior) : pick((chance(0.75) ? o.team : o.wide).filter((m) => m !== from));
        emit('send', t, chance(0.7) ? from : pick(o.team), { from: key(from), to: key(to), isReturn: held.has(to) });
      }
      holder = to;
      held.add(to);
    } else if (op === 'comment') {
      emit('comment', t, chance(0.6) ? pick(o.team) : pick(o.wide), { to: holder ? key(holder) : null });
    } else if (op === 'auto') {
      emit('comment', t, o.commenter!, { to: holder ? key(holder) : null });
    } else {
      emit('edit', t, pick(o.team));
    }
  }

  if (o.done) {
    const last = Math.max(start, ...ops.map((x) => x.t));
    const t = Math.min(UNTIL - MIN, last + between(10, 130) * MIN);
    emit('done', t, holder ?? pick(o.team), { to: holder ? key(holder) : null });
  }
}

const linear = draft('linear', [building('linear', 'Linear', 'ticket')]);
const TICKET_PROJECTS: Record<string, (string | null)[]> = {
  OPS: ['Harbor Launch', 'Ledger Cleanup', null],
  DSN: ['Atlas Refresh', 'Harbor Launch'],
  PLT: ['Pipeline Rework', null],
};
for (let i = 1; i <= 44; i++) {
  const team = pick(['OPS', 'OPS', 'OPS', 'DSN', 'DSN', 'PLT']);
  const project = pick(TICKET_PROJECTS[team]);
  lifecycle({
    into: linear,
    resource: 'ticket',
    building: 'linear',
    id: `${team}-${100 + i}`,
    hint: project ? `linear-project:${project}` : null,
    team: members[team],
    wide: EVERYONE,
    creator: chance(0.12) ? 'bot:Intake' : pick(members[team]),
    steps: pick([0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 7]),
    comments: pick([0, 0, 1, 1, 2, 3, 5]),
    edits: pick([0, 1, 1, 2, 3]),
    done: chance(0.35),
    commenter: chance(0.55) ? AUTOMATION : undefined,
  });
}

function burst(into: Draft, resource: ResourceType, at: string, t0: number, size: number, stepMs: number, actor: string, via: string | null) {
  const ids = [...new Set([...into.initial.map((h) => h.resourceId), ...into.events.map((e) => e.resourceId!)])].slice(0, size);
  ids.forEach((id, k) =>
    into.events.push({
      kind: 'edit',
      t: t0 + k * stepMs,
      actor: `${into.source}:${actor}`,
      via,
      resource,
      resourceId: id,
      building: at,
      from: null,
      to: null,
      isReturn: false,
      count: 1,
      clientHint: null,
    }),
  );
}
burst(linear, 'ticket', 'linear', SINCE + DAY + 10.25 * HOUR, 18, 2000, 'u03', null);
burst(linear, 'ticket', 'linear', SINCE + 14.5 * HOUR, 7, 5000, 'bot:Workflow', null);

const slack = draft('slack', [building('slack', 'Slack', 'thread')]);
for (let i = 1; i <= 26; i++) {
  const team = pick(TEAM_KEYS);
  const client = chance(0.7) ? pick(CLIENTS) : null;
  const guests = client ? clientPeople[client.id] : [];
  lifecycle({
    into: slack,
    resource: 'thread',
    building: 'slack',
    id: `thr-${300 + i}`,
    hint: client ? `slack-channel:ext-${client.id}` : null,
    team: [...members[team], ...guests],
    wide: [...EVERYONE, ...guests],
    creator: guests.length && chance(0.6) ? pick(guests) : pick(members[team]),
    steps: pick([1, 1, 2, 2, 3, 4]),
    comments: pick([1, 2, 3, 4, 6]),
    edits: pick([0, 0, 1]),
    done: chance(0.4),
  });
}
slack.events.push({
  kind: 'comment',
  t: SINCE + DAY + 11 * HOUR,
  actor: `slack:${STRANGER}`,
  via: null,
  resource: 'thread',
  resourceId: 'thr-301',
  building: 'slack',
  from: null,
  to: null,
  isReturn: false,
  count: 1,
  clientHint: 'slack-channel:ext-unknown',
});

const notion = draft('notion', [building('notion', 'Notion', 'page')]);
for (let i = 1; i <= 18; i++) {
  const team = pick(TEAM_KEYS);
  const client = chance(0.5) ? pick(CLIENTS) : null;
  const guests = client && chance(0.4) ? clientPeople[client.id] : [];
  lifecycle({
    into: notion,
    resource: 'page',
    building: 'notion',
    id: `pg-${500 + i}`,
    hint: client ? `company:co-${client.id}` : null,
    team: [...members[team], ...guests],
    wide: EVERYONE,
    creator: pick(members[team]),
    steps: pick([0, 1, 1, 2, 3]),
    comments: pick([0, 1, 2, 3]),
    edits: pick([1, 2, 3, 4]),
    done: chance(0.25),
  });
}
const scheduled = sessions.find((s) => s.tool === 'scheduled' && s.owner === 'sessions:u12')!;
burst(notion, 'page', 'notion', scheduled.start + 4 * MIN, 6, 4000, 'u12', scheduled.id);

const agents = draft('sessions', [building('beacon', 'Beacon', null), building('forge', 'Forge', null)]);
agents.sessions = sessions;
for (const s of sessions) {
  agents.measures.push({ name: 'tokens', start: s.start, end: s.end, value: s.tokens!, currency: null, clientHint: null, actor: s.owner });
}

const money = draft('money', []);
const MONTH = { start: Date.parse('2026-01-01T08:00:00Z'), end: Date.parse('2026-02-01T08:00:00Z') };
for (const client of CLIENTS) {
  for (const day of [0, 1]) {
    money.measures.push({
      name: 'ad_spend',
      start: SINCE + day * DAY,
      end: SINCE + (day + 1) * DAY,
      value: Math.round(between(800, 5200)),
      currency: client.currency,
      clientHint: `company:co-${client.id}`,
      actor: null,
    });
  }
  money.measures.push({
    name: 'fee_revenue',
    ...MONTH,
    value: Math.round(between(6, 20)) * 1000,
    currency: client.currency,
    clientHint: `stripe:cus-${client.id}`,
    actor: null,
  });
}
[
  { client: 'harbor', maker: 'u07', name: 'Dockside Breakfast 15s', at: 13.5 * HOUR },
  { client: 'atlas', maker: 'u08', name: 'Five Minute Core', at: DAY + 10.75 * HOUR },
  { client: 'pine', maker: 'u07', name: 'Window Seat Carousel', at: DAY + 16.25 * HOUR },
].forEach((ad, i) =>
  money.artifacts.push({
    id: `ad-${i + 1}`,
    kind: 'winning_ad',
    t: SINCE + ad.at,
    name: ad.name,
    clientHint: `company:co-${ad.client}`,
    actor: `money:${ad.maker}`,
  }),
);

function finish(d: Draft): SourceFile {
  const used = new Set(
    [
      ...d.events.flatMap((e) => [e.actor, e.from, e.to]),
      ...d.initial.map((h) => h.holder),
      ...d.sessions.map((s) => s.owner),
      ...d.measures.map((m) => m.actor),
      ...d.artifacts.map((a) => a.actor),
    ].filter((k): k is string => !!k),
  );
  const actors: ActorRef[] = [...used].sort().map((key) => {
    const person = people.get(key.slice(d.source.length + 1))!;
    return {
      key,
      email: person.email,
      name: person.name,
      kind: person.kind,
      groupHint: person.team,
      clientHint: person.client ? `slack-team:T-${person.client}` : null,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: d.source,
    window: WINDOW,
    actors,
    buildings: d.buildings,
    events: d.events.sort((a, b) => a.t - b.t),
    initial: d.initial,
    sessions: d.sessions,
    measures: d.measures,
    artifacts: d.artifacts,
  };
}

const sources = [linear, slack, notion, agents, money].map(finish);

const known = [...people.values()].filter((p) => p.id !== STRANGER);
const unitId = (p: Person) => (p.kind === 'system' ? `sys-${p.name.toLowerCase()}` : p.id);
const units: Unit[] = known.map((p) => ({
  id: unitId(p),
  kind: p.kind,
  name: p.name,
  region: p.client ? regionId(p.client) : INTERNAL_REGION,
  group: p.team ? `${INTERNAL_REGION}/${p.team}` : null,
}));
const registry: Registry = {
  schemaVersion: SCHEMA_VERSION,
  regions: [
    { id: INTERNAL_REGION, kind: 'internal', name: 'Home' },
    ...CLIENTS.map((c) => ({ id: regionId(c.id), kind: 'client' as const, name: c.name })),
  ],
  groups: TEAM_KEYS.map((team) => ({ id: `${INTERNAL_REGION}/${team}`, region: INTERNAL_REGION, name: team })),
  units,
  identities: Object.fromEntries(
    known.flatMap((p) =>
      (['linear', 'slack', 'notion', 'sessions'] as SourceName[]).map((source) => [`${source}:${p.id}`, unitId(p)]),
    ),
  ),
  emails: Object.fromEntries(known.filter((p) => p.email).map((p) => [p.email!, unitId(p)])),
  clientHints: Object.fromEntries(
    CLIENTS.flatMap((c) => [
      ...(c.project ? [[`linear-project:${c.project}`, regionId(c.id)]] : []),
      [`slack-channel:ext-${c.id}`, regionId(c.id)],
      [`slack-team:T-${c.id}`, regionId(c.id)],
      [`company:co-${c.id}`, regionId(c.id)],
      [`stripe:cus-${c.id}`, regionId(c.id)],
    ]),
  ),
};

const { replay, report } = buildReplay({ window: WINDOW, sources, registry });
printReport(report);
if (!report.ok) {
  console.error('Reconciliation failed.');
  process.exit(1);
}

const lines = (rows: unknown[]) => (rows.length ? `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n]` : '[]');
const text = `{
"schemaVersion": ${replay.schemaVersion},
"window": ${JSON.stringify(replay.window)},
"sources": ${JSON.stringify(replay.sources)},
"regions": ${lines(replay.regions)},
"groups": ${lines(replay.groups)},
"buildings": ${lines(replay.buildings)},
"units": ${lines(replay.units)},
"sessions": ${lines(replay.sessions)},
"initial": ${lines(replay.initial)},
"events": ${lines(replay.events)},
"measures": ${lines(replay.measures)},
"artifacts": ${lines(replay.artifacts)},
"weekly": ${JSON.stringify(replay.weekly, null, 1)},
"unmapped": ${JSON.stringify(replay.unmapped)}
}
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${replay.events.length} events, ${replay.units.length} units.`);
