import { sites, urlOf } from '../../src/links';
import { TRACE_STAGES, type EventKind, type SourceLink, type SourceName, type Trace, type TraceNode, type TraceStage, type TraceStep, type Window } from '../../src/schema';
import { config } from './config';

export type Step = [t: number, kind: EventKind, source: SourceName, key: string, actor: string | null, via: string | null, building: string | null];

export interface LedgerConcept {
  id: string;
  name: string;
  t: number;
  actor: string | null;
  region: string | null;
  from?: string;
}

export interface Ledger {
  id: string;
  window: Window;
  links: SourceLink[];
  concepts: LedgerConcept[];
  steps: Step[];
  names: Record<string, string>;
  owners: Record<string, string>;
  urls?: Record<string, string>;
  live?: Record<string, number[]>;
  held?: Record<string, [holder: string, last: number]>;
}

const CHILDREN: Record<string, Set<string>> = {
  ticket: new Set(['ticket', 'page', 'board', 'video', 'image', 'row']),
  page: new Set(['board', 'video', 'image']),
  board: new Set(['video', 'image']),
  video: new Set(['video', 'row']),
  image: new Set(['row']),
  row: new Set(['row', 'taxonomy']),
  taxonomy: new Set(['taxonomy', 'ad']),
  ad: new Set(['creative', 'winning_ad']),
  client_winner: new Set(['ad']),
};
const MEMBERS = new Set(['ticket', 'page', 'board', 'video', 'image', 'row', 'taxonomy', 'ad', 'creative', 'winning_ad', 'client_winner']);
Object.assign(sites, { linear: config.linear.workspace, github: config.github.org, slack: config.slack.workspace });

const TEAM = `ticket:${config.linear.conceptTeam ?? ''}-`;
const HUB = 3;
const JOIN = /^(?:taxonomy:.+|row:sheet:.+)$/;

export const typeOf = (key: string) => key.slice(0, key.indexOf(':'));
export const traceable = (key: string) => MEMBERS.has(typeOf(key));
const rank = (stage: TraceStage) => TRACE_STAGES.indexOf(stage);

export interface Lineage {
  trace: Map<string, string>;
  parent: Map<string, string>;
  linked: Map<string, number>;
  counts: { considered: number; joined: number; hubs: number; ignored: number };
}

const number = (key: string) => Number(key.slice(key.lastIndexOf('-') + 1));
const later = (p: string, c: string) => typeOf(c) !== 'ticket' || (c.startsWith(TEAM) && p.startsWith(TEAM) && number(c) > number(p));

export function resolveLineage(links: SourceLink[], concepts: Set<string>, origins: Set<string> = new Set()): Lineage {
  const counts = { considered: 0, joined: 0, hubs: 0, ignored: 0 };
  const allowed = (p: string, c: string) => !!CHILDREN[typeOf(p)]?.has(typeOf(c)) && later(p, c) && !origins.has(`${p}>${c}`);
  const sorted = [...links].sort((a, b) => a.t - b.t || a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));
  const parents = new Map<string, Set<string>>();
  for (const l of sorted) {
    if (!allowed(l.parent, l.child) || typeOf(l.parent) !== 'ticket') continue;
    if (!parents.has(l.child)) parents.set(l.child, new Set());
    parents.get(l.child)!.add(l.parent);
  }
  const hub = (key: string) => (parents.get(key)?.size ?? 0) > HUB;
  const trace = new Map<string, string>([...concepts].map((c) => [c, c]));
  const parent = new Map<string, string>();
  const linked = new Map<string, number>();
  const edges = new Map<string, { child: string; t: number }[]>();
  const join = (child: string, from: string, root: string, t: number) => {
    const stack = [{ child, from, t }];
    while (stack.length) {
      const next = stack.pop()!;
      if (trace.has(next.child) || concepts.has(next.child)) continue;
      trace.set(next.child, root);
      parent.set(next.child, next.from);
      linked.set(next.child, next.t);
      counts.joined++;
      for (const e of edges.get(next.child) ?? []) stack.push({ child: e.child, from: next.child, t: e.t });
    }
  };
  for (const l of sorted) {
    if (l.parent === l.child || concepts.has(l.child)) continue;
    if (!allowed(l.parent, l.child)) {
      if (traceable(l.parent) && traceable(l.child)) counts.ignored++;
      continue;
    }
    counts.considered++;
    if (hub(l.child)) {
      counts.hubs++;
      continue;
    }
    if (!edges.has(l.parent)) edges.set(l.parent, []);
    edges.get(l.parent)!.push({ child: l.child, t: l.t });
    const root = trace.get(l.parent);
    if (root && !trace.has(l.child)) join(l.child, l.parent, root, l.t);
  }
  return { trace, parent, linked, counts };
}

function stageOf(key: string, up: TraceStage | null): TraceStage {
  switch (typeOf(key)) {
    case 'ticket':
      return up === null ? 'concept' : 'edit';
    case 'page':
      return 'brief';
    case 'board':
      return 'board';
    case 'video':
      if (key.startsWith('video:frameio:')) return 'review';
      return up === 'edit' || up === 'review' ? up : 'asset';
    case 'image':
      return up === 'edit' ? 'edit' : 'asset';
    case 'row':
    case 'taxonomy':
      return 'row';
    case 'ad':
    case 'creative':
      return up === 'client_winner' ? 'client_winner' : 'ad';
    case 'winning_ad':
      return 'winner';
    case 'client_winner':
      return 'client_winner';
    default:
      return up ?? 'concept';
  }
}

