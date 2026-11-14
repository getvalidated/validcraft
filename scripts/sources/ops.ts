import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_REGION, SCHEMA_VERSION, type ActorRef, type Building, type EventKind, type Feature, type ResourceType, type SourceEvent, type SourceFile, type Window } from '../../src/schema';
import { config } from '../lib/config';
import { describeWindow, loadWindow } from '../lib/window';
import { Skip, failure, iso, openState, pagesIn, readPage, savePage, saveState, secretOrSkip } from './sessions/shared';

const RAW = path.resolve('data/raw/ops');
const OUT = path.resolve('data/sources/ops.json');
const MINUTE = 60_000;
const DAY = 86_400_000;
const RUN_CEILING = 1000;

interface Incident {
  id: string;
  created: number;
  closed: number | null;
  severity: string | null;
  creator: string | null;
  roles: { role: string; email: string }[];
}

interface Deploy {
  id: string;
  project: string;
  t: number;
  state: string;
  email: string | null;
  login: string | null;
  target?: string | null;
  source?: string | null;
}

interface Run {
  id: string;
  repo: string;
  t: number;
  login: string | null;
  bot: boolean;
  conclusion: string | null;
  workflow?: string | null;
  trigger?: string | null;
}

let requests = 0;

async function getJson(label: string, url: string, headers: Record<string, string>) {
  requests++;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const load = <T>(name: string) => pagesIn(path.join(RAW, name)).flatMap((file) => readPage<T[]>(file));

async function pullIncidents(window: Window) {
  const dir = path.join(RAW, 'incidents');
  const state = openState(dir, window);
  if (state.complete) return;
  const headers = { Authorization: `Bearer ${secretOrSkip('INCIDENT_IO_API_KEY')}` };
  fs.rmSync(dir, { recursive: true, force: true });
  let after = '';
  for (let page = 1; ; page++) {
    const body = await getJson('incident.io incidents', `https://api.incident.io/v2/incidents?page_size=250&updated_at%5Bgte%5D=${iso(window.start).slice(0, 10)}${after ? `&after=${after}` : ''}`, headers);
    const incidents: Incident[] = (body.incidents ?? []).map((i: any) => {
      const stamp = (i.incident_timestamp_values ?? [])
        .filter((v: any) => /resolved|closed/i.test(v.incident_timestamp?.name ?? '') && v.value?.value)
        .map((v: any) => Date.parse(v.value.value))
        .sort((a: number, b: number) => a - b)[0];
      return {
        id: String(i.reference ?? i.id),
        created: Date.parse(i.created_at),
        closed: Number.isFinite(stamp) ? stamp : null,
        severity: i.severity?.name ?? null,
        creator: i.creator?.user?.email?.toLowerCase() ?? null,
        roles: (i.incident_role_assignments ?? [])
          .filter((a: any) => a.assignee?.email)
          .map((a: any) => ({ role: String(a.role?.name ?? 'Responder'), email: String(a.assignee.email).toLowerCase() })),
      };
    });
    savePage(dir, page, incidents);
    after = body.pagination_meta?.after ?? '';
    if (!after || !incidents.length) break;
  }
  saveState(dir, { ...state, complete: true });
}

async function pullDeploys(window: Window) {
  const dir = path.join(RAW, 'deploys');
  const state = openState(dir, window);
  if (state.complete) return;
  const headers = { Authorization: `Bearer ${secretOrSkip('VERCEL_TOKEN')}` };
  const team = (await getJson('Vercel teams', 'https://api.vercel.com/v2/teams?limit=1', headers)).teams?.[0]?.id;
  if (!team) throw new Skip('the Vercel token sees no team');
  fs.rmSync(dir, { recursive: true, force: true });
  let until = window.end;
  for (let page = 1; ; page++) {
    const body = await getJson('Vercel deployments', `https://api.vercel.com/v6/deployments?teamId=${team}&limit=100&since=${window.start}&until=${until}`, headers);
    const deploys: Deploy[] = (body.deployments ?? []).map((d: any) => ({
      id: String(d.uid),
      project: String(d.name ?? 'unnamed-project'),
      t: Number(d.created ?? d.createdAt),
      state: String(d.readyState ?? d.state ?? ''),
      email: d.creator?.email?.toLowerCase() ?? null,
      login: d.creator?.githubLogin ?? d.meta?.githubCommitAuthorLogin ?? null,
      target: d.target ?? null,
      source: d.source ?? null,
    }));
    savePage(dir, page, deploys);
    const next = body.pagination?.next;
    if (!next || !deploys.length) break;
    until = next;
  }
  saveState(dir, { ...state, complete: true });
}

function gh(args: string[]) {
  requests++;
  try {
    return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    throw new Error(`gh api ${args[0]}: ${failure(err)}`);
  }
}

function pullRuns(window: Window) {
  const dir = path.join(RAW, 'runs');
  const state = openState(dir, window) as ReturnType<typeof openState> & { repos?: string[]; done?: string[] };
  if (state.complete) return;
  const ORG = config.github.org;
  if (!ORG) throw new Skip('github.org is not set in rts.config.json');
  if (!state.repos) {
    const repos: string[] = [];
    for (let page = 1; ; page++) {
      const list: any[] = gh([`orgs/${ORG}/repos?per_page=100&page=${page}`]);
      repos.push(...list.filter((r) => !r.archived && Date.parse(r.pushed_at) >= window.start - 30 * DAY).map((r) => String(r.name)));
      if (list.length < 100) break;
    }
    state.repos = repos.sort();
    state.done = [];
    saveState(dir, state);
  }
  const done = new Set(state.done);
  let page = pagesIn(dir).length;
  for (const repo of state.repos) {
    if (done.has(repo)) continue;
    const runs: Run[] = [];
    const spans: [number, number][] = [[window.start, window.end]];
    while (spans.length) {
      const [from, to] = spans.pop()!;
      const range = `${iso(from).slice(0, 19)}Z..${iso(to - 1000).slice(0, 19)}Z`;
      for (let n = 1; ; n++) {
        const body = gh([`repos/${ORG}/${repo}/actions/runs?per_page=100&page=${n}&created=${range}`]);
        if (n === 1 && body.total_count > RUN_CEILING && to - from > 2 * MINUTE) {
          const mid = from + Math.floor((to - from) / 2 / MINUTE) * MINUTE;
          spans.push([from, mid], [mid, to]);
          break;
        }
        for (const r of body.workflow_runs ?? []) {
          const who = r.triggering_actor ?? r.actor;
          runs.push({
            id: String(r.id),
            repo,
            t: Date.parse(r.run_started_at ?? r.created_at),
            login: who?.login ?? null,
            bot: who?.type === 'Bot',
            conclusion: r.conclusion ?? null,
            workflow: r.name ?? null,
            trigger: r.event ?? null,
          });
        }
        if ((body.workflow_runs ?? []).length < 100) break;
      }
    }
    savePage(dir, ++page, runs);
    done.add(repo);
    state.done = [...done];
    saveState(dir, state);
    console.log(`actions runs ${repo}: ${runs.length}`);
  }
  saveState(dir, { ...state, complete: true });
}

const INCIDENTS: Building = { id: 'incidents', region: INTERNAL_REGION, name: 'Incidents', resource: 'incident' };
const VERCEL: Building = { id: 'vercel', region: INTERNAL_REGION, name: 'Vercel', resource: 'deploy' };
const ACTIONS: Building = { id: 'github-actions', region: INTERNAL_REGION, name: 'GitHub Actions', resource: 'build' };
const AGENT_LOGINS = new Set(['claude', 'cursoragent']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const DEPLOYS = /\bdeploy to\b/i;

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);
  const actors = new Map<string, ActorRef>();
  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const grouped = new Map<string, SourceEvent>();
  const lines: string[] = [];
  let skipped = false;
  const within = (t: number) => t >= window.start && t < window.end;
  const system = (key: string, name: string) => {
    const id = `ops:${key}`;
    if (!actors.has(id)) actors.set(id, { key: id, email: null, name, kind: 'system', groupHint: null, clientHint: null });
    return id;
  };
  const byEmail = (email: string) => {
    const key = `ops:email:${email}`;
    if (!actors.has(key)) actors.set(key, { key, email, name: null, kind: 'person', groupHint: 'Engineering', clientHint: null });
    return key;
  };
  const byLogin = (login: string, bot: boolean) => {
    const tool = bot || login.endsWith('[bot]') || AGENT_LOGINS.has(login);
    const key = `github:${bot && !login.endsWith('[bot]') ? `${login}[bot]` : login}`;
    if (!actors.has(key)) actors.set(key, { key, email: null, name: login, kind: tool ? 'automation' : 'person', groupHint: tool ? null : 'Engineering', clientHint: null });
    return key;
  };
  const add = (kind: EventKind, resource: ResourceType | null, t: number, actor: string, building: Building, slug: string, name: string, rest: { id?: string; to?: string } = {}) => {
    if (!within(t)) return;
    buildings.set(building.id, building);
    const feature = `${building.id}/${slug}`;
    features.set(feature, { id: feature, building: building.id, name });
    const minute = Math.floor(t / MINUTE) * MINUTE;
    const key = `${kind}|${actor}|${feature}|${rest.id ?? minute}|${rest.to ?? ''}`;
    const event = grouped.get(key);
    if (event) event.count++;
    else {
      grouped.set(key, {
        kind,
        t: rest.id ? t : minute,
        actor,
        via: null,
        resource,
        resourceId: resource ? rest.id ?? `${resource}:${slug}:${actor}:${minute}` : null,
        building: building.id,
        from: null,
        to: rest.to ?? null,
        isReturn: false,
        count: 1,
        clientHint: null,
        feature,
      });
    }
  };
  const attempt = async (name: string, run: () => Promise<string> | string) => {
    try {
      lines.push(`${name.padEnd(16)}${await run()}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped = true;
      lines.push(`${name.padEnd(16)}skipped: ${err instanceof Skip ? reason : `stopped on an error (${reason.replace(/\s+/g, ' ').slice(0, 300)})`}`);
    }
  };

  await attempt('incident.io', async () => {
    await pullIncidents(window);
    const incidents = load<Incident>('incidents');
    const alerts = () => system('alerts', 'incident.io alerts');
    let opened = 0;
    for (const incident of incidents) {
      const id = `incident:${incident.id}`;
      const slug = (incident.severity ?? 'unrated').toLowerCase().replace(/\s+/g, '-');
      const name = incident.severity ?? 'Unrated';
      const creator = incident.creator ? byEmail(incident.creator) : alerts();
      if (within(incident.created)) opened++;
      add('create', 'incident', incident.created, creator, INCIDENTS, slug, name, { id });
      for (const role of incident.roles) add('assign', 'incident', incident.created, creator, INCIDENTS, slug, name, { id, to: byEmail(role.email) });
      const lead = incident.roles[0]?.email;
      if (incident.closed !== null) add('done', 'incident', incident.closed, lead ? byEmail(lead) : creator, INCIDENTS, slug, name, { id });
    }
    return `${opened} incidents opened in the week, ${incidents.length} touched`;
  });

  await attempt('vercel', async () => {
    await pullDeploys(window);
    const deploys = load<Deploy>('deploys');
    for (const deploy of deploys) {
      const actor = deploy.email ? byEmail(deploy.email) : deploy.login ? byLogin(deploy.login, false) : system('vercel', 'Vercel');
      const name = deploy.project;
      add('create', 'deploy', deploy.t, actor, VERCEL, name.toLowerCase(), name, { id: `vercel:${deploy.id}` });
      if (deploy.state === 'ERROR') add('error', null, deploy.t, actor, VERCEL, name.toLowerCase(), name);
      if (deploy.target === 'production' && deploy.state === 'READY') add('done', 'deploy', deploy.t, actor, VERCEL, 'production', 'Production releases', { id: `vercel:${deploy.id}` });
    }
    return `${deploys.length} deployments`;
  });

  await attempt('github actions', () => {
    pullRuns(window);
    const runs = load<Run>('runs');
    for (const run of runs) {
      const actor = run.login ? byLogin(run.login, run.bot) : system('actions', 'GitHub Actions');
      const name = run.repo;
      add('create', 'build', run.t, actor, ACTIONS, name.toLowerCase(), name);
      if (FAILED.has(run.conclusion ?? '')) add('error', null, run.t, actor, ACTIONS, name.toLowerCase(), name);
      if (DEPLOYS.test(run.workflow ?? '') && run.conclusion === 'success') add('create', 'deploy', run.t, actor, ACTIONS, 'service-deploys', 'Service deploys', { id: `actions:${run.id}` });
    }
    return `${runs.length} workflow runs`;
  });

  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'ops',
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
  console.log('Ops source');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors. ${requests} requests this run.`);
  if (skipped) process.exit(3);
}

main().catch((err) => {
  console.error(`Stopped on error after ${requests} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
