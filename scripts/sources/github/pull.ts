import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../../src/schema';
import { config, setting } from '../../lib/config';
import { describeWindow } from '../../lib/window';
import type { RawComment, RawCommit, RawItem, RawPull, RawPush } from './convert';

export const RAW = path.resolve('data/raw/github');
const STATE_FILE = path.join(RAW, 'state.json');
const RESERVE = 0.1;
const SHAPE = 2;

const RATE = 'rateLimit { cost remaining limit resetAt }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const ACTOR = 'login __typename';
const COMMIT = 'oid committedDate author { name email user { login } }';
const COMMENTS = `${PAGE_INFO} nodes { id createdAt publishedAt author { ${ACTOR} } body path replyTo { id } }`;
const REVIEWER = 'requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } }';
const ASSIGNEE = 'assignee { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } }';
const ITEM_TYPES = [
  'PULL_REQUEST_COMMIT',
  'REVIEW_REQUESTED_EVENT',
  'REVIEW_REQUEST_REMOVED_EVENT',
  'PULL_REQUEST_REVIEW',
  'ISSUE_COMMENT',
  'MERGED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'HEAD_REF_FORCE_PUSHED_EVENT',
  'RENAMED_TITLE_EVENT',
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT',
  'REVIEW_DISMISSED_EVENT',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'AUTO_MERGE_ENABLED_EVENT',
].join(', ');
const ACTED = `createdAt actor { ${ACTOR} }`;
const ITEMS = `${PAGE_INFO} nodes {
  __typename
  ... on PullRequestCommit { commit { ${COMMIT} } }
  ... on ReviewRequestedEvent { ${ACTED} ${REVIEWER} }
  ... on ReviewRequestRemovedEvent { ${ACTED} ${REVIEWER} }
  ... on PullRequestReview { id state submittedAt author { ${ACTOR} } body comments(first: 50) { ${COMMENTS} } }
  ... on IssueComment { createdAt author { ${ACTOR} } body }
  ... on MergedEvent { ${ACTED} }
  ... on ClosedEvent { ${ACTED} }
  ... on ReopenedEvent { ${ACTED} }
  ... on HeadRefForcePushedEvent { ${ACTED} }
  ... on RenamedTitleEvent { ${ACTED} }
  ... on LabeledEvent { ${ACTED} label { name } }
  ... on UnlabeledEvent { ${ACTED} label { name } }
  ... on ReadyForReviewEvent { ${ACTED} }
  ... on ConvertToDraftEvent { ${ACTED} }
  ... on ReviewDismissedEvent { ${ACTED} }
  ... on AssignedEvent { ${ACTED} ${ASSIGNEE} }
  ... on UnassignedEvent { ${ACTED} ${ASSIGNEE} }
  ... on AutoMergeEnabledEvent { ${ACTED} }
}`;

const REPOS_QUERY = `query($org: String!, $after: String) {
  ${RATE}
  organization(login: $org) {
    repositories(first: 100, after: $after, orderBy: {field: NAME, direction: ASC}) {
      ${PAGE_INFO}
      nodes { name pushedAt pullRequests(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { updatedAt } } }
    }
  }
}`;

const PULLS_QUERY = `query($org: String!, $name: String!, $after: String) {
  ${RATE}
  repository(owner: $org, name: $name) {
    pullRequests(first: 10, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      ${PAGE_INFO}
      nodes {
        id number createdAt updatedAt mergedAt closedAt body
        author { ${ACTOR} }
        timelineItems(first: 100, itemTypes: [${ITEM_TYPES}]) { ${ITEMS} }
      }
    }
  }
}`;

const TIMELINE_QUERY = `query($id: ID!, $after: String) {
  ${RATE}
  node(id: $id) { ... on PullRequest { timelineItems(first: 100, after: $after, itemTypes: [${ITEM_TYPES}]) { ${ITEMS} } } }
}`;