export function unionLedgers(ledgers: Ledger[]) {
  const sorted = [...ledgers].sort((a, b) => a.window.start - b.window.start || a.id.localeCompare(b.id));
  const links = new Map<string, SourceLink>();
  const concepts = new Map<string, LedgerConcept>();
  const names = new Map<string, string>();
  const owners = new Map<string, string>();
  const urls = new Map<string, string>();
  const live = new Map<string, number[]>();
  const steps = new Map<string, Step>();
  for (const ledger of sorted) {
    for (const l of ledger.links) {
      const id = `${l.parent}>${l.child}`;
      const kept = links.get(id);
      if (!kept || l.t < kept.t) links.set(id, { ...l, name: kept?.name ?? l.name });
      if (l.name && !names.has(l.child)) names.set(l.child, l.name);
    }
    for (const c of ledger.concepts) {
      const kept = concepts.get(c.id);
      if (!kept) concepts.set(c.id, c);
      else concepts.set(c.id, { ...kept, name: kept.name === kept.id.slice(7) ? c.name : kept.name, actor: kept.actor ?? c.actor, region: kept.region ?? c.region, from: kept.from ?? c.from });
    }
    for (const [key, name] of Object.entries(ledger.names)) if (!names.has(key)) names.set(key, name);
    for (const [id, owner] of Object.entries(ledger.owners)) owners.set(id, owner);
    for (const [key, url] of Object.entries(ledger.urls ?? {})) urls.set(key, url);
    for (const [key, flips] of Object.entries(ledger.live ?? {})) if (flips.length >= (live.get(key)?.length ?? 0)) live.set(key, flips);
    for (const s of ledger.steps) steps.set(s.join('\u0001'), s);
  }
  return { links: [...links.values()], concepts, names, owners, urls, live, steps: [...steps.values()] };
}

export const originsOf = (concepts: Map<string, LedgerConcept>) => new Set([...concepts.values()].flatMap((c) => (c.from ? [`${c.id}>${c.from}`] : [])));

export function buildTraces(ledgers: Ledger[]) {
  const all = unionLedgers(ledgers);
  const lineage = resolveLineage(all.links, new Set(all.concepts.keys()), originsOf(all.concepts));
  const byKey = new Map<string, Step[]>();
  for (const s of all.steps) {
    if (!lineage.trace.has(s[3])) continue;
    if (!byKey.has(s[3])) byKey.set(s[3], []);
    byKey.get(s[3])!.push(s);
  }
  const members = new Map<string, string[]>();
  for (const [key, root] of lineage.trace) {
    if (!members.has(root)) members.set(root, []);
    members.get(root)!.push(key);
  }
  const traces: Trace[] = [];
  for (const [id, concept] of all.concepts) {
    const keys = members.get(id) ?? [id];
    const kids = new Map<string, string[]>();
    for (const key of keys) {
      const up = lineage.parent.get(key);
      if (!up) continue;
      if (!kids.has(up)) kids.set(up, []);
      kids.get(up)!.push(key);
    }
    const nodes: TraceNode[] = [];
    const stages = new Map<string, TraceStage>();
    const walk = (key: string, up: string | null, upStage: TraceStage | null) => {
      const children = (kids.get(key) ?? []).sort();
      const stage = stageOf(key, upStage);
      if (up !== null && JOIN.test(key) && children.length) {
        for (const child of children) walk(child, up, upStage);
        return;
      }
      if (up !== null && JOIN.test(key) && key.startsWith('taxonomy:')) return;
      stages.set(key, stage);
      const seen = byKey.get(key)?.map((s) => s[0]) ?? [];
      const t = key === id ? concept.t : seen.length ? Math.min(...seen) : lineage.linked.get(key) ?? concept.t;
      const url = urlOf(key, all.urls);
      const on = all.live.get(key);
      nodes.push({ key, parent: up, stage, t, name: key === id ? concept.name : all.names.get(key) ?? (typeOf(key) === 'ticket' ? key.slice(7) : null), ...(url ? { url } : {}), ...(on ? { on } : {}) });
      for (const child of children) walk(child, key, stage);
    };
    walk(id, null, null);
    const origin = concept.from ? lineage.trace.get(concept.from) : undefined;
    const source = origin && origin !== id && typeOf(origin) === 'client_winner' ? all.concepts.get(origin) : undefined;
    if (source) nodes.push({ key: source.id, parent: null, stage: 'client_winner', t: source.t, name: source.name });
    nodes.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
    const steps: TraceStep[] = [...stages.keys()]
      .flatMap((key) => (byKey.get(key) ?? []).map(([t, kind, source, k, actor, via, building]) => ({ t, stage: stages.get(key)!, kind, source, key: k, actor, via, building })))
      .sort((a, b) => a.t - b.t || a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || (a.actor ?? '').localeCompare(b.actor ?? ''));
    const hands: string[] = [];
    const touch = (unit: string | null | undefined) => {
      if (unit && !hands.includes(unit)) hands.push(unit);
    };
    if (!steps.some((s) => s.key === id && s.kind === 'create')) touch(concept.actor);
    for (const s of steps) {
      touch(s.actor);
      if (s.via) touch(all.owners.get(s.via));
    }
    const stage = nodes.reduce<TraceStage>((best, n) => (rank(n.stage) > rank(best) ? n.stage : best), stages.get(id) ?? 'concept');
    traces.push({
      id,
      name: concept.name,
      region: concept.region,
      t: concept.t,
      stage,
      hands,
      nodes,
      steps,
      ...(concept.from ? { from: concept.from } : {}),
    });
  }
  traces.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return { traces, lineage, links: all.links.length };
}
