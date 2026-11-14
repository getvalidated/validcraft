import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type EventKind,
  type SourceEvent,
  type SourceFile,
  type SourceHolding,
  type Window,
} from '../../../src/schema';
import { attach, type Found } from '../../lib/attach';
import { conceptFields } from './concepts';
import type { DriveFile } from '../../lib/drive';
import { markdownLinks, refKey } from '../../lib/refs';
import { ACTIONS, actionOf, featureId, featuresOf, mentionsIn } from './actions';

type Ref = { id: string } | null;
type Bot = { name: string | null } | null;
type StateRef = { type: string; name?: string | null } | null;
type Named = { name: string } | null;
type IssueRef = { identifier: string } | null;

export interface RawReaction {
  id: string;
  emoji: string;
  createdAt: string;
  user: Ref;
}

export interface RawHistory {
  id: string;
  createdAt: string;
  actor: Ref;
  botActor: Bot;
  fromAssignee: Ref;
  toAssignee: Ref;
  fromState: StateRef;
  toState: StateRef;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromEstimate?: number | null;
  toEstimate?: number | null;
  fromCycle?: { number: number } | null;
  toCycle?: { number: number } | null;
  fromProject?: Named;
  toProject?: Named;
  fromProjectMilestone?: Named;
  toProjectMilestone?: Named;
  fromDueDate?: string | null;
  toDueDate?: string | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  updatedDescription?: boolean | null;
  addedLabels?: { name: string }[] | null;
  removedLabels?: { name: string }[] | null;
  fromParent?: IssueRef;
  toParent?: IssueRef;
  relationChanges?: { identifier: string; type: string }[] | null;
  fromTeam?: { key: string } | null;
  toTeam?: { key: string } | null;
  fromDelegate?: Ref;
  toDelegate?: Ref;
  attachment?: Ref;
  archived?: boolean | null;
  trashed?: boolean | null;
  autoArchived?: boolean | null;
  autoClosed?: boolean | null;
  customerNeedId?: string | null;
}

export interface RawComment {
  id: string;
  createdAt: string;
  user: Ref;
  botActor: Bot;
  body?: string | null;
  editedAt?: string | null;
  resolvedAt?: string | null;
  resolvingUser?: Ref;
  externalUser?: Named;
  parent?: Ref;
  reactions?: RawReaction[];
}

export interface RawIssue {
  id: string;
  identifier: string;
  createdAt: string;
  team: { key: string };
  project: { name: string } | null;
  creator: Ref;
  botActor: Bot;
  assignee: Ref;
  state: StateRef;
  history: RawHistory[];
  comments: RawComment[];
  description?: string | null;
  attachments?: { nodes: { id: string; url: string | null; title: string | null; createdAt: string; creator: Ref }[] };
  title?: string | null;
  parent?: IssueRef;
  labels?: { nodes: { name: string }[] };
  relations?: { nodes: { type: string; relatedIssue: IssueRef }[] };
  inverseRelations?: { nodes: { type: string; issue: IssueRef }[] };
  reactions?: RawReaction[];
}

export interface RawUser {
  id: string;
  name: string;
  displayName: string;
  email?: string | null;
  active: boolean;
}

export interface RawInput {
  window: Window;
  issues: RawIssue[];
  users: RawUser[];
  drive: Map<string, DriveFile>;
}

export interface Report {
  issuesRead: number;
  historyInWindow: number;
  commentsInWindow: number;
  repliesInWindow: number;
  mentionsInWindow: number;
  reactionsInWindow: number;
  resolvesInWindow: number;
  delegationsInWindow: number;
  actions: Record<string, number>;
  assigneeChangesInWindow: number;
  entries: { sends: number; assigns: number; selfAssigns: number; unassigns: number; nonAssignee: number };
  events: Record<EventKind, number>;
  actors: number;
  initial: number;
  videos: number;
  reports: number;
  links: number;
  checks: { label: string; ok: boolean }[];
  ok: boolean;
}

const BUILDING = 'linear';
const BOT_PREFIX = 'linear:bot:';
const LINEAR: Building = { id: BUILDING, region: INTERNAL_REGION, name: 'Linear', resource: 'ticket' };

export const linksOf = (issues: RawIssue[]) =>
  issues.flatMap((issue) => [
    ...markdownLinks(issue.description ?? ''),
    ...(issue.attachments?.nodes ?? []).map((a) => ({ link: a.url ?? '', name: a.title ?? '' })),
    ...issue.comments.flatMap((c) => markdownLinks(c.body ?? '')),
  ]);