const REVIEW_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  ${RATE}
  node(id: $id) { ... on PullRequestReview { comments(first: 100, after: $after) { ${COMMENTS} } } }
}`;

const HISTORY_QUERY = `query($org: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
  ${RATE}
  repository(owner: $org, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $after, since: $since, until: $until) {
            ${PAGE_INFO}
            nodes { ${COMMIT} associatedPullRequests(first: 5) { nodes { number } } }
          }
        }
      }
    }
  }
}`;

interface Connection<T = any> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface Repo {
  name: string;
  pushedAt: string | null;
  pullRequests: { nodes: { updatedAt: string }[] };
}

interface State {
  start: number;
  end: number;
  complete: boolean;
  shape?: number;
}

export class QuotaStop extends Error {}

const EMPTY: Connection = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

let requests = 0;
let rate: { cost: number; remaining: number; limit: number; resetAt: string } | null = null;

function failure(err: unknown) {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const stdout = (err as { stdout?: unknown })?.stdout;
  const text = [stderr, stdout].filter((s): s is string => typeof s === 'string' && !!s.trim()).join(' ');
  return (text || (err instanceof Error ? err.message : String(err))).replace(/\s+/g, ' ').trim().slice(0, 600);
}

function gql(query: string, variables: Record<string, unknown>) {
  if (rate && rate.remaining < rate.limit * RESERVE) {
    throw new QuotaStop(
      `GitHub GraphQL quota is down to ${rate.remaining} of ${rate.limit}. Every page so far is saved. ` +
        `Run \`npm run pull:github\` again after ${new Date(rate.resetAt).toLocaleTimeString()} to resume.`,
    );
  }
  let text: string;
  try {
    requests++;
    text = execFileSync('gh', ['api', 'graphql', '--method', 'POST', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`gh api graphql: ${failure(err)}`);
  }
  const body = JSON.parse(text);
  if (body.errors?.length || !body.data) throw new Error(`GitHub GraphQL error: ${JSON.stringify(body.errors ?? body).slice(0, 600)}`);
  rate = body.data.rateLimit;
  return body.data;
}

export function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function savePage(dir: string, n: number, value: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(n).padStart(5, '0')}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const readPage = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

function pageThrough(opts: {
  dir: string;
  label: string;
  query: string;
  variables: Record<string, unknown>;
  pick: (data: any) => Connection;
  more: (conn: Connection) => boolean;
  first?: Connection;
}) {
  const saved = pagesIn(opts.dir);
  let count = saved.length;
  let last: Connection | null = count ? opts.pick(readPage(saved[count - 1])) : opts.first ?? null;
  while (!last || opts.more(last)) {
    const data = gql(opts.query, { ...opts.variables, after: last?.pageInfo.endCursor ?? null });
    count++;
    savePage(opts.dir, count, data);
    last = opts.pick(data);
    console.log(
      `${opts.label} page ${count}: ${last.nodes.length} rows · cost ${rate?.cost ?? '?'} · ${rate?.remaining ?? '?'}/${rate?.limit ?? '?'}`,
    );
  }
  return count;
}

const dirOf = (...parts: string[]) => path.join(RAW, ...parts);
const reviewDir = (id: string) => dirOf('review-comments', id.replace(/[^A-Za-z0-9_-]/g, '_'));
const pickRepos = (data: any): Connection<Repo> => data.organization.repositories;
const pickPulls = (data: any): Connection => data.repository.pullRequests;
const pickTimeline = (data: any): Connection => data.node.timelineItems;
const pickComments = (data: any): Connection => data.node.comments;
const pickHistory = (data: any): Connection => data.repository.defaultBranchRef?.target?.history ?? EMPTY;
const hasNext = (conn: Connection) => conn.pageInfo.hasNextPage;
const readAll = <T>(dir: string, pick: (data: any) => Connection<T>) => pagesIn(dir).flatMap((file) => pick(readPage(file)).nodes);

function readRepos() {
  return readAll(dirOf('repos'), pickRepos);
}

function pullsOf(repo: string, since: number) {
  return readAll(dirOf('pulls', repo), pickPulls).filter((pr) => Date.parse(pr.updatedAt) >= since);
}

function timelineOf(repo: string, pr: any): any[] {
  return [...pr.timelineItems.nodes, ...readAll(dirOf('timeline', repo, String(pr.number)), pickTimeline)];
}

