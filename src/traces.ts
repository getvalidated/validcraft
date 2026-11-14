import type { App, Pick } from './app';
import type { Shelf } from './cargo';
import { esc, fmtDate, fmtDuration } from './format';
import { glyph, resourceGlyph } from './icons';
import { urlOf } from './links';
import { COLORS, RESOURCE_LABELS, TYPES } from './palette';
import { TRACE_STAGES, type EventKind, type ResourceType, type Trace, type TraceNode, type TraceStage, type TraceStep } from './schema';

export interface TraceFocus {
  id: string;
  app: App;
  hands: Set<string>;
  buildings: Set<string>;
}

export const LABELS: Record<TraceStage, string> = { client_winner: 'Client winner', concept: 'Concept', brief: 'Brief', board: 'Board', asset: 'Asset', edit: 'Edit', review: 'Review', row: 'Sheet row', ad: 'Ad', winner: 'Winner' };
const HELP: Record<TraceStage, string> = {
  client_winner: 'a winning ad the client made that the concept grew out of',
  concept: 'the Linear ticket that holds the idea',
  brief: 'a written brief for it',
  board: 'a board built from it',
  asset: 'videos, images and frame uploads made from the boards',
  edit: 'edited cuts',
  review: 'uploads sent out for review',
  row: 'rows in the tracking sheet',
  ad: 'ads launched from those rows',
  winner: 'ads that became winners',
};
const ONE: Record<TraceStage, string> = { client_winner: 'a client winner', concept: 'the concept', brief: 'the brief', board: 'a board', asset: 'an asset', edit: 'an edit', review: 'a review upload', row: 'a sheet row', ad: 'an ad', winner: 'a winner' };
const MANY: Record<TraceStage, string> = { client_winner: 'client winners', concept: 'concepts', brief: 'briefs', board: 'boards', asset: 'assets', edit: 'edits', review: 'review uploads', row: 'sheet rows', ad: 'ads', winner: 'winners' };
const VERBS: Record<EventKind, string> = { create: 'made', send: 'handed on', assign: 'assigned', comment: 'commented on', done: 'finished', edit: 'edited', bulk: 'bulk edited', use: 'used', run: 'ran', error: 'hit an error on', status: 'switched' };
const LIST_STEP = 40;
const STEP_CAP = 60;
const RUN_GAP = 2 * 3_600_000;
const PAIR_GAP = 5 * 60_000;
const NO_CLIENT = '-';
const HAND_CAP = 12;
const ROW_CAP = 8;
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
const rank = (stage: TraceStage) => TRACE_STAGES.indexOf(stage);
const ticketOf = (id: string) => id.slice(id.indexOf(':') + 1);
const typeOf = (key: string) => key.slice(0, key.indexOf(':'));
const fromOf = (t: Trace) => (t as Trace & { from?: string }).from ?? null;
const isClient = (t: Trace) => t.id.startsWith('client_winner:');
const tagOf = (t: Trace) => (isClient(t) ? 'client winner' : ticketOf(t.id));

function nodeName(key: string, name: string | null) {
  if (name) return name;
  const type = typeOf(key);
  const rest = key.slice(type.length + 1);
  if (type === 'ticket' || type === 'taxonomy') return rest;
  const parts = rest.split(/[/:]/).filter(Boolean);
  if (type === 'ad' && parts.length > 1) return `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)} ad ${parts[parts.length - 1].slice(-8)}`;
  const where = rest.startsWith('frameio:') ? 'Frame.io ' : rest.includes('uploads.linear.app') ? 'Linear upload ' : rest.startsWith('drive:') ? 'Drive ' : '';
  return `${where}${RESOURCE_LABELS[type as ResourceType] ?? type} ${(parts[parts.length - 1] ?? rest).replace(/\.\w+$/, '').slice(0, 8)}`;
}

