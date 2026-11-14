import { TRACE_STAGES, type Artifact, type ReplayEvent, type Session, type SourceFile, type SourceLink, type Trace, type TraceStage, type Window } from '../../src/schema';
import { buildTraces, originsOf, resolveLineage, traceable, unionLedgers, type Ledger, type Lineage, type Step } from './lineage';
import { weekId } from './window';

export interface TraceReport {
  concepts: number;
  withDescendants: number;
  byStage: Record<TraceStage, number>;
  reached: Record<TraceStage, number>;
  stamped: number;
  stampedKept: number;
  traces: number;
  lineage: Lineage['counts'];
}

export interface Tracing {
  ledger: Ledger;
  others: Ledger[];
  lineage: Lineage;
  trace: Map<string, string>;
}

const keyOf = (e: { resource: string | null; resourceId: string | null }) => (e.resource && e.resourceId ? `${e.resource}:${e.resourceId}` : null);

export function startTraces(
  window: Window,
  sources: SourceFile[],
  hooks: SourceLink[],
  others: Ledger[],
  who: (key: string | null) => string | null,
  region: (hint: string | null) => string | null,
): Tracing {
  const id = weekId(window);
  const ledger: Ledger = {
    id,
    window,
    links: hooks.map((l) => ({ parent: l.parent, child: l.child, t: l.t, ...(l.name ? { name: l.name } : {}) })),
    concepts: sources.flatMap((file) => [
      ...(file.concepts ?? []).map((c) => ({ id: c.id, name: c.name, t: c.t, actor: who(c.actor), region: region(c.clientHint), ...(c.from ? { from: c.from } : {}) })),
      ...file.artifacts.flatMap((a) => (a.kind === 'client_winner' && region(a.clientHint) ? [{ id: a.id, name: a.name, t: a.t, actor: null, region: region(a.clientHint) }] : [])),
    ]),
    steps: [],
    names: {},
    owners: {},
    urls: Object.assign({}, ...sources.map((file) => file.urls ?? {})),
  };
  const rest = others.filter((l) => l.id !== id);
  const all = unionLedgers([...rest, ledger]);
  const lineage = resolveLineage(all.links, new Set(all.concepts.keys()), originsOf(all.concepts));
  return { ledger, others: rest, lineage, trace: lineage.trace };
}

export const traceOf = (tracing: Tracing, e: { resource: string | null; resourceId: string | null }) => {
  const key = keyOf(e);
  return key ? tracing.trace.get(key) : undefined;
};

export function finishTraces(tracing: Tracing, pre: ReplayEvent[], events: ReplayEvent[], artifacts: Artifact[], sessions: Session[], ended: { id: string; t: number }[] = []) {
  const { ledger, window } = { ledger: tracing.ledger, window: tracing.ledger.window };
  const steps: Step[] = [];
  const vias = new Set<string>();
  for (const e of pre) {
    const key = keyOf(e);
    if (!key || !traceable(key)) continue;
    steps.push([e.t, e.kind, e.source, key, e.actor ?? null, e.via, e.building]);
    if (e.via) vias.add(e.via);
  }
  for (const a of artifacts) steps.push([a.t, a.kind === 'creative' ? 'create' : 'done', 'money', a.id, a.unit, null, null]);
  for (const e of ended) steps.push([e.t, 'status', 'money', e.id, null, null, null]);
  ledger.steps = steps.sort((a, b) => a[0] - b[0] || a[3].localeCompare(b[3]));
  for (const a of artifacts) ledger.names[a.id] = a.name;
  for (const s of sessions) if (vias.has(s.id)) ledger.owners[s.id] = s.owner;

  const { traces } = buildTraces([...tracing.others, ledger]);
  const inWeek = (t: number) => t >= window.start && t < window.end;
  const week = traces.filter((tr) => inWeek(tr.t) || tr.steps.some((s) => inWeek(s.t)));
  const stage = Object.fromEntries(TRACE_STAGES.map((s) => [s, 0])) as Record<TraceStage, number>;
  const reached = { ...stage };
  for (const tr of week) {
    stage[tr.stage]++;
    for (const s of new Set(tr.nodes.map((n) => n.stage))) reached[s]++;
  }
  const report: TraceReport = {
    concepts: ledger.concepts.filter((c) => !c.id.startsWith('client_winner:')).length,
    withDescendants: week.filter((tr) => tr.nodes.length > 1).length,
    byStage: stage,
    reached,
    stamped: pre.filter((e) => e.trace).length,
    stampedKept: events.filter((e) => e.trace).length,
    traces: week.length,
    lineage: tracing.lineage.counts,
  };
  return { traces: week as Trace[], ledger, report };
}
