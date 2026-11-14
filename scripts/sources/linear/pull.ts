import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../../src/schema';
import { config, secret } from '../../lib/config';
import { describeWindow } from '../../lib/window';

export const RAW = path.resolve('data/raw/linear');
const STATE_FILE = path.join(RAW, 'state.json');
const RESERVE = 0.1;
const SHAPE = 3;

const HISTORY_FIELDS =
  'id createdAt actor { id } botActor { name } fromAssignee { id } toAssignee { id } fromState { type name } toState { type name } ' +
  'fromPriority toPriority fromEstimate toEstimate fromCycle { number } toCycle { number } fromProject { name } toProject { name } ' +
  'fromProjectMilestone { name } toProjectMilestone { name } fromDueDate toDueDate fromTitle toTitle updatedDescription ' +
  'addedLabels { name } removedLabels { name } fromParent { identifier } toParent { identifier } relationChanges { identifier type } ' +
  'fromTeam { key } toTeam { key } fromDelegate { id } toDelegate { id } attachment { id } archived trashed autoArchived autoClosed customerNeedId';
const REACTION_FIELDS = 'reactions { id emoji createdAt user { id } }';
const COMMENT_FIELDS = `id createdAt editedAt resolvedAt user { id } botActor { name } externalUser { name } parent { id } resolvingUser { id } body ${REACTION_FIELDS}`;

const ISSUES_QUERY = `query($after: String, $since: DateTimeOrDuration!) {
  issues(first: 15, after: $after, filter: {updatedAt: {gt: $since}}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title createdAt description
      attachments(first: 20) { nodes { id url title createdAt creator { id } } }
      team { key }
      project { name }
      creator { id }
      botActor { name }
      assignee { id }
      state { type name }
      parent { identifier }
      labels(first: 20) { nodes { name } }
      relations(first: 20) { nodes { type relatedIssue { identifier } } }
      inverseRelations(first: 20) { nodes { type issue { identifier } } }
      ${REACTION_FIELDS}
      history(first: 40) {
        pageInfo { hasNextPage endCursor }
        nodes { ${HISTORY_FIELDS} }
      }
      comments(first: 25) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

const HISTORY_QUERY = `query($id: String!, $after: String) {
  issue(id: $id) {
    id
    history(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${HISTORY_FIELDS} }
    }
  }
}`;

export const COMMENTS_QUERY = `query($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT_FIELDS} }
    }
  }
}`;

const DELIVERY_FILTER = '$team: String!, $after: String, $gte: DateTimeOrDuration!, $lt: DateTimeOrDuration!';
const DELIVERY_FIELDS = 'identifier title createdAt startedAt completedAt parent { id } state { name } labels(first: 20) { nodes { name } }';

const CREATIVE_DONE_QUERY = `query(${DELIVERY_FILTER}) {
  issues(first: 50, after: $after, filter: {team: {key: {eq: $team}}, completedAt: {gte: $gte, lt: $lt}}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${DELIVERY_FIELDS} }
  }
}`;

const CREATIVE_OPEN_QUERY = `query($team: String!, $after: String) {
  issues(first: 50, after: $after, filter: {team: {key: {eq: $team}}, state: {type: {eq: "started"}}}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${DELIVERY_FIELDS} }
  }
}`;

const ENG_DONE_QUERY = `query(${DELIVERY_FILTER}) {
  issues(first: 50, after: $after, filter: {team: {key: {eq: $team}}, completedAt: {gte: $gte, lt: $lt}}) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier createdAt completedAt attachments(first: 50) { nodes { url metadata } } }
  }
}`;

const USERS_QUERY = `query($after: String) {
  users(first: 100, after: $after, includeDisabled: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id name displayName email active }
  }
}`;

interface Connection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { createdAt?: string }[];
}

interface State {
  start: number;
  end: number;
  complete: boolean;
  shape?: number;
}

export class QuotaStop extends Error {}

let apiKey: string | null = null;
let requests = 0;
let quota: { kind: string; remaining: number; limit: number; reset: number }[] = [];

function key() {
  if (!apiKey) apiKey = secret('LINEAR_API_KEY');
  return apiKey;
}

async function gql(query: string, variables: Record<string, unknown>, reserve = RESERVE) {
  for (const q of quota) {
    if (q.limit > 0 && q.remaining < q.limit * reserve) {
      throw new QuotaStop(
        `Linear ${q.kind} quota is down to ${q.remaining} of ${q.limit}. Every page so far is saved. ` +
          `Run \`npm run pull\` again after ${new Date(q.reset).toLocaleTimeString()} to resume.`,
      );
    }
  }
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key() },
    body: JSON.stringify({ query, variables }),
  });
  requests++;
  const text = await res.text();
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${text.slice(0, 600)}`);
  const body = JSON.parse(text);
  if (body.errors?.length || !body.data) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(body.errors ?? body).slice(0, 600)}`);
  }
  const header = (name: string) => Number(res.headers.get(name));
  quota = ['requests', 'complexity']
    .map((kind) => ({
      kind,
      remaining: header(`x-ratelimit-${kind}-remaining`),
      limit: header(`x-ratelimit-${kind}-limit`),
      reset: header(`x-ratelimit-${kind}-reset`),
    }))
    .filter((q) => Number.isFinite(q.remaining) && Number.isFinite(q.limit) && res.headers.has(`x-ratelimit-${q.kind}-limit`));
  return { text, data: body.data, complexity: res.headers.get('x-complexity') };
}

export function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function savePage(dir: string, n: number, text: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(n).padStart(5, '0')}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export const readData = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).data;