export async function loadTraces(): Promise<Trace[] | null> {
  try {
    const res = await fetch('/data/library/traces.json', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

let focused: TraceFocus | null = null;

export function traceFocus(app: App): TraceFocus | null {
  const pick = app.view.picked;
  if (pick?.kind !== 'trace') return null;
  if (focused?.id === pick.id && focused.app === app) return focused;
  const trace = app.traces.find((t) => t.id === pick.id);
  if (!trace) return null;
  const hands = new Set([...trace.hands, ...trace.steps.map((s) => s.actor ?? '')].filter((id) => app.layout.index.has(id)));
  const buildings = new Set(trace.steps.flatMap((s) => (s.building ? [s.building] : [])));
  focused = { id: trace.id, app, hands, buildings };
  return focused;
}

export function createTraces(app: App, root: HTMLElement) {
  const { world: data, layout } = app;
  const every = app.traces;
  const traces = every.filter((t) => !isClient(t));
  const clientWins = every.filter(isClient);
  const byId = new Map(every.map((t) => [t.id, t]));
  const byKey = new Map<string, Trace>();
  for (const t of every) for (const n of t.nodes) if (!byKey.has(n.key)) byKey.set(n.key, byId.get(n.key) ?? t);
  const units = new Map(data.units.map((u) => [u.id, u]));
  const regionNames = new Map(data.regions.map((r) => [r.id, r.name]));
  const iterations = new Map<string, Trace[]>();
  for (const t of traces) {
    const from = fromOf(t);
    const origin = from ? (byId.get(from) ?? byKey.get(from)) : undefined;
    if (origin && origin !== t) iterations.set(origin.id, [...(iterations.get(origin.id) ?? []), t]);
  }
  const lastOf = new Map(every.map((t) => [t.id, t.steps.reduce((m, s) => Math.max(m, s.t), t.t)]));
  const stagesOf = new Map(every.map((t) => [t.id, new Set(t.nodes.map((n) => n.stage))]));
  const touched = new Map<string, Map<string, Map<TraceStage, number>>>();
  for (const t of traces) {
    for (const s of t.steps) {
      if (!s.actor) continue;
      let mine = touched.get(s.actor);
      if (!mine) touched.set(s.actor, (mine = new Map()));
      let stages = mine.get(t.id);
      if (!stages) mine.set(t.id, (stages = new Map()));
      stages.set(s.stage, (stages.get(s.stage) ?? 0) + 1);
    }
    for (const h of t.hands) {
      let mine = touched.get(h);
      if (!mine) touched.set(h, (mine = new Map()));
      if (!mine.has(t.id)) mine.set(t.id, new Map());
    }
  }
  const people = [...touched.entries()].map(([id, list]) => ({ id, n: list.size })).sort((a, b) => b.n - a.n || nameOf(a.id).localeCompare(nameOf(b.id)));
  const clients = [...new Set(every.map((t) => t.region ?? NO_CLIENT))].sort((a, b) => Number(a === NO_CLIENT) - Number(b === NO_CLIENT) || clientName(a).localeCompare(clientName(b)));
  const filters = { region: '', stage: '', reached: '', who: '', sort: 'recent', cap: LIST_STEP };
  const opened = new Set<string>();
  let items: { id: string; stage: TraceStage } | null = null;
  const float = document.createElement('aside');
  float.id = 'trace-items';
  float.hidden = true;
  document.getElementById('app')?.appendChild(float);
  let held: { id: string; type: ResourceType } | null = null;
  let shelf: { id: string; which: Shelf } | null = null;
  const NONE = new Map<string, string>();
  const urlByKey = new Map<string, string>();
  const nameByKey = new Map<string, string>();
  for (const t of every) {
    for (const n of t.nodes) {
      if (n.url && !urlByKey.has(n.key)) urlByKey.set(n.key, n.url);
      if (n.name && !nameByKey.has(n.key)) nameByKey.set(n.key, n.name);
    }
  }
  const paintItems = () => {
    const trace = items ? byId.get(items.id) : undefined;
    const html = trace ? itemsCard(trace, items!.stage) : held ? heldCard(held.id, held.type) : shelf ? shelfCard(shelf.id, shelf.which) : '';
    float.hidden = !html;
    float.innerHTML = html;
  };

  function nameOf(id: string) {
    const known = units.get(id)?.name;
    if (known) return known;
    const bare = id.replace(/^u:/, '');
    const mail = bare.match(/([^:@]+)@/);
    if (mail) return mail[1].charAt(0).toUpperCase() + mail[1].slice(1);
    const parts = bare.split(':');
    return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1].slice(-6)}` : bare;
  }

  function clientName(id: string | null) {
    return id ? app.regionName(id, regionNames.get(id) ?? id.replace(/^c:/, 'client ')) : 'no client';
  }

  const person = (id: string | null) =>
    !id ? '<span class="ghost">no one</span>' : layout.index.has(id) ? `<a class="who" data-id="${esc(id)}" title="${esc(nameOf(id))}">${esc(nameOf(id))}</a>` : `<span class="ghost" title="${esc(id)} is not on the map">${esc(nameOf(id))}</span>`;
  const client = (id: string | null) => (id && regionNames.has(id) && layout.regions.some((r) => r.id === id) ? `<a class="who" data-id="${esc(id)}">${esc(clientName(id))}</a>` : esc(clientName(id)));
  const shown = (t: Trace, text = t.name) => app.redact(text, t.region);
  const link = (t: Trace) => `<a class="who" data-id="${esc(t.id)}" title="${esc(`${tagOf(t)} ${shown(t)}`)}">${esc(shown(t))}</a>`;
  const when = (t: number) => `${fmtDate(t)}, ${timeFormat.format(t)}`;
  const away = (t: number) => t < app.start || t >= app.end;
  const after = (trace: Trace, t: number) => (t <= trace.t ? 'at once' : `+${fmtDuration(t - trace.t)}`);

  function icon(key: string) {
    const type = typeOf(key);
    if (type === 'winning_ad') return glyph('star', COLORS.trophy).replace('<svg ', '<svg data-tip="winning ad" ');
    if (type === 'creative') return glyph('star', COLORS.bg, COLORS.trophy, 1.5).replace('<svg ', '<svg data-tip="creative launched" ');
    return TYPES.includes(type as ResourceType) ? resourceGlyph(type as ResourceType) : glyph('circle', COLORS.neutral);
  }

  function reached(trace: Trace) {
    const first = new Map<TraceStage, { t: number; n: number }>();
    for (const n of trace.nodes) {
      const at = first.get(n.stage);
      first.set(n.stage, { t: Math.min(at?.t ?? Infinity, n.t), n: (at?.n ?? 0) + 1 });
    }
    return first;
  }

  function strip(trace: Trace, big = false) {
    const got = reached(trace);
    const top = rank(trace.stage);
    return `<span class="tr-strip${big ? ' big' : ''}" aria-label="got to ${LABELS[trace.stage]}">${TRACE_STAGES.map((stage, i) => {
      const state = got.has(stage) ? (stage === 'winner' ? 'win' : stage === 'client_winner' ? 'cw' : 'on') : i < top && stage !== 'client_winner' ? 'skip' : 'off';
      return `<i class="${state}" data-tip="${LABELS[stage]}: ${stage === 'client_winner' ? (got.has(stage) ? (isClient(trace) ? 'a winning ad the client made' : 'grew out of a winning ad the client made') : 'did not grow out of one') : got.has(stage) ? `${got.get(stage)!.n} reached ${after(trace, got.get(stage)!.t)} after the concept` : i < top ? 'skipped' : 'not reached'}"></i>`;
    }).join('')}</span>`;
  }

  function funnel(list: Trace[], pickable: boolean, wins: Trace[]) {
    const grown = new Set(wins.flatMap((w) => iterations.get(w.id) ?? []));
    const counts = TRACE_STAGES.map((stage) => (stage === 'client_winner' ? wins.length : 0) + list.filter((t) => t.nodes.some((n) => n.stage === stage) && !(stage === 'client_winner' && grown.has(t))).length);
    const stopped = TRACE_STAGES.map((stage) => (stage === 'client_winner' ? wins.filter((w) => !iterations.get(w.id)?.length).length : 0) + list.filter((t) => t.stage === stage).length);
    const total = list.length || 1;
    return `<div class="funnel">${TRACE_STAGES.map((stage, i) => {
      const tag = pickable ? 'button' : 'div';
      const tip = stage === 'client_winner' ? `${counts[i]} winning ${counts[i] === 1 ? 'ad' : 'ads'} the client made. ${stopped[i]} went no further: no concept has grown out of ${stopped[i] === 1 ? 'it' : 'them'} yet` : `${counts[i]} of ${list.length} reached ${LABELS[stage].toLowerCase()}: ${HELP[stage]}${stage === 'winner' ? '' : `. ${stopped[i]} went no further`}`;
      return `<${tag} class="fun${pickable && filters.reached === stage ? ' on' : ''}"${pickable ? ` data-trace-stage="${stage}"` : ''} title="${esc(tip)}"><span>${LABELS[stage]}</span><span class="bar"><i class="${stage === 'winner' ? 'win' : stage === 'client_winner' ? 'cw' : ''}" style="width:${Math.min(100, (counts[i] / total) * 100).toFixed(1)}%"></i></span><b>${counts[i]}</b><small>${stopped[i] && stage !== 'winner' ? `${stopped[i]} stopped` : ''}</small></${tag}>`;
    }).join('')}</div>`;
  }

  function visible() {
    const list = (filters.reached === 'client_winner' ? every : traces).filter(
      (t) => (!filters.region || (t.region ?? NO_CLIENT) === filters.region) && (!filters.who || touched.get(filters.who)?.has(t.id)) && (!filters.stage || t.stage === filters.stage) && (!filters.reached || stagesOf.get(t.id)!.has(filters.reached as TraceStage)),
    );
    return list.sort((a, b) => (filters.sort === 'far' ? rank(b.stage) - rank(a.stage) : 0) || lastOf.get(b.id)! - lastOf.get(a.id)!);
  }

  function row(t: Trace) {
    const on = app.view.picked?.kind === 'trace' && app.view.picked.id === t.id;
    return `<button class="trace-row${on ? ' on' : ''}" data-trace="${esc(t.id)}">
      <span class="tr-name">${esc(shown(t))}</span>${strip(t)}
      <small>${esc(tagOf(t))}${fromOf(t) ? ` · iteration of ${esc(typeOf(fromOf(t)!) === 'ticket' ? ticketOf(fromOf(t)!) : 'an ad')}` : ''} · ${esc(clientName(t.region))} · ${t.hands.length} ${t.hands.length === 1 ? 'person' : 'people'} · ${fmtDate(t.t)}${fmtDate(lastOf.get(t.id)!) !== fmtDate(t.t) ? ` to ${fmtDate(lastOf.get(t.id)!)}` : ''}</small>
    </button>`;
  }

  function listBody() {
    const pool = traces.filter((t) => (!filters.region || (t.region ?? NO_CLIENT) === filters.region) && (!filters.who || touched.get(filters.who)?.has(t.id)));
    const list = visible();
    const shown = list.slice(0, filters.cap);
    const option = (value: string, text: string, now: string) => `<option value="${esc(value)}"${value === now ? ' selected' : ''}>${esc(text)}</option>`;
    return `${funnel(pool, true, filters.who ? [] : clientWins.filter((t) => !filters.region || (t.region ?? NO_CLIENT) === filters.region))}
      <p class="note">Bars: how many concepts reached each stage; many skip some. Client winner counts the winning ads the client made, whether or not a concept has grown out of them. Click a stage to list the ones that reached it.</p>
      <div class="tr-filters">
        <select data-trace-filter="region" aria-label="Client">${option('', 'All clients', filters.region)}${clients.map((id) => option(id, clientName(id === NO_CLIENT ? null : id), filters.region)).join('')}</select>
        <select data-trace-filter="stage" aria-label="Furthest stage">${option('', 'Any furthest stage', filters.stage)}${TRACE_STAGES.filter((stage) => stage !== 'client_winner').map((stage) => option(stage, `Stopped at ${LABELS[stage].toLowerCase()}`, filters.stage)).join('')}</select>
        <select data-trace-filter="who" aria-label="Person">${option('', 'Anyone', filters.who)}${people.map((p) => option(p.id, `${nameOf(p.id)} (${p.n})`, filters.who)).join('')}</select>
        <select data-trace-filter="sort" aria-label="Sort">${option('recent', 'Latest activity first', filters.sort)}${option('far', 'Furthest first', filters.sort)}</select>
      </div>
      <p class="note">${filters.reached === 'client_winner' ? `${list.length} client winners and concepts grown out of them` : `${list.length === traces.length ? `${list.length} concepts` : `${list.length} of ${traces.length} concepts`}${filters.reached ? ` that reached ${LABELS[filters.reached as TraceStage].toLowerCase()}` : ''}`}${filters.region || filters.stage || filters.reached || filters.who ? ' · <a class="tr-reset">clear filters</a>' : ''}</p>
      <div class="trace-list">${shown.map(row).join('') || '<p class="note">No concept matches.</p>'}</div>
      ${list.length > shown.length ? `<button class="tr-more" data-trace-more>Show ${Math.min(LIST_STEP, list.length - shown.length)} more of ${list.length - shown.length}</button>` : ''}`;
  }

  function list() {
    if (!traces.length) return '';
    return `<section id="traces" class="traces"><h2>Concepts</h2><p class="note">A concept is a Linear ticket with a creative idea. Its trace follows everything made from it, from brief and boards to sheet rows, live ads and winners.</p><div id="trace-body">${listBody()}</div></section>`;
  }

  function did(trace: Trace, id: string) {
    const groups = new Map<string, { kind: EventKind; stage: TraceStage; keys: Set<string>; n: number }>();
    for (const s of trace.steps) {
      if (s.actor !== id) continue;
      const k = `${s.kind}|${s.stage}`;
      const g = groups.get(k) ?? { kind: s.kind, stage: s.stage, keys: new Set<string>(), n: 0 };
      g.keys.add(s.key);
      g.n++;
      groups.set(k, g);
    }
    const parts = [...groups.values()].sort((a, b) => rank(a.stage) - rank(b.stage) || Number(b.kind === 'create') - Number(a.kind === 'create') || b.n - a.n).map((g) => `${VERBS[g.kind]} ${g.keys.size === 1 ? ONE[g.stage] : `${g.keys.size} ${MANY[g.stage]}`}${g.n > g.keys.size ? ` ×${g.n}` : ''}`);
    return parts.join(' · ') || 'was handed it';
  }

  function hands(trace: Trace) {
    const first = new Map<string, TraceStep>();
    for (const s of trace.steps) if (s.actor && !first.has(s.actor)) first.set(s.actor, s);
    const items = trace.hands.map((id, i) => {
      const s = first.get(id);
      return `<li><span class="hand-n">${i + 1}</span><div>${person(id)}${s ? ` <small>joined at ${LABELS[s.stage].toLowerCase()} · ${fmtDate(s.t)}</small>` : ''}<div class="did">${esc(did(trace, id))}</div></div></li>`;
    });
    const head = items.slice(0, HAND_CAP).join('');
    const rest = items.slice(HAND_CAP);
    return `<ol class="hands">${head}</ol>${rest.length ? `<details><summary>${rest.length} more ${rest.length === 1 ? 'person' : 'people'}</summary><ol class="hands" start="${HAND_CAP + 1}">${rest.join('')}</ol></details>` : ''}`;
  }

  function tree(trace: Trace) {
    const keys = new Set(trace.nodes.map((n) => n.key));
    const kids = new Map<string, TraceNode[]>();
    const rootNode = trace.nodes.find((n) => n.key === trace.id) ?? trace.nodes.find((n) => !n.parent);
    for (const n of trace.nodes) {
      if (n === rootNode) continue;
      const parent = n.parent && keys.has(n.parent) ? n.parent : (rootNode?.key ?? '');
      const list = kids.get(parent) ?? [];
      list.push(n);
      kids.set(parent, list);
    }
    for (const list of kids.values()) list.sort((a, b) => a.t - b.t || rank(a.stage) - rank(b.stage));
    const line = (n: TraceNode) =>
      `<span class="tn" data-seek="${n.t}" data-key="${esc(n.key)}" title="${esc(`${shown(trace, nodeName(n.key, n.name))}\n${LABELS[n.stage]} made ${when(n.t)}, ${after(trace, n.t)} after the concept\n${n.key}`)}">${icon(n.key)}<em class="st-${n.stage}">${LABELS[n.stage]}</em><span class="tn-name">${esc(shown(trace, nodeName(n.key, n.name)))}</span><time>${fmtDate(n.t)}</time></span>`;
    const render = (n: TraceNode, depth: number): string => {
      const children = kids.get(n.key) ?? [];
      if (!children.length) return `<li>${line(n)}</li>`;
      const busy = children.filter((c) => kids.has(c.key));
      const leaves = children.filter((c) => !kids.has(c.key));
      const parts = busy.map((c) => render(c, depth + 1));
      const byStage = new Map<TraceStage, TraceNode[]>();
      for (const c of leaves) byStage.set(c.stage, [...(byStage.get(c.stage) ?? []), c]);
      for (const [stage, group] of byStage) {
        if (group.length <= 4) parts.push(...group.map((c) => `<li>${line(c)}</li>`));
        else parts.push(`<li><details class="leaves"><summary>${group.length} ${busy.length ? 'more ' : ''}${MANY[stage]} with nothing made from them yet</summary><ul>${group.map((c) => `<li>${line(c)}</li>`).join('')}</ul></details></li>`);
      }
      return `<li><details open><summary>${line(n)}<small class="count" title="${countBelow(n.key)} made from it">${countBelow(n.key)}</small></summary><ul>${parts.join('')}</ul></details></li>`;
    };
    const memo = new Map<string, number>();
    const countBelow = (key: string): number => {
      if (memo.has(key)) return memo.get(key)!;
      const n = (kids.get(key) ?? []).reduce((sum, c) => sum + 1 + countBelow(c.key), 0);
      memo.set(key, n);
      return n;
    };
    return rootNode ? `<ul class="tree">${render(rootNode, 0)}</ul>` : '';
  }

  function stepLine(trace: Trace, run: TraceStep[], nodes: Map<string, TraceNode>) {
    const s = run[0];
    const name = shown(trace, nodeName(s.key, nodes.get(s.key)?.name ?? null));
    const keys = new Set(run.map((r) => r.key)).size;
    const kinds = [...new Set(run.map((r) => r.kind))];
    const end = run[run.length - 1].t;
    const who = esc(s.actor ? nameOf(s.actor) : 'An automation');
    const verbs = kinds.map((kind) => VERBS[kind]).join(' and ');
    const thing = (key: string, n: string) => (key === trace.id ? ONE.concept : `${ONE[s.stage]} <i>${esc(n)}</i>`);
    const what =
      run.length > 1
        ? `${who} ${verbs} ${keys === 1 ? `${thing(s.key, name)}${run.length > kinds.length ? ` ×${run.length}` : ''}` : `${keys} ${MANY[s.stage]}`}${end - s.t >= 60_000 ? ` <small class="via">until ${timeFormat.format(end)}</small>` : ''}`
        : s.stage === 'client_winner' && s.kind === 'done' && typeOf(s.key) === 'client_winner'
        ? `<b>${esc(name)}</b>, an ad the client made, became a winner`
        : s.stage === 'winner' && s.kind === 'done'
        ? `<b>${esc(name)}</b> became a winning ad`
        : (s.stage === 'winner' || typeOf(s.key) === 'client_winner') && s.kind === 'status'
        ? `<b>${esc(name)}</b> ended its win streak`
        : typeOf(s.key) === 'creative' && !s.actor
        ? `<i>${esc(name)}</i> started spending`
        : s.stage === 'concept' && s.kind === 'create' && s.key === trace.id
          ? `${esc(s.actor ? nameOf(s.actor) : 'Someone')} opened the concept ticket`
          : `${who} ${VERBS[s.kind]} ${thing(s.key, name)}`;
    const out = away(s.t);
    return `<button class="step${out ? ' away' : ''}" data-seek="${s.t}" data-key="${esc(s.key)}"${s.actor && layout.index.has(s.actor) ? ` data-actor="${esc(s.actor)}"` : ''} title="${esc(`${when(s.t)}${out ? ', outside the weeks pulled so far' : ''}${s.via ? ', through an AI session' : ''}`)}"><time>${timeFormat.format(s.t)}</time><span>${icon(s.key)} ${what}${s.via ? ' <small class="via">via agent</small>' : ''}</span></button>`;
  }

  function timeline(trace: Trace) {
    const nodes = new Map(trace.nodes.map((n) => [n.key, n]));
    const all = opened.has(trace.id);
    const runs: TraceStep[][] = [];
    for (const s of trace.steps) {
      const run = runs[runs.length - 1];
      const prev = run?.[run.length - 1];
      const same = prev && prev.actor === s.actor && prev.stage === s.stage && s.stage !== 'winner' && s.stage !== 'client_winner' && dayFormat.format(s.t) === dayFormat.format(prev.t);
      if (same && ((prev.kind === s.kind && s.t - prev.t < RUN_GAP) || (prev.key === s.key && s.t - prev.t < PAIR_GAP))) run.push(s);
      else runs.push([s]);
    }
    const shown = all ? runs : runs.slice(0, STEP_CAP);
    let day = '';
    const parts: string[] = [];
    for (const run of shown) {
      const d = dayFormat.format(run[0].t);
      if (d !== day) {
        day = d;
        parts.push(`<div class="day">${d}${away(run[0].t) ? ' · outside the weeks pulled so far' : ''}</div>`);
      }
      parts.push(stepLine(trace, run, nodes));
    }
    return `<div class="steps">${parts.join('')}</div>${runs.length > shown.length ? `<button class="tr-more" data-trace-steps="${esc(trace.id)}">Show the other ${runs.length - shown.length} lines</button>` : ''}`;
  }

  const href = (url: string) => url;

  function place(url: string) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    const on = (site: string) => host === site || host.endsWith(`.${site}`);
    if (host === 'uploads.linear.app') return 'Open Linear upload';
    if (on('linear.app')) return 'Open in Linear';
    if (on('notion.so')) return 'Open in Notion';
    if (host === 'f.io' || on('frame.io')) return 'Open in Frame.io';
    if (host === 'docs.google.com') return 'Open in Google Sheets';
    if (host === 'drive.google.com') return 'Open in Drive';
    if (on('facebook.com')) return 'Open in Ads Manager';
    return 'Open file';
  }

  function label(n: { key: string; name: string | null }) {
    if (n.name) return n.name;
    const type = typeOf(n.key);
    const rest = n.key.slice(type.length + 1);
    const row = /^sheet:[\w-]+:(\d+)$/.exec(rest);
    if (row) return `Row ${row[1]}`;
    if (rest.startsWith('drive:')) return `Drive file ${rest.slice(6, 14)}`;
    if (rest.startsWith('frameio:')) return `Frame.io ${(rest.slice(8).split('/').filter(Boolean).pop() ?? '').slice(0, 8)}`;
    const parts = rest.split('/').filter(Boolean);
    return parts.length > 1 ? parts.slice(-2).join(' / ') : rest;
  }

  function heldCard(id: string, type: ResourceType) {
    const keys = app.sim.held(id, app.view.t).filter((key) => typeOf(key) === type).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const rows = keys.map((key) => {
      const url = urlByKey.get(key) ?? urlOf(key, NONE);
      const concept = byKey.get(key);
      const name = app.redact(label({ key, name: nameByKey.get(key) ?? null }), concept?.region ?? null);
      const out = url ? `<a class="ext" href="${esc(href(url))}" target="_blank" rel="noopener" title="${esc(url)}">${place(url)} ↗</a>` : '<span class="ghost ext">no link</span>';
      return `<li><span class="tn" title="${esc(`${name}\n${key}`)}">${icon(key)}<span class="tn-name">${esc(name)}</span>${concept && concept.id !== key ? `<time>${esc(ticketOf(concept.id))}</time>` : ''}</span>${out}</li>`;
    });
    return `
      <button class="items-close" title="Close links">×</button>
      <h1>${keys.length} ${RESOURCE_LABELS[type]}${keys.length === 1 ? '' : 's'} · links</h1>
      <p class="sub">held by ${esc(nameOf(id))} at ${when(app.view.t)}</p>
      <p class="note">What they are holding at this moment in the replay. Each link opens the item where it lives.</p>
      <ul class="tree items">${rows.join('') || '<li class="ghost">Nothing held right now.</li>'}</ul>`;
  }

  function shelfCard(id: string, which: Shelf) {
    const creative = which === 'creative' || which === 'retired';
    const retired = which === 'retired';
    const list = app.cargo?.shelf(id, which) ?? [];
    const rows = list.map((item) => {
      const url = urlByKey.get(item.key) ?? urlOf(item.key, NONE);
      const name = app.redact(creative ? label({ key: item.key, name: item.name }) : item.name, byId.get(item.id)?.region ?? null);
      const out = url ? `<a class="ext" href="${esc(href(url))}" target="_blank" rel="noopener" title="${esc(url)}">${place(url)} ↗</a>` : '<span class="ghost ext">no link</span>';
      return `<li><span class="tn" title="${esc(`${name}\n${item.key}`)}">${icon(item.key)}<span class="tn-name">${esc(name)}</span><a class="seek" data-trace="${esc(item.id)}" data-tip="open this concept's trace"><time>${esc(ticketOf(item.id))}</time></a></span>${out}</li>`;
    });
    const desk = !retired && layout.index.has(id);
    const where = retired ? clientName(id) : desk ? nameOf(id) : (app.layout.buildings.find((b) => b.id === id)?.name ?? id);
    return `
      <button class="items-close" title="Close links">×</button>
      <h1>${list.length} ${creative ? 'creative' : which}${list.length === 1 ? '' : 's'} · links</h1>
      <p class="sub">${retired ? `put away from ${esc(where)}'s ad account` : desk ? `with ${esc(where)}` : `lying at ${esc(where)}`} at ${when(app.view.t)}</p>
      <p class="note">${retired ? 'Creatives whose ads were all turned off at least five days ago and are not on a win streak, most recently turned off first. Each link opens the creative where it lives; click a ticket to open its concept.' : desk ? 'What this person has beside them at this moment in the replay, newest first. Each link opens the item where it lives; click a ticket to open its concept.' : 'What is waiting beside this tool at this moment in the replay, newest first. Each link opens the item where it lives; click a ticket to open its concept.'}</p>
      <ul class="tree items">${rows.join('') || '<li class="ghost">Nothing lying here right now.</li>'}</ul>`;
  }

  function itemsCard(trace: Trace, stage: TraceStage) {
    const nodes = new Map(trace.nodes.map((n) => [n.key, n]));
    const got = reached(trace);
    const list = trace.nodes.filter((n) => n.stage === stage).sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
    const linked = (n: TraceNode) => {
      for (let at: TraceNode | undefined = n, hops = 0; at && hops < 20; at = at.parent ? nodes.get(at.parent) : undefined, hops++) if (at.url) return at;
      return null;
    };
    const rows = list.map((n) => {
      const at = linked(n);
      const out = !at?.url
        ? '<span class="ghost ext">no link</span>'
        : `<a class="ext" href="${esc(href(at.url))}" target="_blank" rel="noopener" title="${esc(at.url)}">${place(at.url)}${at === n ? '' : ` <small>via ${ONE[at.stage]}</small>`} ↗</a>`;
      return `<li><span class="tn" data-seek="${n.t}" data-key="${esc(n.key)}" title="${esc(`${shown(trace, label(n))}\n${isClient(trace) ? `Ad made ${when(n.t)}` : `${LABELS[n.stage]} made ${when(n.t)}, ${after(trace, n.t)} after the concept`}\n${n.key}`)}">${icon(n.key)}<span class="tn-name">${esc(shown(trace, label(n)))}</span><time>${fmtDate(n.t)}</time></span>${out}</li>`;
    });
    const others = TRACE_STAGES.filter((s) => got.has(s))
      .map((s) => (s === stage ? `<b>${LABELS[s]} ${got.get(s)!.n}</b>` : `<a class="seek" data-trace-items="${s}">${LABELS[s]} ${got.get(s)!.n}</a>`))
      .join(' · ');
    return `
      <button class="items-close" data-trace-items="" title="Close links">×</button>
      <h1>${isClient(trace) ? 'The winner and its ads' : `${list.length} ${list.length === 1 ? ONE[stage].replace(/^(the|an?) /, '') : MANY[stage]}`} · links</h1>
      <p class="sub">${esc(shown(trace))} · ${esc(tagOf(trace))}</p>
      <p class="note">${LABELS[stage]}: ${isClient(trace) ? 'the winning ad the client made, with its ads' : HELP[stage]}. Each link opens the item where it lives; click a name to jump the replay to when it was made.</p>
      <p class="note">${others}</p>
      <ul class="tree items">${rows.join('')}</ul>`;
  }

  function lineage(trace: Trace) {
    const from = fromOf(trace);
    if (!from) return '';
    const found = byId.get(from) ?? byKey.get(from);
    const origin = found === trace ? undefined : found;
    const what = typeOf(from) === 'ticket' ? `concept ${esc(ticketOf(from))}` : esc(shown(origin ?? trace, nodeName(from, origin?.nodes.find((n) => n.key === from)?.name ?? null)));
    if (origin && isClient(origin)) return `<p class="lede">Grew out of ${link(origin)}, a winning ad the client made.</p>`;
    return `<p class="lede">An iteration of ${origin && origin.id !== from ? `${what} from ${link(origin)}` : origin ? link(origin) : what}.</p>`;
  }

  function offspring(trace: Trace) {
    const list = iterations.get(trace.id) ?? [];
    return list.length
      ? `<h2>Iterations · ${list.length}</h2><p class="note">Later concepts that grew out of this one or one of its ads.</p><table class="tr-table"><tbody>${list
          .sort((a, b) => a.t - b.t)
          .map((t) => `<tr><td class="clip">${link(t)}</td><td class="tr-at">${esc(tagOf(t))} · ${fmtDate(t.t)}</td><td class="n">${strip(t)}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
  }

  function overAt(trace: Trace) {
    const marks = trace.steps.filter((s) => s.key === trace.id && (s.kind === 'done' || s.kind === 'status'));
    return marks.length && marks[marks.length - 1].kind === 'status' ? marks[marks.length - 1].t : null;
  }

  function clientCard(trace: Trace) {
    const grown = iterations.get(trace.id)?.length ?? 0;
    const over = overAt(trace);
    return `
      <section class="card trace-card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(shown(trace))}</h1>
        <p class="sub">client winner · ${client(trace.region)} · win streak began ${when(trace.t)}${over ? ` · ended ${when(over)}` : ''}</p>
        <p class="lede">A winning ad the client made, not one of ours. ${grown ? `${grown} ${grown === 1 ? 'concept has' : 'concepts have'} grown out of it` : 'No concept has grown out of it yet'}. Its plot in the client's field carries a red star while the streak lasts.</p>
        ${offspring(trace)}
        <h2>The winner and its ads · <a class="seek" data-trace-items="client_winner" title="List them with links">${trace.nodes.length}</a></h2>
        <h2>Timeline · ${trace.steps.length} events</h2>
        ${timeline(trace)}
      </section>`;
  }

  function card(id: string) {
    const trace = byId.get(id);
    if (!trace) return '';
    if (isClient(trace)) return clientCard(trace);
    const got = reached(trace);
    const winners = trace.nodes.filter((n) => n.stage === 'winner').length;
    const ads = trace.nodes.filter((n) => n.stage === 'ad').length;
    const outcome = winners
      ? `From this ticket to <b class="gold">${winners} winning ${winners === 1 ? 'ad' : 'ads'}</b>`
      : ads
        ? `From this ticket to ${ads} live ${ads === 1 ? 'ad' : 'ads'}, no winner yet`
        : trace.stage === 'concept'
          ? 'Nothing made from this ticket yet'
          : `From this ticket as far as ${MANY[trace.stage]} so far`;
    return `
      <section class="card trace-card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(shown(trace))}</h1>
        <p class="sub">concept trace · ${esc(ticketOf(trace.id))} · ${client(trace.region)} · opened ${when(trace.t)}</p>
        <p class="lede">${outcome}: ${trace.nodes.length} ${trace.nodes.length === 1 ? 'resource' : 'resources'}, ${trace.steps.length} events, ${trace.hands.length} ${trace.hands.length === 1 ? 'person' : 'people'}. On the map its moves glow magenta and everyone who touched it is ringed.</p>
        ${lineage(trace)}
        ${strip(trace, true)}
        <h2>How far it got</h2>
        <table class="stages"><thead><tr><th>Stage</th><th class="n">Reached</th><th class="n">After concept</th><th class="n">Items</th></tr></thead><tbody>${TRACE_STAGES.map((stage) => {
          const at = got.get(stage);
          return `<tr class="${at ? 'got' : 'not'}"${at ? ` data-trace-items="${stage}"` : ''} title="${esc(`${LABELS[stage]}: ${HELP[stage]}`)}"><td><i class="dot ${at ? (stage === 'winner' ? 'win' : stage === 'client_winner' ? 'cw' : 'on') : ''}"></i>${LABELS[stage]}</td><td class="n">${at ? `<a class="seek" data-seek="${at.t}">${when(at.t)}</a>` : stage !== 'client_winner' && rank(stage) < rank(trace.stage) ? 'skipped' : '–'}</td><td class="n">${at ? (stage === 'concept' ? '' : stage === 'client_winner' ? 'before it' : after(trace, at.t)) : ''}</td><td class="n">${at ? `<a class="seek" data-trace-items="${stage}" title="${esc(`List the ${at.n === 1 ? ONE[stage].replace(/^(the|an?) /, '') : MANY[stage]} with links`)}">${at.n}</a>` : ''}</td></tr>`;
        }).join('')}</tbody></table>
        ${offspring(trace)}
        <h2>Hands · ${trace.hands.length}</h2>
        <p class="note">Everyone who touched it, in the order they first did, with what they did.</p>
        ${hands(trace)}
        <h2>Expansion · ${trace.nodes.length}</h2>
        <p class="note">What was made from what. Click a line to jump the replay to when it was made.</p>
        ${tree(trace)}
        <h2>Timeline · ${trace.steps.length} events</h2>
        <p class="note">Click an event to jump the replay there and pick out who did it.</p>
        ${timeline(trace)}
      </section>`;
  }

  const stepsOf = new Map<string, { t: number; id: string; stage: TraceStage | null }[]>();
  function mine(id: string) {
    let list = stepsOf.get(id);
    if (list) return list;
    list = [];
    for (const [tid, stages] of touched.get(id) ?? []) {
      const trace = byId.get(tid)!;
      if (!stages.size) list.push({ t: trace.t, id: tid, stage: null });
      for (const s of trace.steps) if (s.actor === id) list.push({ t: s.t, id: tid, stage: s.stage });
    }
    list.sort((x, y) => x.t - y.t);
    stepsOf.set(id, list);
    return list;
  }
  const upTo = (id: string, t: number) => {
    const list = mine(id);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  function touchedSoFar(id: string, n: number) {
    const seen = new Map<string, { last: number; stages: Map<TraceStage, number> }>();
    for (const s of mine(id).slice(0, n)) {
      let entry = seen.get(s.id);
      if (!entry) seen.set(s.id, (entry = { last: s.t, stages: new Map() }));
      entry.last = s.t;
      if (s.stage) entry.stages.set(s.stage, (entry.stages.get(s.stage) ?? 0) + 1);
    }
    const rows = [...seen.entries()]
      .sort((x, y) => y[1].last - x[1].last)
      .map(([tid, { last, stages }]) => {
        const trace = byId.get(tid)!;
        const what = [...stages.entries()].sort((x, y) => rank(x[0]) - rank(y[0])).map(([stage, count]) => `${LABELS[stage].toLowerCase()}${count > 1 ? ` ×${count}` : ''}`).join(', ') || 'was handed it';
        return `<tr title="${esc(`last touched ${when(last)}`)}"><td class="clip">${link(trace)}</td><td class="tr-at">${esc(what)}</td><td class="n">${strip(trace)}</td></tr>`;
      });
    return `<h2>Concepts touched · ${rows.length}</h2>
      ${rows.length ? `<table class="tr-table"><thead><tr><th>Concept</th><th>Their part</th><th class="n">Got to</th></tr></thead><tbody>${rows.slice(0, ROW_CAP).join('')}</tbody></table>` : '<p class="note">None yet at this point in the replay.</p>'}
      ${rows.length > ROW_CAP ? `<details><summary>${rows.length - ROW_CAP} more</summary><table class="tr-table"><tbody>${rows.slice(ROW_CAP).join('')}</tbody></table></details>` : ''}`;
  }

  let shownTouched = '';
  function unit(id: string) {
    if (!touched.get(id)?.size) return '';
    const n = upTo(id, app.view.t);
    shownTouched = `${id}|${n}`;
    return `<div id="trace-touched" data-unit="${esc(id)}">${touchedSoFar(id, n)}</div>`;
  }

  app.onFrame(() => {
    const el = document.getElementById('trace-touched');
    const id = el?.dataset.unit;
    if (!el || !id) return;
    const n = upTo(id, app.view.t);
    if (shownTouched === `${id}|${n}`) return;
    shownTouched = `${id}|${n}`;
    const open = !!el.querySelector('details[open]');
    el.innerHTML = touchedSoFar(id, n);
    if (open) el.querySelector('details')?.setAttribute('open', '');
  });

  function region(id: string) {
    const list = traces.filter((t) => t.region === id).sort((a, b) => lastOf.get(b.id)! - lastOf.get(a.id)!);
    const won = clientWins.filter((t) => t.region === id).sort((a, b) => lastOf.get(b.id)! - lastOf.get(a.id)!);
    const wonRows = won.map((t) => {
      const over = overAt(t);
      const grown = iterations.get(t.id)?.length ?? 0;
      return `<tr><td class="clip">${resourceGlyph('client_winner')} ${link(t)}</td><td class="tr-at">${fmtDate(t.t)}${over ? ` to ${fmtDate(over)}` : ' · still winning'}${grown ? ` · ${grown} ${grown === 1 ? 'concept' : 'concepts'}` : ''}</td></tr>`;
    });
    const theirs = won.length
      ? `<h2>Client winners · ${won.length}</h2><p class="note">Winning ads the client made, not ours. Click one to inspect it and see any concepts grown out of it.</p>
      <table class="tr-table"><tbody>${wonRows.slice(0, ROW_CAP).join('')}</tbody></table>
      ${wonRows.length > ROW_CAP ? `<details><summary>${wonRows.length - ROW_CAP} more</summary><table class="tr-table"><tbody>${wonRows.slice(ROW_CAP).join('')}</tbody></table></details>` : ''}`
      : '';
    if (!list.length) return theirs;
    const wins = list.flatMap((t) => t.nodes.filter((n) => n.stage === 'winner').map((n) => ({ n, t })));
    const rows = list.map((t) => `<tr><td class="clip">${link(t)}</td><td class="n">${strip(t)}</td></tr>`);
    return `<h2 id="region-concepts">Concepts · ${list.length}</h2>
      ${funnel(list, false, won)}
      <table class="tr-table"><tbody>${rows.slice(0, ROW_CAP).join('')}</tbody></table>
      ${rows.length > ROW_CAP ? `<details><summary>${rows.length - ROW_CAP} more</summary><table class="tr-table"><tbody>${rows.slice(ROW_CAP).join('')}</tbody></table></details>` : ''}
      ${wins.length ? `<h2>Winners from concepts · ${wins.length}</h2><p class="list">${wins.map(({ n, t }) => `${glyph('star', COLORS.trophy)} ${esc(shown(t, n.name ?? 'winning ad'))} <small>from ${link(t)}</small>`).join('<br>')}</p>` : ''}
      ${theirs}`;
  }

  function jump(id: string) {
    const n = traces.filter((t) => t.region === id).length;
    return n ? ` · <a class="seek" data-jump="region-concepts">${n} ${n === 1 ? 'concept' : 'concepts'} ↓</a>` : '';
  }

  function from(key: string) {
    const trace = byKey.get(key);
    return trace ? ` · from concept ${link(trace)}` : '';
  }

  function entries() {
    const out: { pick: Pick; name: string; sub: string; rank: number; text?: string }[] = traces.map((t) => ({ pick: { kind: 'trace' as const, id: t.id }, name: `${ticketOf(t.id)} ${shown(t)}`, sub: `concept · ${clientName(t.region)}`, rank: 3 }));
    for (const t of clientWins) out.push({ pick: { kind: 'trace', id: t.id }, name: shown(t), sub: `client winner · ${clientName(t.region)}`, rank: 3 });
    for (const t of traces) {
      const nodes = new Map(t.nodes.map((n) => [n.key, n]));
      const named = new Map<string, string[]>();
      for (const n of t.nodes) {
        if (typeOf(n.key) !== 'taxonomy' || !n.name) continue;
        for (let up = n.parent ? nodes.get(n.parent) : undefined, hops = 0; up && up.key !== t.id && hops < 20; up = up.parent ? nodes.get(up.parent) : undefined, hops++) {
          const list = named.get(up.key);
          if (list) list.push(n.name);
          else named.set(up.key, [n.name]);
        }
      }
      for (const n of t.nodes) {
        if (n.key === t.id) continue;
        const name = shown(t, label(n));
        out.push({ pick: { kind: 'trace', id: t.id }, name, sub: `${RESOURCE_LABELS[typeOf(n.key) as ResourceType] ?? LABELS[n.stage].toLowerCase()} · ${ticketOf(t.id)} · ${clientName(t.region)}`, rank: 4, text: `${name} ${n.key} ${(named.get(n.key) ?? []).join(' ')}` });
      }
    }
    return out;
  }

  const paintList = () => {
    const el = document.getElementById('trace-body');
    if (el) el.innerHTML = listBody();
  };

  root.addEventListener('change', (event) => {
    const el = (event.target as HTMLElement).closest<HTMLSelectElement>('[data-trace-filter]');
    if (!el) return;
    filters[el.dataset.traceFilter as 'region' | 'stage' | 'who' | 'sort'] = el.value;
    filters.cap = LIST_STEP;
    paintList();
  });

  const openShelf = () => {
    const pick = app.view.picked;
    if ((pick?.kind !== 'building' && pick?.kind !== 'region' && pick?.kind !== 'unit') || !pick.shelf) return false;
    items = null;
    held = null;
    shelf = { id: pick.id, which: pick.shelf };
    paintItems();
    float.scrollTop = 0;
    return true;
  };
  const openItems = () => {
    const pick = app.view.picked;
    const stage = pick?.kind !== 'trace' ? undefined : (pick.items ?? (byId.has(pick.id) && isClient(byId.get(pick.id)!) ? ('client_winner' as const) : undefined));
    if (pick?.kind !== 'trace' || !stage) return false;
    held = null;
    shelf = null;
    items = { id: pick.id, stage };
    paintItems();
    float.scrollTop = 0;
    return true;
  };
  app.onSelect((pick) => {
    if (openShelf() || openItems()) return;
    if ((items && (pick?.kind !== 'trace' || pick.id !== items.id)) || (held && (pick?.kind !== 'unit' || pick.id !== held.id)) || shelf) {
      items = null;
      held = null;
      shelf = null;
      paintItems();
    }
  });
  app.onRepick(() => {
    if (openItems()) return;
    if (!openShelf() && shelf) {
      shelf = null;
      paintItems();
    }
  });

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.who')) return;
    const jumpTo = target.closest<HTMLElement>('[data-jump]')?.dataset.jump;
    if (jumpTo) return document.getElementById(jumpTo)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const stage = target.closest<HTMLElement>('[data-trace-stage]')?.dataset.traceStage;
    if (stage) {
      filters.reached = filters.reached === stage ? '' : stage;
      filters.cap = LIST_STEP;
      return paintList();
    }
    if (target.closest('.tr-reset')) {
      Object.assign(filters, { region: '', stage: '', reached: '', who: '', cap: LIST_STEP });
      return paintList();
    }
    if (target.closest('[data-trace-more]')) {
      filters.cap += LIST_STEP;
      return paintList();
    }
    const more = target.closest<HTMLElement>('[data-trace-steps]')?.dataset.traceSteps;
    if (more) {
      opened.add(more);
      const box = target.closest('.trace-card');
      const steps = box?.querySelector('.steps');
      const trace = byId.get(more);
      if (steps && trace) {
        steps.outerHTML = timeline(trace);
        target.remove();
      }
      return;
    }
    if (target.closest('.items-close')) {
      items = null;
      held = null;
      shelf = null;
      return paintItems();
    }
    const holding = target.closest<HTMLElement>('[data-held]')?.dataset.held;
    if (holding && app.view.picked?.kind === 'unit') {
      items = null;
      held = { id: app.view.picked.id, type: holding as ResourceType };
      paintItems();
      float.scrollTop = 0;
      return;
    }
    const listed = target.closest<HTMLElement>('[data-trace-items]')?.dataset.traceItems;
    const shown = app.view.picked?.kind === 'trace' ? app.view.picked.id : null;
    if (listed !== undefined && shown) {
      held = null;
      items = listed ? { id: shown, stage: listed as TraceStage } : null;
      paintItems();
      float.scrollTop = 0;
      if (!target.closest('tr [data-seek]')) return;
    }
    const id = target.closest<HTMLElement>('[data-trace]')?.dataset.trace;
    if (id) return app.pick({ kind: 'trace', id });
    if (target.closest('summary') && !target.closest('[data-seek]')) return;
    const seek = target.closest<HTMLElement>('[data-seek]');
    if (!seek) return;
    if (seek.closest('summary')) event.preventDefault();
    app.seek(Number(seek.dataset.seek));
    const actor = seek.dataset.actor;
    if (actor) app.view.selected = actor;
    const key = seek.dataset.key;
    if (key && shown) app.look = { trace: shown, key, actor: actor ?? null };
    for (const el of document.querySelectorAll('.step.on, .tn.on')) el.classList.remove('on');
    seek.classList.add('on');
  };
  root.addEventListener('click', onClick);
  float.addEventListener('click', onClick);

  return { list, card, unit, region, jump, from, entries, repaint: paintItems };
}