function saveState(state: State) {
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export const requestCount = () => requests;

export function pull(window: Window) {
  const old: State | null = fs.existsSync(STATE_FILE) ? readPage(STATE_FILE) : null;
  if (old && old.shape !== SHAPE && old.start === window.start && old.end === window.end) {
    console.log('data/raw/github was pulled before pull requests kept their bodies, comment text and the finer timeline events. Pulling the pull requests again.');
    for (const name of ['pulls', 'timeline', 'review-comments', 'state.json']) fs.rmSync(path.join(RAW, name), { recursive: true, force: true });
  }
  const resumed = fs.existsSync(STATE_FILE);
  const state: State = resumed
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { start: window.start, end: window.end, complete: false, shape: SHAPE };
  if (state.start !== window.start || state.end !== window.end) {
    throw new Error(
      'data/raw/github was pulled for a different window than data/window.json. Remove data/raw/github to pull this window.',
    );
  }
  if (!resumed) saveState(state);
  console.log(`Window ${describeWindow(window)}${resumed ? ' (resuming data/raw/github)' : ''}`);
  if (state.complete) {
    console.log('This window is already fully pulled. Remove data/window.json and data/raw to pull a new week.');
    return;
  }
  const since = window.start;
  const recent = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= since;
  const ORG = setting(config.github.org, 'github.org');

  pageThrough({ dir: dirOf('repos'), label: 'repos', query: REPOS_QUERY, variables: { org: ORG }, pick: pickRepos, more: hasNext });
  const repos = readRepos();

  let pulls = 0;
  for (const repo of repos) {
    const dir = dirOf('pulls', repo.name);
    if (!recent(repo.pullRequests.nodes[0]?.updatedAt) && !fs.existsSync(dir)) continue;
    pageThrough({
      dir,
      label: `pulls ${repo.name}`,
      query: PULLS_QUERY,
      variables: { org: ORG, name: repo.name },
      pick: pickPulls,
      more: (conn) => conn.pageInfo.hasNextPage && conn.nodes.length > 0 && recent(conn.nodes[conn.nodes.length - 1].updatedAt),
    });
    for (const pr of pullsOf(repo.name, since)) {
      pulls++;
      if (Date.parse(pr.createdAt) > window.end) continue;
      const timelineDir = dirOf('timeline', repo.name, String(pr.number));
      if (pr.timelineItems.pageInfo.hasNextPage || fs.existsSync(timelineDir)) {
        pageThrough({
          dir: timelineDir,
          label: `timeline ${repo.name}#${pr.number}`,
          query: TIMELINE_QUERY,
          variables: { id: pr.id },
          pick: pickTimeline,
          more: hasNext,
          first: pr.timelineItems,
        });
      }
      for (const item of timelineOf(repo.name, pr)) {
        if (item.__typename !== 'PullRequestReview') continue;
        const commentsDir = reviewDir(item.id);
        if (!item.comments.pageInfo.hasNextPage && !fs.existsSync(commentsDir)) continue;
        pageThrough({
          dir: commentsDir,
          label: `review comments ${repo.name}#${pr.number}`,
          query: REVIEW_COMMENTS_QUERY,
          variables: { id: item.id },
          pick: pickComments,
          more: hasNext,
          first: item.comments,
        });
      }
    }
  }

  for (const repo of repos) {
    if (!recent(repo.pushedAt)) continue;
    pageThrough({
      dir: dirOf('history', repo.name),
      label: `default branch ${repo.name}`,
      query: HISTORY_QUERY,
      variables: { org: ORG, name: repo.name, since: new Date(since).toISOString(), until: new Date(window.end).toISOString() },
      pick: pickHistory,
      more: hasNext,
    });
  }

  state.complete = true;
  saveState(state);
  console.log(`Pull complete: ${repos.length} repos, ${pulls} pull requests, ${requests} API requests this run.`);
}

export function readRaw() {
  const since = readPage(STATE_FILE).start;
  const repos = readRepos();
  const pulls: RawPull[] = [];
  const pushes: RawPush[] = [];
  const commits: RawCommit[] = [];
  for (const repo of repos) {
    for (const pr of readAll(dirOf('pulls', repo.name), pickPulls)) {
      for (const item of timelineOf(repo.name, pr)) if (item.__typename === 'PullRequestCommit') commits.push(item.commit);
      if (Date.parse(pr.updatedAt) < since) continue;
      const items: RawItem[] = timelineOf(repo.name, pr).map((item) => {
        if (item.__typename !== 'PullRequestReview') return item;
        const comments: RawComment[] = [...item.comments.nodes, ...readAll(reviewDir(item.id), pickComments)];
        return { ...item, comments };
      });
      pulls.push({
        id: pr.id,
        repo: repo.name,
        number: pr.number,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        closedAt: pr.closedAt,
        author: pr.author,
        body: pr.body ?? null,
        items,
      });
    }
    for (const node of readAll(dirOf('history', repo.name), pickHistory)) {
      const { associatedPullRequests, ...commit } = node;
      pushes.push({ repo: repo.name, commit: commit as RawCommit, prs: associatedPullRequests.nodes.map((n: any) => n.number) });
    }
  }
  return {
    repos: repos.length,
    reposWithPulls: repos.filter((r) => pagesIn(dirOf('pulls', r.name)).length).length,
    reposWithPushes: repos.filter((r) => pagesIn(dirOf('history', r.name)).length).length,
    pulls,
    pushes,
    commits,
  };
}

const AUTHORS_FILE = path.join(RAW, 'authors.json');

export function pullAuthors(logins: string[]) {
  const saved: Record<string, string> = fs.existsSync(AUTHORS_FILE) ? readPage(AUTHORS_FILE) : {};
  for (const login of logins) {
    if (saved[login]) continue;
    requests++;
    try {
      saved[login] = String(JSON.parse(execFileSync('gh', ['api', `users/${login}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).id);
    } catch (err) {
      throw new Error(`gh api users/${login}: ${failure(err)}`);
    }
    fs.writeFileSync(AUTHORS_FILE, JSON.stringify(saved, null, 2));
  }
}

export const readAuthors = (): Record<string, string> => (fs.existsSync(AUTHORS_FILE) ? readPage(AUTHORS_FILE) : {});
