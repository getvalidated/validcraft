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
import { config } from '../../lib/config';
import { markdownLinks, refKey } from '../../lib/refs';
import { ACTIONS, REVIEWS, featureId, featuresOf, ticketsFirst } from './actions';

const AGENT_LOGINS = new Set(['claude', 'cursoragent']);

export interface RawActor {
  login: string;
  __typename: string;
}

export interface RawCommit {
  oid: string;
  committedDate: string;
  author: { name: string | null; email: string | null; user: { login: string } | null } | null;
}

export interface RawComment {
  id?: string;
  createdAt: string;
  publishedAt: string | null;
  author: RawActor | null;
  body?: string | null;
  path?: string | null;
  replyTo?: { id: string } | null;
}

type Reviewer = { __typename: string; login?: string } | null;

export type RawItem =
  | { __typename: 'PullRequestCommit'; commit: RawCommit }
  | {
      __typename: 'ReviewRequestedEvent' | 'ReviewRequestRemovedEvent';
      createdAt: string;
      actor: RawActor | null;
      requestedReviewer: Reviewer;
    }
  | {
      __typename: 'PullRequestReview';
      id: string;
      state: string;
      submittedAt: string | null;
      author: RawActor | null;
      body?: string | null;
      comments: RawComment[];
    }
  | { __typename: 'IssueComment'; createdAt: string; author: RawActor | null; body?: string | null }
  | { __typename: 'MergedEvent' | 'ClosedEvent' | 'ReopenedEvent'; createdAt: string; actor: RawActor | null }
  | { __typename: 'AssignedEvent' | 'UnassignedEvent'; createdAt: string; actor: RawActor | null; assignee: Reviewer }
  | { __typename: 'LabeledEvent' | 'UnlabeledEvent'; createdAt: string; actor: RawActor | null; label: { name: string } | null }
  | { __typename: Exclude<keyof typeof ACTIONS, 'AssignedEvent' | 'UnassignedEvent' | 'LabeledEvent' | 'UnlabeledEvent'>; createdAt: string; actor: RawActor | null };

export interface RawPull {
  id: string;
  repo: string;
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: RawActor | null;
  body?: string | null;
  items: RawItem[];
}

export interface RawPush {
  repo: string;
  commit: RawCommit;
  prs: number[];
}

export interface RawInput {
  window: Window;
  repos: number;
  reposWithPulls: number;
  reposWithPushes: number;
  pulls: RawPull[];
  pushes: RawPush[];
  commits: RawCommit[];
}

type Tally = 'requests' | 'teamRequests' | 'unrequests' | 'reviews' | 'holderReviews' | 'comments' | 'inlineComments' | 'commits' | 'merges' | 'closes' | 'reopens' | 'actions';

export interface Report {
  repos: number;
  reposWithPulls: number;
  reposWithPushes: number;
  pullsRead: number;
  pullsAfterWindow: number;
  pullsCreated: number;
  initial: number;
  inWindow: Record<Tally, number>;
  directPushes: number;
  links: number;
  features: Record<string, number>;
  events: Record<EventKind, number>;
  actors: number;
  bots: number;
  withEmail: number;
  checks: { label: string; ok: boolean }[];
  ok: boolean;
}

type Step = {
  t: number;
  kind: 'request' | 'unrequest' | 'review' | 'comment' | 'commit' | 'done' | 'reopen' | 'action' | 'assigned';
  tally: Tally;
  actor: string;
  target?: string | null;
  quiet?: boolean;
  feature?: string;
};

const BUILDING = 'github';
const GITHUB: Building = { id: BUILDING, region: INTERNAL_REGION, name: 'GitHub', resource: 'pr' };
const MERGE_CLOSE_SLACK = 60_000;
const NOREPLY = /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/;
const NO_REPLY = /^no-?reply@/;

