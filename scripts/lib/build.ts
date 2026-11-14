import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  UNMAPPED_REGION,
  type ActorRef,
  type Building,
  type EventKind,
  type Feature,
  type Group,
  type PersonStats,
  type Region,
  type Registry,
  type Replay,
  type ReplayEvent,
  type ResourceType,
  type Session,
  type SessionTool,
  type SourceEvent,
  type SourceFile,
  type SourceName,
  type Unit,
  type Weekly,
  type Window,
} from '../../src/schema';
import { config } from './config';
import type { Ledger } from './lineage';
import { STALE_MS } from '../../src/sim/holdings';
import { finishTraces, startTraces, traceOf, type TraceReport } from './traces';

export interface BuildInput {
  window: Window;
  sources: SourceFile[];
  registry: Registry | null;
  ledger?: Ledger[];
}

type Check = { label: string; ok: boolean };

export interface SourceReport {
  source: SourceName;
  actors: number;
  unmappedActors: number;
  before: Record<EventKind, number>;
  after: Record<EventKind, number>;
  bulkCovered: number;
  initial: number;
  sessions: number;
  measures: number;
  artifacts: number;
  checks: Check[];
}

export interface Report {
  sources: SourceReport[];
  units: number;
  regions: number;
  groups: number;
  buildings: number;
  events: number;
  sessions: number;
  measures: number;
  artifacts: number;
  initial: number;
  unmapped: { actors: number; clientHints: number };
  bulkCredited: number;
  bulkUncredited: number;
  repeats: number;
  links: number;
  cycles: number;
  traces: TraceReport;
  registry: boolean;
  checks: Check[];
  ok: boolean;
}

export interface Unmapped {
  actors: { key: string; source: SourceName; events: number }[];
  clientHints: { hint: string; events: number }[];
}

const MINUTE = 60_000;
const AGENT_BUILDINGS = new Set(['agent-tools']);
const SESSION_TOOLS: SessionTool[] = ['coding_agent', 'cowork', 'chat', 'scheduled', 'other'];
const TOOL_NAMES: Record<SessionTool, string> = {
  coding_agent: 'Claude Code',
  cowork: 'Cowork',
  chat: 'Chat',
  scheduled: 'Scheduled',
  other: 'Other',
};
const SOURCE_ORDER: SourceName[] = ['linear', 'slack', 'notion', 'github', 'calendar', 'temporal', 'sentry', 'mixpanel', 'mcp', 'outputs', 'sessions', 'money', 'ashby', 'spend', 'platform', 'workspace', 'outreach', 'ops'];
const RESOURCES: ResourceType[] = ['ticket', 'page', 'thread', 'pr', 'analysis', 'embedding', 'taxonomy', 'row', 'video', 'campaign', 'adset', 'ad', 'resume', 'setting', 'report', 'bill', 'email', 'call', 'doc', 'chat', 'image', 'board', 'review', 'comment', 'rival', 'post', 'trend', 'outreach', 'booking', 'incident', 'deploy', 'build', 'assignment', 'invite', 'ambassador', 'lead', 'referral'];
const BULK_KINDS = new Set<EventKind>(['create', 'comment', 'done', 'edit']);
const PROJECT_HINT = 'linear-project:';
const AGENT_TOOLS = new Set<SessionTool>(['coding_agent', 'cowork', 'scheduled']);
const CREDIT_SLACK = 2 * MINUTE;

const emptyCounts = (): Record<EventKind, number> => ({
  create: 0,
  send: 0,
  assign: 0,
  comment: 0,
  done: 0,
  edit: 0,
  bulk: 0,
  use: 0,
  run: 0,
  error: 0,
  status: 0,
});

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function usedKeys(file: SourceFile) {
  return [
    ...file.events.flatMap((e) => [e.actor, e.from, e.to]),
    ...file.initial.map((h) => h.holder),
    ...file.sessions.map((s) => s.owner),
    ...file.measures.map((m) => m.actor),
    ...file.artifacts.map((a) => a.actor),
    ...(file.busy ?? []).map((b) => b.actor),
  ].filter((key): key is string => !!key);
}