const userKey = (id: string) => `linear:${id}`;
const actorKey = (user: Ref, bot: Bot) => (user ? userKey(user.id) : `${BOT_PREFIX}${bot?.name?.trim() || 'Linear'}`);

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function toSourceFile(raw: RawInput): { file: SourceFile; report: Report } {
  const since = raw.window.start;
  const until = raw.window.end;
  const inWindow = (t: number) => t >= since && t <= until;
  const issues = dedupe(raw.issues);

  const events: SourceEvent[] = [];
  const initial: SourceHolding[] = [];
  const roleIds = new Set<string>();
  const teamOf = new Map<SourceEvent, string>();
  const holdingTeams = new Map<string, Map<string, number>>();
  const entries = { sends: 0, assigns: 0, selfAssigns: 0, unassigns: 0, nonAssignee: 0 };
  const found: Found[] = [];
  const teamOfTicket = new Map<string, string>();
  let historyInWindow = 0;
  let commentsInWindow = 0;
  let assigneeChangesInWindow = 0;
  let repliesInWindow = 0;
  let mentionsInWindow = 0;
  let reactionsInWindow = 0;
  let resolvesInWindow = 0;
  let delegationsInWindow = 0;
  const actions: Record<string, number> = {};
  const handles = new Map(raw.users.map((u) => [u.displayName.toLowerCase(), u.id]));

  for (const issue of issues) {
    const team = issue.team.key;
    const ident = issue.identifier;
    const clientHint = issue.project ? `linear-project:${issue.project.name}` : null;
    const createdAt = Date.parse(issue.createdAt);
    if (issue.creator) roleIds.add(issue.creator.id);
    if (issue.assignee) roleIds.add(issue.assignee.id);

    const emit = (kind: EventKind, t: number, actor: string, rest: Partial<SourceEvent> = {}) => {
      const event: SourceEvent = {
        kind,
        t,
        actor,
        via: null,
        resource: 'ticket',
        resourceId: ident,
        building: BUILDING,
        from: null,
        to: null,
        isReturn: false,
        count: 1,
        clientHint,
        ...rest,
      };
      events.push(event);
      teamOf.set(event, team);
    };

    const history = dedupe(issue.history)
      .map((h, i) => ({ h, t: Date.parse(h.createdAt), seq: -i }))
      .sort((a, b) => a.t - b.t || a.seq - b.seq);

    for (const { h } of history) {
      if (h.fromAssignee) roleIds.add(h.fromAssignee.id);
      if (h.toAssignee) roleIds.add(h.toAssignee.id);
    }

    const isAssigneeChange = (h: RawHistory) => (h.fromAssignee?.id ?? null) !== (h.toAssignee?.id ?? null);

    const changes = history.filter((e) => e.t >= since && isAssigneeChange(e.h));
    const initialHolder = changes.length ? changes[0].h.fromAssignee?.id ?? null : issue.assignee?.id ?? null;
    const holderAt = (t: number) => {
      let holder = initialHolder;
      for (const c of changes) {
        if (c.t > t) break;
        holder = c.h.toAssignee?.id ?? null;
      }
      return holder ? userKey(holder) : null;
    };

    const held = new Set<string>();
    if (initialHolder) held.add(initialHolder);

    const moved = history.find((e) => e.t >= since && e.h.toState && e.h.fromState?.type !== e.h.toState.type);
    const openAtStart = !['completed', 'canceled', 'duplicate'].includes((moved ? moved.h.fromState?.type : issue.state?.type) ?? '');

    if (createdAt < since) {
      initial.push({
        resource: 'ticket',
        resourceId: ident,
        holder: initialHolder && openAtStart ? userKey(initialHolder) : null,
        building: BUILDING,
      });
      if (initialHolder && openAtStart) {
        const key = userKey(initialHolder);
        if (!holdingTeams.has(key)) holdingTeams.set(key, new Map());
        holdingTeams.get(key)!.set(team, (holdingTeams.get(key)!.get(team) ?? 0) + 1);
      }
    }

    if (inWindow(createdAt)) emit('create', createdAt, actorKey(issue.creator, issue.botActor));

    for (const { h, t } of history) {
      if (!inWindow(t)) continue;
      historyInWindow++;
      const actor = actorKey(h.actor, h.botActor);
      const from = h.fromAssignee?.id ?? null;
      const to = h.toAssignee?.id ?? null;
      let emitted = false;

      if (isAssigneeChange(h)) {
        assigneeChangesInWindow++;
        if (from && to) {
          entries.sends++;
          emit('send', t, actor, { from: userKey(from), to: userKey(to), isReturn: held.has(to) });
          emitted = true;
        } else if (to) {
          if (actor !== userKey(to)) {
            entries.assigns++;
            emit('assign', t, actor, { to: userKey(to) });
            emitted = true;
          } else {
            entries.selfAssigns++;
          }
        } else {
          entries.unassigns++;
        }
        if (from) held.add(from);
        if (to) held.add(to);
      } else {
        entries.nonAssignee++;
      }

      if (h.toState?.type === 'completed') {
        emit('done', t, actor, { to: holderAt(t) });
        emitted = true;
      }
      const action = actionOf(h);
      if (action) actions[action] = (actions[action] ?? 0) + 1;
      const delegate = h.toDelegate ?? h.fromDelegate;
      if (action === 'delegated' && delegate) {
        delegationsInWindow++;
        emit('assign', t, actor, { to: userKey(delegate.id), feature: featureId(action) });
      } else if (action) emit('edit', t, actor, { feature: featureId(action) });
      else if (!emitted) emit('edit', t, actor);
    }

    const parent = refKey('ticket', ident);
    teamOfTicket.set(parent, team);
    const author = actorKey(issue.creator, issue.botActor);
    for (const { link, name } of markdownLinks(issue.description ?? '')) found.push({ t: createdAt, actor: author, parent, link, name, clientHint });
    for (const a of issue.attachments?.nodes ?? []) {
      if (a.url) found.push({ t: Date.parse(a.createdAt), actor: a.creator ? userKey(a.creator.id) : author, parent, link: a.url, name: a.title ?? '', clientHint });
    }
    const react = (r: RawReaction, to: string | null) => {
      const t = Date.parse(r.createdAt);
      if (!r.user || !inWindow(t)) return;
      reactionsInWindow++;
      emit('comment', t, userKey(r.user.id), { to, feature: featureId('reactions') });
    };
    for (const r of issue.reactions ?? []) react(r, holderAt(Date.parse(r.createdAt)));
    for (const c of dedupe(issue.comments)) {
      const t = Date.parse(c.createdAt);
      const author = actorKey(c.user, c.botActor);
      for (const { link, name } of markdownLinks(c.body ?? '')) found.push({ t, actor: author, parent, link, name, clientHint });
      for (const r of c.reactions ?? []) react(r, author);
      const resolved = c.resolvedAt ? Date.parse(c.resolvedAt) : NaN;
      if (c.resolvingUser && inWindow(resolved)) {
        resolvesInWindow++;
        emit('edit', resolved, userKey(c.resolvingUser.id), { to: author, feature: featureId('resolved') });
      }
      if (!inWindow(t)) continue;
      commentsInWindow++;
      const addressed = mentionsIn(c.body ?? '')
        .map((handle) => handles.get(handle))
        .filter((id): id is string => !!id)
        .map(userKey)
        .find((key) => key !== author);
      if (addressed) mentionsInWindow++;
      if (c.parent) repliesInWindow++;
      emit('comment', t, author, { to: addressed ?? holderAt(t) });
    }
  }

  const attached = attach(found, raw.drive, raw.window, LINEAR, 'Attachments');
  for (const event of attached.events) {
    events.push(event);
    teamOf.set(event, teamOfTicket.get(event.parent!)!);
  }
  events.sort((a, b) => a.t - b.t);
  const own = featuresOf(events.flatMap((e) => (e.feature ? [e.feature] : [])));
  const features = [...own, ...attached.features.filter((f) => !own.some((o) => o.id === f.id))];

  const teamCounts = new Map<string, Map<string, number>>();
  const commentCounts = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'comment' && e.feature !== featureId('reactions')) commentCounts.set(e.actor, (commentCounts.get(e.actor) ?? 0) + 1);
    const team = teamOf.get(e)!;
    for (const key of new Set([e.actor, e.from, e.to].filter((k): k is string => !!k))) {
      if (!teamCounts.has(key)) teamCounts.set(key, new Map());
      teamCounts.get(key)!.set(team, (teamCounts.get(key)!.get(team) ?? 0) + 1);
    }
  }
  for (const [key, counts] of holdingTeams) {
    if (!teamCounts.has(key)) teamCounts.set(key, counts);
  }

  const users = new Map(raw.users.map((u) => [u.id, u]));
  const listed = new Map(attached.actors.map((actor) => [actor.key, actor]));
  const actors: ActorRef[] = [...teamCounts.keys()].sort().map((key) => {
    if (listed.has(key)) return listed.get(key)!;
    if (key.startsWith(BOT_PREFIX)) {
      return { key, email: null, name: key.slice(BOT_PREFIX.length), kind: 'system', groupHint: null, clientHint: null };
    }
    const id = key.slice('linear:'.length);
    const user = users.get(id);
    const team = [...teamCounts.get(key)!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const automation = (commentCounts.get(key) ?? 0) >= 20 && !roleIds.has(id);
    return {
      key,
      email: user?.email ?? null,
      name: user?.displayName ?? `user-${id.slice(0, 4)}`,
      kind: automation ? 'automation' : 'person',
      groupHint: team,
      clientHint: null,
    };
  });

  const counts: Report['events'] = { create: 0, send: 0, assign: 0, comment: 0, done: 0, edit: 0, bulk: 0, use: 0, run: 0, error: 0, status: 0 };
  for (const e of events) counts[e.kind]++;
  const actorKeys = new Set(actors.map((a) => a.key));
  const used = [
    ...events.flatMap((e) => [e.actor, e.from, e.to]),
    ...initial.map((h) => h.holder),
  ].filter((k): k is string => !!k);
  const entrySum = entries.sends + entries.assigns + entries.selfAssigns + entries.unassigns + entries.nonAssignee;

  const checks = [
    {
      label: 'sends + assigns + self-assigns + unassigns + non-assignee entries = history entries',
      ok: entrySum === historyInWindow,
    },
    {
      label: 'every in-window assignee change counted exactly once',
      ok: entries.sends + entries.assigns + entries.selfAssigns + entries.unassigns === assigneeChangesInWindow,
    },
    { label: 'send events = send entries', ok: counts.send === entries.sends },
    { label: 'assign events = assign entries + delegations', ok: counts.assign === entries.assigns + delegationsInWindow },
    { label: 'comment events = in-window comments + reactions', ok: counts.comment === commentsInWindow + reactionsInWindow },
    {
      label: 'action edits + resolves + delegations = classified history entries + resolves',
      ok:
        events.filter((e) => e.feature && e.building === BUILDING && e.kind !== 'comment' && e.resource === 'ticket').length ===
        Object.values(actions).reduce((sum, n) => sum + n, 0) + resolvesInWindow,
    },
    { label: 'every action feature is listed in features', ok: events.every((e) => !e.feature || features.some((f) => f.id === e.feature)) },
    { label: 'every actor key used is listed in actors', ok: used.every((key) => actorKeys.has(key)) },
  ];

  return {
    file: {
      schemaVersion: SCHEMA_VERSION,
      source: 'linear',
      window: raw.window,
      actors,
      buildings: [LINEAR, ...attached.buildings.filter((b) => b.id !== BUILDING)],
      features,
      events,
      initial,
      sessions: [],
      measures: [],
      artifacts: [],
      ...conceptFields(issues, attached.links),
    },
    report: {
      issuesRead: issues.length,
      historyInWindow,
      commentsInWindow,
      repliesInWindow,
      mentionsInWindow,
      reactionsInWindow,
      resolvesInWindow,
      delegationsInWindow,
      actions,
      assigneeChangesInWindow,
      entries,
      events: counts,
      actors: actors.length,
      initial: initial.length,
      videos: attached.events.filter((e) => e.resource === 'video').length,
      reports: attached.events.filter((e) => e.resource === 'report').length,
      links: attached.links.length,
      checks,
      ok: checks.every((c) => c.ok),
    },
  };
}