function quotaLine() {
  return quota.map((q) => `${q.kind} ${q.remaining}/${q.limit}`).join(' · ');
}

export async function pageThrough(opts: {
  dir: string;
  label: string;
  query: string;
  variables: Record<string, unknown>;
  pick: (data: any) => Connection;
  more: (conn: Connection) => boolean;
  first?: Connection;
  reserve?: number;
}) {
  const saved = pagesIn(opts.dir);
  let count = saved.length;
  let last: Connection | null = count ? opts.pick(readData(saved[count - 1])) : opts.first ?? null;
  while (!last || opts.more(last)) {
    const after = last?.pageInfo.endCursor ?? null;
    const { text, data, complexity } = await gql(opts.query, { ...opts.variables, after }, opts.reserve);
    count++;
    savePage(opts.dir, count, text);
    last = opts.pick(data);
    console.log(
      `${opts.label} page ${count}: ${last.nodes.length} rows · complexity ${complexity ?? '?'} · ${quotaLine()}`,
    );
  }
  return count;
}

function saveState(state: State) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export const requestCount = () => requests;

export async function pull(window: Window) {
  const old: State | null = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
  if (old && old.shape !== SHAPE && old.start === window.start && old.end === window.end) {
    console.log('data/raw/linear was pulled before issues kept their full history, reactions, labels and relations. Pulling the issues again.');
    for (const name of ['issues', 'history', 'comments', 'state.json']) fs.rmSync(path.join(RAW, name), { recursive: true, force: true });
  }
  const resumed = fs.existsSync(STATE_FILE);
  const state: State = resumed
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { start: window.start, end: window.end, complete: false, shape: SHAPE };
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error(
      'data/raw/linear was pulled for a different window than data/window.json. Remove data/raw/linear to pull this window.',
    );
  }
  if (!resumed) saveState(state);
  console.log(`Window ${describeWindow(window)}${resumed ? ' (resuming data/raw/linear)' : ''}`);
  if (state.complete) {
    console.log('This window is already fully pulled. Remove data/window.json and data/raw to pull a new week.');
    return;
  }
  const since = window.start;
  const sinceIso = new Date(since).toISOString();
  const hasNext = (conn: Connection) => conn.pageInfo.hasNextPage;
  const needsMore = (conn: Connection) =>
    conn.pageInfo.hasNextPage &&
    conn.nodes.length > 0 &&
    Math.min(...conn.nodes.map((n) => Date.parse(n.createdAt!))) >= since;

  await pageThrough({
    dir: path.join(RAW, 'users'),
    label: 'users',
    query: USERS_QUERY,
    variables: {},
    pick: (data) => data.users,
    more: hasNext,
  });

  await pageThrough({
    dir: path.join(RAW, 'issues'),
    label: 'issues',
    query: ISSUES_QUERY,
    variables: { since: sinceIso },
    pick: (data) => data.issues,
    more: hasNext,
  });

  let issues = 0;
  for (const file of pagesIn(path.join(RAW, 'issues'))) {
    for (const issue of readData(file).issues.nodes) {
      issues++;
      for (const [field, query] of [
        ['history', HISTORY_QUERY],
        ['comments', COMMENTS_QUERY],
      ] as const) {
        const dir = path.join(RAW, field, issue.id);
        if (!needsMore(issue[field]) && !fs.existsSync(dir)) continue;
        await pageThrough({
          dir,
          label: `${field} ${issue.identifier}`,
          query,
          variables: { id: issue.id },
          pick: (data) => data.issue[field],
          more: needsMore,
          first: issue[field],
        });
      }
    }
  }

  state.complete = true;
  saveState(state);
  console.log(`Pull complete: ${issues} issues, ${requests} API requests this run.`);
}

export interface DeliveredIssue {
  identifier: string;
  title: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  parent: { id: string } | null;
  state: { name: string };
  labels: { nodes: { name: string }[] };
}

export interface MergedIssue {
  identifier: string;
  createdAt: string;
  completedAt: string;
  attachments: { nodes: { url: string | null; metadata: Record<string, unknown> | null }[] };
}

const DELIVERY = path.join(RAW, 'delivery');
const deliveryDir = (name: string) => path.join(DELIVERY, name);

export async function pullDelivery(window: Window) {
  const range = { gte: new Date(window.start).toISOString(), lt: new Date(window.end).toISOString() };
  const hasNext = (conn: Connection) => conn.pageInfo.hasNextPage;
  const { conceptTeam, engTeam } = config.linear;
  for (const [name, query, team, variables] of [
    ['creative-done', CREATIVE_DONE_QUERY, conceptTeam, range],
    ['creative-open', CREATIVE_OPEN_QUERY, conceptTeam, {}],
    ['eng-done', ENG_DONE_QUERY, engTeam, range],
  ] as const) {
    if (!team) continue;
    await pageThrough({ dir: deliveryDir(name), label: name, query, variables: { ...variables, team }, pick: (data) => data.issues, more: hasNext });
  }
}

export function readDelivery() {
  const nodes = <T>(name: string): T[] => pagesIn(deliveryDir(name)).flatMap((file) => readData(file).issues.nodes);
  const open = pagesIn(deliveryDir('creative-open'));
  return {
    creativeDone: nodes<DeliveredIssue>('creative-done'),
    creativeOpen: nodes<DeliveredIssue>('creative-open'),
    engDone: nodes<MergedIssue>('eng-done'),
    openAt: open.length ? fs.statSync(open[0]).mtimeMs : null,
    engPulled: pagesIn(deliveryDir('eng-done')).length > 0,
  };
}