export function buildReplay(input: BuildInput): { replay: Replay; report: Report; unmapped: Unmapped; ledger: Ledger } {
  const { window, registry } = input;
  const sources = [...input.sources].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));

  const actors = new Map<string, ActorRef>();
  const sourceOf = new Map<string, SourceName>();
  const listed = new Map<SourceFile, Set<string>>();
  for (const file of sources) {
    listed.set(file, new Set(file.actors.map((a) => a.key)));
    for (const actor of file.actors) {
      if (!actors.has(actor.key)) {
        actors.set(actor.key, actor);
        sourceOf.set(actor.key, file.source);
      }
    }
    for (const key of usedKeys(file)) {
      if (!actors.has(key)) {
        actors.set(key, { key, email: null, name: null, kind: 'person', groupHint: null, clientHint: null });
        sourceOf.set(key, file.source);
      }
    }
  }

  const regions: Region[] = registry
    ? [...registry.regions]
    : [{ id: INTERNAL_REGION, kind: 'internal', name: config.org.name }];
  if (!regions.some((r) => r.id === INTERNAL_REGION)) {
    regions.unshift({ id: INTERNAL_REGION, kind: 'internal', name: config.org.name });
  }
  const groups: Group[] = registry ? [...registry.groups] : [];
  const units: Unit[] = registry ? [...registry.units] : [];
  const unitIds = new Set(units.map((u) => u.id));
  const groupIds = new Set(groups.map((g) => g.id));

  const unitOf = new Map<string, string>();
  const groupVotes = new Map<string, Map<string, number>>();
  const loose: ActorRef[] = [];
  const byName = new Map<string, string | null>();
  for (const u of units) {
    if (u.kind !== 'person' || u.region !== INTERNAL_REGION) continue;
    for (const key of new Set([u.name.toLowerCase(), u.name.toLowerCase().split(/\s+/)[0]])) byName.set(key, byName.has(key) ? null : u.id);
  }
  for (const actor of actors.values()) {
    const email = actor.email?.toLowerCase() ?? null;
    const id = registry
      ? registry.identities[actor.key] ??
        (email ? registry.emails[email] : undefined) ??
        (!email && actor.kind === 'person' && actor.name ? byName.get(actor.name.toLowerCase()) ?? undefined : undefined)
      : undefined;
    if (id && unitIds.has(id)) {
      unitOf.set(actor.key, id);
      if (actor.groupHint) {
        if (!groupVotes.has(id)) groupVotes.set(id, new Map());
        const votes = groupVotes.get(id)!;
        votes.set(actor.groupHint, (votes.get(actor.groupHint) ?? 0) + 1);
      }
    } else loose.push(actor);
  }
  for (let i = 0; i < units.length; i++) {
    const votes = groupVotes.get(units[i].id);
    if (units[i].group != null || units[i].region !== INTERNAL_REGION || !votes) continue;
    const [hint] = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const group = `${INTERNAL_REGION}/${hint}`;
    if (!groupIds.has(group)) {
      groupIds.add(group);
      groups.push({ id: group, region: INTERNAL_REGION, name: hint });
    }
    units[i] = { ...units[i], group };
  }

  const emailCounts = new Map<string, number>();
  for (const actor of loose) {
    if (actor.email) emailCounts.set(actor.email.toLowerCase(), (emailCounts.get(actor.email.toLowerCase()) ?? 0) + 1);
  }
  const domainRegions = new Map<string, Set<string>>();
  const regionOfUnit = new Map(units.map((u) => [u.id, u.region]));
  for (const [email, id] of Object.entries(registry?.emails ?? {})) {
    const domain = email.slice(email.indexOf('@') + 1);
    if (!domainRegions.has(domain)) domainRegions.set(domain, new Set());
    domainRegions.get(domain)!.add(regionOfUnit.get(id) ?? UNMAPPED_REGION);
  }
  const homeOf = (email: string | null) => {
    const found = email ? domainRegions.get(email.slice(email.indexOf('@') + 1)) : undefined;
    const [only] = found?.size === 1 ? [...found] : [];
    return only && only !== INTERNAL_REGION && only !== UNMAPPED_REGION ? only : null;
  };
  const made = new Map<string, Unit>();
  const unnamed = new Set<string>();
  for (const actor of loose) {
    const email = actor.email?.toLowerCase() ?? null;
    const id = email && emailCounts.get(email)! > 1 ? `email:${email}` : actor.key;
    unitOf.set(actor.key, id);
    let group: string | null = null;
    if (!registry && actor.groupHint) {
      group = `${INTERNAL_REGION}/${actor.groupHint}`;
      if (!groupIds.has(group)) {
        groupIds.add(group);
        groups.push({ id: group, region: INTERNAL_REGION, name: actor.groupHint });
      }
    }
    const unit = made.get(id);
    if (!unit) {
      const home = homeOf(email) ?? (actor.clientHint ? registry?.clientHints[actor.clientHint] ?? null : null);
      made.set(id, {
        id,
        kind: home && actor.kind === 'person' ? 'client' : actor.kind,
        name: actor.name ?? email ?? actor.key,
        region: home ?? (registry ? UNMAPPED_REGION : INTERNAL_REGION),
        group,
      });
      if (!actor.name) unnamed.add(id);
    } else {
      if (unnamed.has(id) && actor.name) {
        unit.name = actor.name;
        unnamed.delete(id);
      }
      unit.group ??= group;
    }
  }
  if (!registry) groups.sort((a, b) => a.id.localeCompare(b.id));
  units.push(...[...made.values()].sort((a, b) => a.id.localeCompare(b.id)));
  for (const unit of made.values()) unitIds.add(unit.id);
  const unmappedActors = registry ? loose.length : 0;
  if (registry && made.size && !regions.some((r) => r.id === UNMAPPED_REGION)) {
    regions.push({ id: UNMAPPED_REGION, kind: 'unmapped', name: 'Unmapped' });
  }

  const unit = (key: string | null) => (key ? unitOf.get(key) ?? null : null);
  const missedHints = new Set<string>();
  const regionOf = (hint: string | null) => {
    if (!hint) return null;
    const region = registry?.clientHints[hint] ?? null;
    if (!region) missedHints.add(hint);
    return region;
  };

  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const pre: ReplayEvent[] = [];
  const events: ReplayEvent[] = [];
  const hintOf = new Map<ReplayEvent, string | null>();
  const replay: Replay = {
    schemaVersion: SCHEMA_VERSION,
    window,
    sources: sources.map((s) => s.source),
    regions,
    groups,
    buildings: [],
    units,
    sessions: [],
    initial: [],
    events,
    measures: [],
    artifacts: [],
    weekly: null,
    unmapped: { actors: unmappedActors, clientHints: 0 },
  };
  if (registry?.applicants) {
    replay.applicants = { ...registry.applicants, visits: registry.applicants.visits.filter(([, , by]) => unitIds.has(by)) };
  }
  const sourceReports: SourceReport[] = [];
  const actorEvents = new Map<string, number>();
  const hintEvents = new Map<string, number>();

  const first = new Map<string, SourceEvent>();
  const named = (e: SourceEvent) => (e.kind === 'create' && e.resource && e.resourceId ? `${e.resource}:${e.resourceId}` : null);
  for (const file of sources) {
    for (const e of file.events) {
      const key = named(e);
      const kept = key ? first.get(key) : undefined;
      if (key && (!kept || e.t < kept.t)) first.set(key, e);
    }
  }
  const repeat = (e: SourceEvent) => {
    const key = named(e);
    return !!key && first.get(key) !== e;
  };
  const repeats = sources.reduce((sum, file) => sum + file.events.filter(repeat).length, 0);

  const parentOf = new Map<string, string>();
  let cycles = 0;
  const hooks = sources
    .flatMap((file) => [...(file.links ?? []), ...file.events.flatMap((e) => (e.parent && named(e) ? [{ parent: e.parent, child: named(e)!, t: e.t }] : []))])
    .sort((a, b) => a.t - b.t);
  for (const { parent, child } of hooks) {
    if (parentOf.has(child)) continue;
    const seen = new Set([child]);
    let at: string | undefined = parent;
    while (at && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at);
    }
    if (at) cycles++;
    else parentOf.set(child, parent);
  }
  const identity = (key: string | null) => (key && registry?.identities[key] && unitIds.has(registry.identities[key]) ? registry.identities[key] : null);
  const tracing = startTraces(window, sources, hooks, input.ledger ?? [], (key) => unit(key) ?? identity(key), (hint) => (hint ? registry?.clientHints[hint] ?? null : null));

  for (const file of sources) {
    for (const building of file.buildings) if (!buildings.get(building.id)?.resource) buildings.set(building.id, building);
    for (const feature of file.features ?? []) if (!features.has(feature.id)) features.set(feature.id, feature);
    for (const e of file.events) {
      for (const key of new Set([e.actor, e.from, e.to])) if (key) actorEvents.set(key, (actorEvents.get(key) ?? 0) + 1);
      if (e.clientHint) hintEvents.set(e.clientHint, (hintEvents.get(e.clientHint) ?? 0) + 1);
    }

    const own: ReplayEvent[] = file.events
      .filter((e) => !repeat(e))
      .map((e) => {
        const event: ReplayEvent = {
          kind: e.kind,
          t: e.t,
          source: file.source,
          actor: unit(e.actor)!,
          via: e.via,
          resource: e.resource,
          resourceId: e.resourceId,
          building: e.building,
          from: unit(e.from),
          to: unit(e.to),
          isReturn: e.isReturn,
          count: e.count,
          region: regionOf(e.clientHint),
          feature: e.feature ?? null,
        };
        if (e.status) event.status = e.status;
        if (e.ours) event.ours = e.ours;
        if (e.amount !== undefined) Object.assign(event, { amount: e.amount, currency: e.currency });
        const parent = parentOf.get(named(e) ?? '');
        if (parent) event.parent = parent;
        const trace = traceOf(tracing, e);
        if (trace) event.trace = trace;
        hintOf.set(event, e.clientHint);
        return event;
      })
      .sort((a, b) => a.t - b.t);

    const minutes = new Map<string, ReplayEvent[]>();
    for (const e of own) {
      if (!BULK_KINDS.has(e.kind) || file.source === 'outputs' || file.source === 'platform' || e.parent || e.trace) continue;
      const key = `${e.actor}|${Math.floor(e.t / MINUTE)}`;
      if (!minutes.has(key)) minutes.set(key, []);
      minutes.get(key)!.push(e);
    }
    const collapsed = new Set<ReplayEvent>();
    const bulks: ReplayEvent[] = [];
    for (const group of minutes.values()) {
      if (group.length < 5) continue;
      for (const e of group) collapsed.add(e);
      bulks.push({
        kind: 'bulk',
        t: group[0].t,
        source: file.source,
        actor: group[0].actor,
        via: null,
        resource: null,
        resourceId: null,
        building: group.every((e) => e.building === group[0].building) ? group[0].building : null,
        from: null,
        to: null,
        isReturn: false,
        count: group.length,
        region: null,
      });
    }
    const kept = [...own.filter((e) => !collapsed.has(e)), ...bulks];
    pre.push(...own);
    events.push(...kept);

    for (const h of file.initial) replay.initial.push({ ...h, holder: unit(h.holder) });
    for (const s of file.sessions) replay.sessions.push({ ...s, owner: unit(s.owner)! });
    for (const m of file.measures) {
      replay.measures.push({
        name: m.name,
        start: m.start,
        end: m.end,
        value: m.value,
        currency: m.currency,
        region: regionOf(m.clientHint),
        unit: unit(m.actor),
        ...(m.label ? { label: m.label } : {}),
        ...(m.paidBy ? { paidBy: m.paidBy } : {}),
      });
    }
    for (const a of file.artifacts) {
      replay.artifacts.push({
        id: a.id,
        kind: a.kind,
        t: a.t,
        name: a.name,
        region: regionOf(a.clientHint),
        unit: unit(a.actor),
      });
    }
    for (const g of file.goals ?? []) {
      (replay.goals ??= []).push({ region: regionOf(g.clientHint), metric: g.metric, target: g.target });
    }
    for (const s of file.stock ?? []) {
      (replay.stock ??= []).push({ resource: s.resource, status: s.status, count: s.count, region: regionOf(s.clientHint) });
    }
    for (const b of file.busy ?? []) {
      const who = unit(b.actor);
      if (who) (replay.busy ??= []).push({ unit: who, kind: b.kind, start: b.start, end: b.end, meeting: b.meeting });
    }

    const before = emptyCounts();
    const after = emptyCounts();
    for (const e of own) before[e.kind]++;
    for (const e of kept) after[e.kind]++;
    const bulkCovered = bulks.reduce((sum, b) => sum + b.count, 0);
    const keys = listed.get(file)!;
    sourceReports.push({
      source: file.source,
      actors: file.actors.length,
      unmappedActors: registry ? file.actors.filter((a) => made.has(unitOf.get(a.key)!)).length : 0,
      before,
      after,
      bulkCovered,
      initial: file.initial.length,
      sessions: file.sessions.length,
      measures: file.measures.length,
      artifacts: file.artifacts.length,
      checks: [
        {
          label: 'pulled for the shared window',
          ok: file.window.start === window.start && file.window.end === window.end,
        },
        { label: 'every actor key used is listed in actors', ok: usedKeys(file).every((key) => keys.has(key)) },
        {
          label: 'create + comment + done + edit + bulk-covered = those events before the bulk rule',
          ok:
            after.create + after.comment + after.done + after.edit + bulkCovered ===
            before.create + before.comment + before.done + before.edit,
        },
        { label: 'sends and assigns untouched by the bulk rule', ok: after.send === before.send && after.assign === before.assign },
      ],
    });
  }

  pre.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.t - b.t);
  replay.sessions.sort((a, b) => a.start - b.start);
  replay.artifacts.sort((a, b) => a.t - b.t);
  replay.buildings = [...buildings.values()];

  const regionNames = new Map(regions.map((r) => [r.id, r.name]));
  const derived = new Map<string, { building: string; name: string; count: number; events: ReplayEvent[] }>();
  for (const e of events) {
    if (e.feature || !e.building || !buildings.has(e.building)) continue;
    let slug: string | null = null;
    let name = '';
    if (e.source === 'linear' && e.resourceId) slug = name = e.resourceId.split('-')[0];
    else if (e.source === 'github' && e.resourceId) slug = name = e.resourceId.split('#')[0];
    else if (e.source === 'slack' || e.source === 'notion') {
      slug = e.region ?? 'internal';
      name = e.region ? regionNames.get(e.region) ?? e.region : 'Internal';
    }
    if (!slug) continue;
    const id = `${e.building}/${slug}`;
    let entry = derived.get(id);
    if (!entry) derived.set(id, (entry = { building: e.building, name, count: 0, events: [] }));
    entry.count += e.count;
    entry.events.push(e);
  }
  const perBuilding = new Map<string, [string, { building: string; name: string; count: number; events: ReplayEvent[] }][]>();
  for (const item of derived) {
    if (!perBuilding.has(item[1].building)) perBuilding.set(item[1].building, []);
    perBuilding.get(item[1].building)!.push(item);
  }
  for (const [building, list] of perBuilding) {
    list.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    for (const [id, entry] of list) {
      if (!features.has(id)) features.set(id, { id, building, name: entry.name });
      for (const e of entry.events) e.feature = id;
    }
  }
  const tools = new Set(replay.sessions.map((s) => s.tool));
  if (buildings.has('claude')) {
    for (const tool of SESSION_TOOLS) {
      if (tools.has(tool)) features.set(`claude/${tool}`, { id: `claude/${tool}`, building: 'claude', name: TOOL_NAMES[tool] });
    }
  }
  replay.features = [...features.values()].filter((f) => buildings.has(f.building));
  replay.unmapped.clientHints = missedHints.size;

  const agents = new Map<string, Session[]>();
  for (const s of replay.sessions) {
    if (!AGENT_TOOLS.has(s.tool)) continue;
    if (!agents.has(s.owner)) agents.set(s.owner, []);
    agents.get(s.owner)!.push(s);
  }
  let bulkCredited = 0;
  let bulkUncredited = 0;
  for (const e of events) {
    if (e.kind !== 'bulk' || e.via !== null) continue;
    let via: string | null = null;
    let latest = -Infinity;
    for (const s of agents.get(e.actor) ?? []) {
      for (const [from, to] of s.active) {
        if (from - CREDIT_SLACK <= e.t && e.t <= to + CREDIT_SLACK && from > latest) {
          via = s.id;
          latest = from;
        }
      }
    }
    if (via) {
      e.via = via;
      bulkCredited++;
    } else bulkUncredited++;
  }

  const kindOf = new Map(units.map((u) => [u.id, u.kind]));
  const hand = (id: string) => kindOf.get(id) === 'person' || kindOf.get(id) === 'client';
  const before = [...tracing.others].filter((l) => l.held && l.window.start < window.start).sort((a, b) => b.window.start - a.window.start)[0];
  const carried = Object.entries(before?.held ?? {}).filter(([, [holder]]) => unitIds.has(holder));
  for (const [resourceId, [holder, t]] of carried) replay.initial.push({ resource: 'video', resourceId, holder, building: 'carried', t });
  const holding = new Map<string, string>(carried.map(([id, [holder]]) => [id, holder]));
  const held = new Map<string, Set<string>>();
  const passes: ReplayEvent[] = [];
  const take = (id: string, e: ReplayEvent) => {
    const from = holding.get(id);
    holding.set(id, e.actor);
    if (!held.has(id)) held.set(id, new Set());
    const before = held.get(id)!;
    if (from && from !== e.actor) {
      const trace = tracing.trace.get(`video:${id}`);
      passes.push({
        kind: 'send',
        t: e.t,
        source: e.source,
        actor: from,
        via: null,
        resource: 'video',
        resourceId: id,
        building: null,
        from,
        to: e.actor,
        isReturn: before.has(e.actor),
        count: 1,
        region: e.region,
        feature: null,
        ...(trace ? { trace } : {}),
      });
    }
    before.add(e.actor);
  };
  for (const e of [...pre].sort((a, b) => a.t - b.t)) {
    if (!e.resourceId || e.kind === 'send' || e.kind === 'assign' || !(hand(e.actor) || (e.kind === 'create' && e.resource === 'video'))) continue;
    if (e.resource === 'video') take(e.resourceId, e);
    if (e.kind === 'create' && hand(e.actor) && e.parent?.startsWith('video:') && e.parent !== `video:${e.resourceId}`) take(e.parent.slice(6), e);
  }
  pre.push(...passes);
  events.push(...passes);
  events.sort((a, b) => a.t - b.t);

  const helpers = new Map<string, Session[]>();
  for (const s of replay.sessions) {
    if (!helpers.has(s.owner)) helpers.set(s.owner, []);
    helpers.get(s.owner)!.push(s);
  }
  for (const e of events) {
    if (e.kind !== 'use' || e.via !== null || (e.source !== 'mcp' && !AGENT_BUILDINGS.has(e.building ?? ''))) continue;
    let latest = -Infinity;
    for (const s of helpers.get(e.actor) ?? []) {
      for (const [from, to] of s.active) {
        if (from - CREDIT_SLACK <= e.t && e.t <= to + CREDIT_SLACK && from > latest) {
          e.via = s.id;
          latest = from;
        }
      }
    }
  }

  const traced = finishTraces(tracing, pre, events, replay.artifacts, replay.sessions, sources.flatMap((file) => file.ended ?? []));
  const keeping = new Map<string, [string, number]>(carried.map(([id, [holder, last]]) => [id, [holder, last]]));
  for (const e of events) {
    if (e.resource !== 'video' || !e.resourceId) continue;
    let now = keeping.get(e.resourceId);
    if (now && e.t - now[1] > STALE_MS) {
      keeping.delete(e.resourceId);
      now = undefined;
    }
    if (e.kind === 'create') keeping.set(e.resourceId, [e.actor, e.t]);
    else if ((e.kind === 'send' || e.kind === 'assign') && e.to) keeping.set(e.resourceId, [e.to, e.t]);
    else if (e.kind === 'done') keeping.delete(e.resourceId);
    else if (now) now[1] = e.t;
  }
  traced.ledger.held = Object.fromEntries([...keeping].filter(([, [, last]]) => window.end - last <= STALE_MS));
  replay.traces = traced.traces;

  const unmapped: Unmapped = {
    actors: (registry ? loose : [])
      .map((a) => ({ key: a.key, source: sourceOf.get(a.key)!, events: actorEvents.get(a.key) ?? 0 }))
      .sort((a, b) => b.events - a.events || a.key.localeCompare(b.key)),
    clientHints: [...missedHints]
      .map((hint) => ({ hint, events: hintEvents.get(hint) ?? 0 }))
      .sort((a, b) => b.events - a.events || a.hint.localeCompare(b.hint)),
  };
  replay.weekly = pre.some((e) => e.resource === 'ticket') ? weeklyOf(pre, events, hintOf) : null;

  const regionIds = new Set(regions.map((r) => r.id));
  const refs = (e: ReplayEvent) => [e.actor, e.from, e.to].filter((id): id is string => id !== null);
  const checks: Check[] = [
    { label: 'every event refers to units by id', ok: events.every((e) => !!e.actor && refs(e).every((id) => unitIds.has(id))) },
    {
      label: 'every unit sits in a known region',
      ok: units.every((u) => regionIds.has(u.region)) && replay.buildings.every((b) => regionIds.has(b.region)),
    },
    {
      label: 'every session, holding, measure and artifact refers to units by id',
      ok:
        replay.sessions.every((s) => unitIds.has(s.owner)) &&
        replay.initial.every((h) => h.holder === null || unitIds.has(h.holder)) &&
        replay.measures.every((m) => m.unit === null || unitIds.has(m.unit)) &&
        replay.artifacts.every((a) => a.unit === null || unitIds.has(a.unit)),
    },
  ];

  return {
    replay,
    unmapped,
    ledger: traced.ledger,
    report: {
      sources: sourceReports,
      units: units.length,
      regions: regions.length,
      groups: groups.length,
      buildings: replay.buildings.length,
      events: events.length,
      sessions: replay.sessions.length,
      measures: replay.measures.length,
      artifacts: replay.artifacts.length,
      initial: replay.initial.length,
      unmapped: replay.unmapped,
      bulkCredited,
      bulkUncredited,
      repeats,
      links: parentOf.size,
      cycles,
      traces: traced.report,
      registry: !!registry,
      checks,
      ok: checks.every((c) => c.ok) && sourceReports.every((s) => s.checks.every((c) => c.ok)),
    },
  };
}