export function printReport(report: Report) {
  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('Linear source');
  row('issues read', report.issuesRead);
  row('in-window history entries', report.historyInWindow);
  row('  sends', report.entries.sends);
  row('  assigns (by someone else)', report.entries.assigns);
  row('  self-assigns', report.entries.selfAssigns);
  row('  unassigns', report.entries.unassigns);
  row('  non-assignee entries', report.entries.nonAssignee);
  row('in-window assignee changes', report.assigneeChangesInWindow);
  row('  classified by what changed', Object.values(report.actions).reduce((sum, n) => sum + n, 0));
  for (const [action, count] of Object.entries(report.actions).sort((a, b) => b[1] - a[1])) row(`    ${ACTIONS[action]}`, count);
  row('in-window comments', report.commentsInWindow);
  row('  thread replies', report.repliesInWindow);
  row('  addressed by @mention', report.mentionsInWindow);
  row('in-window reactions', report.reactionsInWindow);
  row('in-window resolved threads', report.resolvesInWindow);
  row('in-window agent delegations', report.delegationsInWindow);
  row('actors', report.actors);
  row('issues existing at window start', report.initial);
  row('videos attached or linked', report.videos);
  row('reports attached or linked', report.reports);
  row('links to other resources', report.links);
  console.log('Events before the bulk rule');
  for (const [kind, count] of Object.entries(report.events)) if (kind !== 'bulk') row(kind, count);
  console.log('Checks');
  for (const check of report.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
}