export function toSourceFile(raw: RawInput): { file: SourceFile; report: Report } {
  const since = raw.window.start;
  const until = raw.window.end;
  const inWindow = (t: number) => t >= since && t <= until;

  const info = new Map<string, { bot: boolean; names: Map<string, number>; emails: Map<string, number> }>();
  const note = (key: string, bot: boolean, name?: string | null, email?: string | null) => {
    if (!info.has(key)) info.set(key, { bot: false, names: new Map(), emails: new Map() });
    const entry = info.get(key)!;
    entry.bot ||= bot;
    if (name) entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
    if (email) entry.emails.set(email, (entry.emails.get(email) ?? 0) + 1);
    return key;
  };

  const actorKey = (a: { login?: string; __typename: string } | null) => {
    const login = a?.login ?? 'ghost';
    const bot = a?.__typename === 'Bot' || login.endsWith('[bot]');
    return note(`github:${bot && !login.endsWith('[bot]') ? `${login}[bot]` : login}`, bot || AGENT_LOGINS.has(login));
  };

  const commitKey = (c: RawCommit, learn = false) => {
    const email = c.author?.email?.trim().toLowerCase() || null;
    const noreply = email?.match(NOREPLY)?.[1] ?? null;
    const login = c.author?.user?.login ?? noreply;
    const key = login ? `github:${login}` : email ? `github:email:${email}` : 'github:ghost';
    if (!learn) return note(key, !!login?.endsWith('[bot]') || AGENT_LOGINS.has(login ?? ''));
    return note(key, false, c.author?.name?.trim() || null, noreply || NO_REPLY.test(email ?? '') ? null : email);
  };
  for (const commit of [...raw.commits, ...raw.pushes.map((push) => push.commit)]) commitKey(commit, true);

  const events: SourceEvent[] = [];
  const initial: SourceHolding[] = [];
  const emit = (kind: EventKind, t: number, actor: string, resourceId: string | null, rest: Partial<SourceEvent> = {}) => {
    events.push({
      kind,
      t,
      actor,
      via: null,
      resource: resourceId ? 'pr' : null,
      resourceId,
      building: BUILDING,
      from: null,
      to: null,
      isReturn: false,
      count: 1,
      clientHint: null,
      ...rest,
    });
  };

  const tallies: Record<Tally, number> = {
    requests: 0,
    teamRequests: 0,
    unrequests: 0,
    reviews: 0,
    holderReviews: 0,
    comments: 0,
    inlineComments: 0,
    commits: 0,
    merges: 0,
    closes: 0,
    reopens: 0,
    actions: 0,
  };
  const found: Found[] = [];

  const seenPulls = new Set<string>();
  const pulls = raw.pulls
    .filter((pr) => !seenPulls.has(pr.id) && !!seenPulls.add(pr.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.repo.localeCompare(b.repo) || a.number - b.number);
  const oids = new Set<string>();
  let pullsAfterWindow = 0;
  let pullsCreated = 0;

  for (const pr of pulls) {
    const id = `${pr.repo}#${pr.number}`;
    const createdAt = Date.parse(pr.createdAt);
    if (createdAt > until) {
      pullsAfterWindow++;
      continue;
    }
    const author = actorKey(pr.author);
    const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : null;
    const text = (t: number, actor: string, body: string | null | undefined) => {
      for (const { link, name } of markdownLinks(body ?? '')) found.push({ t, actor, parent: refKey('pr', id), link, name, clientHint: null });
    };
    text(createdAt, author, pr.body);
    const inline = new Map<string, string>();
    for (const item of pr.items) {
      if (item.__typename === 'PullRequestReview') for (const c of item.comments) if (c.id) inline.set(c.id, actorKey(c.author));
    }

    const steps: Step[] = [];
    for (const item of pr.items) {
      switch (item.__typename) {
        case 'PullRequestCommit':
          if (oids.has(item.commit.oid)) break;
          oids.add(item.commit.oid);
          steps.push({ t: Date.parse(item.commit.committedDate), kind: 'commit', tally: 'commits', actor: commitKey(item.commit) });
          break;
        case 'ReviewRequestedEvent':
        case 'ReviewRequestRemovedEvent': {
          const target = item.requestedReviewer?.login ? actorKey(item.requestedReviewer) : null;
          const request = item.__typename === 'ReviewRequestedEvent';
          steps.push({
            t: Date.parse(item.createdAt),
            kind: request ? 'request' : 'unrequest',
            tally: request ? (target ? 'requests' : 'teamRequests') : 'unrequests',
            actor: actorKey(item.actor),
            target,
          });
          break;
        }
        case 'PullRequestReview': {
          if (!item.submittedAt || item.state === 'PENDING') break;
          const reviewer = actorKey(item.author);
          const t = Date.parse(item.submittedAt);
          steps.push({ t, kind: 'review', tally: 'reviews', actor: reviewer, quiet: item.comments.length > 0, feature: featureId(REVIEWS[item.state] ?? 'reviews') });
          text(t, reviewer, item.body);
          for (const c of item.comments) {
            const at = Date.parse(c.publishedAt ?? c.createdAt);
            const who = actorKey(c.author);
            const target = c.replyTo ? inline.get(c.replyTo.id) ?? null : null;
            steps.push({ t: at, kind: 'comment', tally: 'inlineComments', actor: who, target: target === who ? null : target, feature: featureId('inline-comments') });
            text(at, who, c.body);
          }
          break;
        }
        case 'IssueComment': {
          const t = Date.parse(item.createdAt);
          const who = actorKey(item.author);
          steps.push({ t, kind: 'comment', tally: 'comments', actor: who });
          text(t, who, item.body);
          break;
        }
        case 'MergedEvent':
          steps.push({ t: Date.parse(item.createdAt), kind: 'done', tally: 'merges', actor: actorKey(item.actor) });
          break;
        case 'ClosedEvent': {
          const t = Date.parse(item.createdAt);
          if (mergedAt !== null && t >= mergedAt - MERGE_CLOSE_SLACK) break;
          steps.push({ t, kind: 'done', tally: 'closes', actor: actorKey(item.actor) });
          break;
        }
        case 'ReopenedEvent':
          steps.push({ t: Date.parse(item.createdAt), kind: 'reopen', tally: 'reopens', actor: actorKey(item.actor) });
          break;
        default: {
          if (!(item.__typename in ACTIONS)) break;
          const assignee = item.__typename === 'AssignedEvent' && item.assignee?.login ? actorKey(item.assignee) : null;
          steps.push({
            t: Date.parse(item.createdAt),
            kind: assignee ? 'assigned' : 'action',
            tally: 'actions',
            actor: actorKey(item.actor),
            target: assignee,
            feature: featureId(ACTIONS[item.__typename]),
          });
        }
      }
    }
    const ordered = steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.t - b.s.t || a.i - b.i).map(({ s }) => s);

    if (inWindow(createdAt)) {
      pullsCreated++;
      emit('create', createdAt, author, id);
    }

    let holder = author;
    const held = new Set([author]);
    let atStart: string | null = null;
    for (const s of ordered) {
      if (atStart === null && s.t >= since) atStart = holder;
      const live = inWindow(s.t);
      if (live) tallies[s.tally]++;
      const out = (kind: EventKind, rest: Partial<SourceEvent> = {}) => {
        if (live) emit(kind, s.t, s.actor, id, rest);
      };
      switch (s.kind) {
        case 'request':
          if (!s.target || s.target === holder) {
            out('edit');
            break;
          }
          out('send', { from: holder, to: s.target, isReturn: held.has(s.target) });
          holder = s.target;
          held.add(s.target);
          break;
        case 'unrequest':
          if (s.target === holder) holder = author;
          break;
        case 'review':
          if (s.actor === holder && s.actor !== author) {
            if (live) tallies.holderReviews++;
            out('send', { from: holder, to: author, isReturn: true, feature: s.feature });
            holder = author;
          } else if (!s.quiet) out('comment', { to: holder, feature: s.feature });
          break;
        case 'comment':
          out('comment', { to: s.target ?? holder, ...(s.feature ? { feature: s.feature } : {}) });
          break;
        case 'assigned':
          if (s.target !== s.actor) out('assign', { to: s.target, feature: s.feature });
          else out('edit', { feature: s.feature });
          break;
        case 'action':
          out('edit', { feature: s.feature });
          break;
        case 'commit':
          out('edit');
          break;
        case 'done':
          out('done', { to: holder });
          break;
        case 'reopen':
          if (s.actor !== author) out('assign', { to: author });
          else out('edit');
          holder = author;
          break;
      }
    }

    if (createdAt < since) initial.push({ resource: 'pr', resourceId: id, holder: atStart ?? holder, building: BUILDING });
  }

  const pulled = new Set(pulls.map((pr) => `${pr.repo}#${pr.number}`));
  let directPushes = 0;
  const pushed = new Set<string>();
  for (const push of raw.pushes) {
    const t = Date.parse(push.commit.committedDate);
    if (!inWindow(t) || oids.has(push.commit.oid) || pushed.has(push.commit.oid)) continue;
    if (push.prs.some((n) => pulled.has(`${push.repo}#${n}`))) continue;
    pushed.add(push.commit.oid);
    directPushes++;
    emit('edit', t, commitKey(push.commit), null);
  }

  const attached = attach(found, new Map(), raw.window, GITHUB, 'Links');
  events.push(...attached.events);
  events.sort((a, b) => a.t - b.t);
  const own = featuresOf(events.flatMap((e) => (e.feature ? [e.feature] : [])));
  const features = [...own, ...attached.features.filter((f) => !own.some((o) => o.id === f.id))];
  const featureCounts: Record<string, number> = {};
  for (const e of events) if (e.feature) featureCounts[e.feature] = (featureCounts[e.feature] ?? 0) + 1;

  const used = [...events.flatMap((e) => [e.actor, e.from, e.to]), ...initial.map((h) => h.holder)].filter(
    (k): k is string => !!k,
  );
  const top = (counts: Map<string, number>) =>
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const onCompanyDomain = (email: string) => config.org.domains.includes(email.slice(email.lastIndexOf('@') + 1));
  const actors: ActorRef[] = [...new Set(used)].sort().map((key) => {
    const entry = info.get(key)!;
    return {
      key,
      email: top(new Map([...entry.emails].filter(([email]) => onCompanyDomain(email)))) ?? top(entry.emails),
      name: top(entry.names) ?? key.slice(key.lastIndexOf(':') + 1),
      kind: entry.bot ? 'automation' : 'person',
      groupHint: null,
      clientHint: null,
    };
  });

  const counts: Report['events'] = { create: 0, send: 0, assign: 0, comment: 0, done: 0, edit: 0, bulk: 0, use: 0, run: 0, error: 0, status: 0 };
  for (const e of events) counts[e.kind]++;
  const actorKeys = new Set(actors.map((a) => a.key));

  const checks = [
    { label: 'every actor key used is listed in actors', ok: used.every((key) => actorKeys.has(key)) },
    { label: 'create events = pull requests opened in the window + linked files first seen', ok: counts.create === pullsCreated + attached.events.length },
    {
      label: 'done events = in-window merges + closes',
      ok: counts.done === tallies.merges + tallies.closes,
    },
    {
      label: 'sends + edits + assigns account for every in-window request, review, commit, reopen and finer timeline action',
      ok:
        counts.send + counts.edit + counts.assign ===
        tallies.requests + tallies.teamRequests + tallies.holderReviews + tallies.commits + tallies.reopens + tallies.actions + directPushes,
    },
    { label: 'inline comment events = in-window inline review comments', ok: (featureCounts[featureId('inline-comments')] ?? 0) === tallies.inlineComments },
    { label: 'every event feature is listed in features', ok: events.every((e) => !e.feature || features.some((f) => f.id === e.feature)) },
    { label: 'every send moves a pull request between two different actors', ok: events.every((e) => e.kind !== 'send' || (!!e.from && !!e.to && e.from !== e.to)) },
  ];

  return {
    file: {
      schemaVersion: SCHEMA_VERSION,
      source: 'github',
      window: raw.window,
      actors,
      buildings: [GITHUB, ...attached.buildings.filter((b) => b.id !== BUILDING)],
      features,
      events,
      initial,
      sessions: [],
      measures: [],
      artifacts: [],
      links: ticketsFirst(attached.links),
    },
    report: {
      repos: raw.repos,
      reposWithPulls: raw.reposWithPulls,
      reposWithPushes: raw.reposWithPushes,
      pullsRead: pulls.length,
      pullsAfterWindow,
      pullsCreated,
      initial: initial.length,
      inWindow: tallies,
      directPushes,
      links: attached.links.length,
      features: featureCounts,
      events: counts,
      actors: actors.length,
      bots: actors.filter((a) => a.kind === 'automation').length,
      withEmail: actors.filter((a) => a.email).length,
      checks,
      ok: checks.every((c) => c.ok),
    },
  };
}

export function printReport(report: Report) {
  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('GitHub source');
  row('repos scanned', report.repos);
  row('  with pull requests pulled', report.reposWithPulls);
  row('  with default branch pushes', report.reposWithPushes);
  row('pull requests read', report.pullsRead);
  row('  opened in the window', report.pullsCreated);
  row('  existing at window start', report.initial);
  row('  opened after the window', report.pullsAfterWindow);
  console.log('In-window timeline');
  for (const [kind, count] of Object.entries(report.inWindow)) row(kind, count);
  row('direct pushes to default branch', report.directPushes);
  row('links to other resources', report.links);
  console.log('Events in action cells');
  for (const [feature, count] of Object.entries(report.features).sort()) row(feature, count);
  row('actors', report.actors);
  row('  bots', report.bots);
  row('  with a commit email', report.withEmail);
  console.log('Events before the bulk rule');
  for (const [kind, count] of Object.entries(report.events)) if (kind !== 'bulk') row(kind, count);
  console.log('Checks');
  for (const check of report.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
}