function weeklyOf(pre: ReplayEvent[], events: ReplayEvent[], hintOf: Map<ReplayEvent, string | null>): Weekly {
  const stats = new Map<string, PersonStats>();
  const stat = (id: string) => {
    if (!stats.has(id)) {
      stats.set(id, {
        id,
        in: 0,
        out: 0,
        returnsIn: 0,
        returnsOut: 0,
        holdMedianMs: null,
        holdP75Ms: null,
        holdSamples: 0,
        assignsGiven: 0,
        assignsReceived: 0,
        creates: 0,
        comments: 0,
        done: 0,
        edits: 0,
        bulkEvents: 0,
        bulkCovered: 0,
      });
    }
    return stats.get(id)!;
  };

  const byTeam = new Map<string, { team: string; handoffs: number; returns: number }>();
  const byResource = new Map(RESOURCES.map((resource) => [resource, { resource, sends: 0, returns: 0 }]));
  const pairs = new Map<string, { from: string; to: string; count: number; returns: number }>();
  const tickets = new Map<string, { issue: string; team: string; project: string | null; count: number }>();
  const projects = new Map<string, { project: string; handoffs: number; returns: number; issues: Set<string> }>();
  const touched = new Set<string>();
  const arrived = new Map<string, { holder: string; t: number }>();
  const lastSend = new Map<string, number>();
  const holdSamples = new Map<string, number[]>();
  const gaps: number[] = [];
  let handoffs = 0;
  let returns = 0;
  let activity = 0;

  for (const e of pre) {
    activity += e.count;
    for (const id of [e.actor, e.from, e.to]) if (id) stat(id);
    const ticket = e.resource === 'ticket' && e.resourceId ? e.resourceId : null;
    if (ticket) touched.add(ticket);
    const ret = e.isReturn ? 1 : 0;

    if (e.kind === 'send' && e.resource) {
      byResource.get(e.resource)!.sends++;
      byResource.get(e.resource)!.returns += ret;
    }
    if (e.kind === 'send' && ticket && e.from && e.to) {
      const cut = ticket.lastIndexOf('-');
      const team = cut > 0 ? ticket.slice(0, cut) : '?';
      const hint = hintOf.get(e) ?? null;
      const project = hint?.startsWith(PROJECT_HINT) ? hint.slice(PROJECT_HINT.length) : null;
      handoffs++;
      returns += ret;
      stat(e.from).out++;
      stat(e.to).in++;
      stat(e.from).returnsOut += ret;
      stat(e.to).returnsIn += ret;

      if (!byTeam.has(team)) byTeam.set(team, { team, handoffs: 0, returns: 0 });
      byTeam.get(team)!.handoffs++;
      byTeam.get(team)!.returns += ret;

      const pairKey = `${e.from}>${e.to}`;
      if (!pairs.has(pairKey)) pairs.set(pairKey, { from: e.from, to: e.to, count: 0, returns: 0 });
      pairs.get(pairKey)!.count++;
      pairs.get(pairKey)!.returns += ret;

      if (!tickets.has(ticket)) tickets.set(ticket, { issue: ticket, team, project, count: 0 });
      tickets.get(ticket)!.count++;

      if (project) {
        if (!projects.has(project)) projects.set(project, { project, handoffs: 0, returns: 0, issues: new Set() });
        const proj = projects.get(project)!;
        proj.handoffs++;
        proj.returns += ret;
        proj.issues.add(ticket);
      }

      const since = arrived.get(ticket);
      if (since && since.holder === e.from) {
        if (!holdSamples.has(e.from)) holdSamples.set(e.from, []);
        holdSamples.get(e.from)!.push(e.t - since.t);
      }
      if (lastSend.has(ticket)) gaps.push(e.t - lastSend.get(ticket)!);
      lastSend.set(ticket, e.t);
      arrived.set(ticket, { holder: e.to, t: e.t });
    } else if (e.kind === 'assign') {
      stat(e.actor).assignsGiven++;
      if (e.to) stat(e.to).assignsReceived++;
      if (ticket && e.to) arrived.set(ticket, { holder: e.to, t: e.t });
    } else if (e.kind === 'create') stat(e.actor).creates++;
    else if (e.kind === 'comment') stat(e.actor).comments++;
    else if (e.kind === 'done') stat(e.actor).done++;
    else if (e.kind === 'edit') stat(e.actor).edits++;
  }

  let bulkEvents = 0;
  let bulkCovered = 0;
  for (const e of events) {
    if (e.kind !== 'bulk') continue;
    bulkEvents++;
    bulkCovered += e.count;
    stat(e.actor).bulkEvents++;
    stat(e.actor).bulkCovered += e.count;
  }
  for (const [id, samples] of holdSamples) {
    const s = stat(id);
    s.holdMedianMs = quantile(samples, 0.5);
    s.holdP75Ms = quantile(samples, 0.75);
    s.holdSamples = samples.length;
  }

  return {
    totals: {
      handoffs,
      returns,
      returnShare: handoffs ? returns / handoffs : 0,
      ticketsTouched: touched.size,
      ticketsNoHandoff: touched.size - tickets.size,
      bulkEvents,
      bulkCovered,
      activity,
      bulkShare: activity ? bulkCovered / activity : 0,
    },
    byTeam: [...byTeam.values()].sort((a, b) => b.handoffs - a.handoffs || a.team.localeCompare(b.team)),
    byResource: [...byResource.values()],
    people: [...stats.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || a.id.localeCompare(b.id)),
    pairs: [...pairs.values()]
      .sort((a, b) => b.count - a.count || `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
      .slice(0, 12),
    tickets: [...tickets.values()].sort((a, b) => b.count - a.count || a.issue.localeCompare(b.issue)).slice(0, 8),
    projects: [...projects.values()]
      .map((p) => ({ project: p.project, handoffs: p.handoffs, returns: p.returns, tickets: p.issues.size }))
      .sort((a, b) => b.handoffs - a.handoffs || a.project.localeCompare(b.project))
      .slice(0, 10),
    betweenHandoffs: { medianMs: quantile(gaps, 0.5), p90Ms: quantile(gaps, 0.9), samples: gaps.length },
  };
}

export function printReport(report: Report) {
  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('Reconciliation');
  for (const s of report.sources) {
    console.log(`Source ${s.source}`);
    row('actors', s.actors);
    if (report.registry) row('  not in the registry', s.unmappedActors);
    for (const kind of Object.keys(s.before) as EventKind[]) {
      if (kind === 'bulk' && !s.before.bulk) row('bulk', s.after.bulk);
      else if (s.before[kind] === s.after[kind]) row(kind, s.after[kind]);
      else row(kind, `${s.before[kind]} > ${s.after[kind]}`);
    }
    row('events covered by bulk', s.bulkCovered);
    row('initial holdings', s.initial);
    row('sessions', s.sessions);
    row('measures', s.measures);
    row('artifacts', s.artifacts);
    for (const check of s.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
  }
  console.log('Replay');
  row('registry', report.registry ? 'yes' : 'none');
  row('events', report.events);
  row('units', report.units);
  row('regions', report.regions);
  row('groups', report.groups);
  row('buildings', report.buildings);
  row('initial holdings', report.initial);
  row('sessions', report.sessions);
  row('measures', report.measures);
  row('artifacts', report.artifacts);
  row('unmapped actors', report.unmapped.actors);
  row('unmapped client hints', report.unmapped.clientHints);
  row('bulk credited to a session', report.bulkCredited);
  row('bulk not credited', report.bulkUncredited);
  row('repeat creates of one resource dropped', report.repeats);
  row('resources hung under a parent', report.links);
  row('links refused as a cycle', report.cycles);
  for (const check of report.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
  const tr = report.traces;
  console.log('Concept traces');
  row('concepts declared this week', tr.concepts);
  row('traces active this week', tr.traces);
  row('  with any descendant', tr.withDescendants);
  for (const [stage, n] of Object.entries(tr.byStage)) row(`  furthest stage ${stage}`, n);
  for (const [stage, n] of Object.entries(tr.reached)) row(`  reaching ${stage}`, n);
  row('events stamped with a trace', tr.stamped);
  row('  kept after the bulk rule', tr.stampedKept);
  row('lineage links considered', tr.lineage.considered);
  row('lineage resources joined', tr.lineage.joined);
  row('lineage links refused as a hub', tr.lineage.hubs);
  row('lineage links of a type never joined', tr.lineage.ignored);
}
