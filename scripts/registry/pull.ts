import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../src/schema';
import { config, secret } from '../lib/config';
import { readExportChannels } from '../sources/slack/export';
import { RAW, pageThrough, readJson, readPages, request, writeJson, type Page } from './raw';

export interface Company {
  id: string;
  name: string;
  shortname: string | null;
  internalChannel: string | null;
  since: number | null;
}

export interface SlackUser {
  id: string;
  teamId: string | null;
  deleted: boolean;
  isBot: boolean;
  isRestricted: boolean;
  isStranger: boolean;
  handle: string | null;
  realName: string | null;
  displayName: string | null;
  email: string | null;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isExtShared: boolean;
  isPendingExtShared: boolean;
  numMembers: number | null;
  teamIds: string[];
  created?: number | null;
}

export interface LinearUser {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  active: boolean;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
}

export interface NotionUser {
  id: string;
  type: string;
  name: string | null;
  email: string | null;
}

export interface Raw {
  companies: Company[];
  slackUsers: SlackUser[];
  slackChannels: SlackChannel[];
  slackMembers: Map<string, string[]>;
  linearUsers: LinearUser[];
  linearTeams: (LinearTeam & { members: string[] })[];
  linearProjects: LinearProject[];
  notionUsers: NotionUser[];
}

const STATE_FILE = path.join(RAW, 'state.json');
const dir = (...parts: string[]) => path.join(RAW, ...parts);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function companies(): Company[] {
  return config.clients.map((c) => ({
    id: c.id,
    name: c.name,
    shortname: str(c.shortname),
    internalChannel: str(c.slackChannel),
    since: c.since ? Date.parse(c.since) : null,
  }));
}

const SLACK_BOT = 'SLACK_BOT_TOKEN';
const SLACK_SECOND_BOT = 'SLACK_BOT_TOKEN_2';

async function slack(method: string, params: Record<string, string>, name = SLACK_BOT) {
  const body = await request(`slack ${method}`, `https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${secret(name)}` },
  });
  if (!body.ok) throw new Error(`slack ${method}: ${body.error}`);
  return body;
}

const slackCursor = (body: any) => str(body?.response_metadata?.next_cursor);
const withCursor = (params: Record<string, string>, name: string, cursor: string | null): Record<string, string> =>
  cursor ? { ...params, [name]: cursor } : params;

function slackUser(u: any): SlackUser {
  return {
    id: u.id,
    teamId: str(u.team_id) ?? str(u.profile?.team),
    deleted: !!u.deleted,
    isBot: !!u.is_bot || u.id === 'USLACKBOT',
    isRestricted: !!u.is_restricted || !!u.is_ultra_restricted,
    isStranger: !!u.is_stranger,
    handle: str(u.name),
    realName: str(u.profile?.real_name) ?? str(u.real_name),
    displayName: str(u.profile?.display_name),
    email: str(u.profile?.email)?.toLowerCase() ?? null,
  };
}

function slackChannel(c: any): SlackChannel {
  const teams = [c.shared_team_ids, c.connected_team_ids, c.pending_connected_team_ids, c.internal_team_ids]
    .filter(Array.isArray)
    .flat()
    .filter((id): id is string => typeof id === 'string');
  for (const id of [c.context_team_id, c.conversation_host_id]) if (typeof id === 'string') teams.push(id);
  return {
    id: c.id,
    name: String(c.name ?? ''),
    isPrivate: !!c.is_private,
    isArchived: !!c.is_archived,
    isExtShared: !!c.is_ext_shared,
    isPendingExtShared: !!c.is_pending_ext_shared,
    numMembers: typeof c.num_members === 'number' ? c.num_members : null,
    teamIds: [...new Set(teams)].sort(),
    created: typeof c.created === 'number' ? c.created * 1000 : null,
  };
}

async function pullSlackDirectory() {
  await pageThrough<SlackUser>(dir('slack', 'users'), 'slack users', async (cursor) => {
    const body = await slack('users.list', withCursor({ limit: '200' }, 'cursor', cursor));
    return { items: (body.members ?? []).map(slackUser), next: slackCursor(body) };
  });
  await pageThrough<SlackChannel>(dir('slack', 'channels'), 'slack channels', async (cursor) => {
    const body = await slack(
      'conversations.list',
      withCursor({ types: 'public_channel,private_channel', limit: '200' }, 'cursor', cursor),
    );
    return { items: (body.channels ?? []).map(slackChannel), next: slackCursor(body) };
  });
  if (!process.env[SLACK_SECOND_BOT]) return;
  await pageThrough<SlackChannel>(dir('slack', 'channels-second'), 'slack channels, second bot', async (cursor) => {
    const body = await slack(
      'conversations.list',
      withCursor({ types: 'public_channel,private_channel', limit: '200' }, 'cursor', cursor),
      SLACK_SECOND_BOT,
    );
    return { items: (body.channels ?? []).filter((c: any) => c.is_member).map(slackChannel), next: slackCursor(body) };
  });
}

function readSlackChannels() {
  const first = readPages<SlackChannel>(dir('slack', 'channels'));
  const seen = new Set(first.map((c) => c.id));
  const second = readPages<SlackChannel>(dir('slack', 'channels-second')).filter((c) => !seen.has(c.id));
  return { all: [...first, ...second], second: new Set(second.map((c) => c.id)) };
}

const membersDir = (channel: string) => dir('slack', 'members', channel);
const userInfoFile = (id: string) => dir('slack', 'users-info', `${id}.json`);

async function pullSlackMembers(window: Window) {
  const listed = readSlackChannels();
  const channels = listed.all.filter((c) => !c.isArchived);
  const bot = (channel: string) => (listed.second.has(channel) ? SLACK_SECOND_BOT : SLACK_BOT);
  for (const channel of channels) {
    await pageThrough<string>(membersDir(channel.id), `slack members ${channel.id}`, async (cursor) => {
      const body = await slack('conversations.members', withCursor({ channel: channel.id, limit: '1000' }, 'cursor', cursor), bot(channel.id));
      return { items: body.members ?? [], next: slackCursor(body) };
    });
  }
  const known = new Set(readPages<SlackUser>(dir('slack', 'users')).map((u) => u.id));
  const strangers = new Map<string, string>();
  for (const channel of channels) {
    for (const id of readPages<string>(membersDir(channel.id))) if (!known.has(id) && strangers.get(id) !== SLACK_BOT) strangers.set(id, bot(channel.id));
  }
  const bots = new Set(listed.all.map((c) => c.id));
  for (const channel of readExportChannels(window)) {
    if (bots.has(channel.id) || channel.isArchived) continue;
    for (const id of channel.members) if (!known.has(id) && !strangers.has(id)) strangers.set(id, SLACK_BOT);
  }
  for (const [id, name] of [...strangers].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (fs.existsSync(userInfoFile(id))) continue;
    const body = await slack('users.info', { user: id }, name);
    writeJson(userInfoFile(id), slackUser(body.user));
  }
  if (strangers.size) console.log(`slack users outside the directory: ${strangers.size}`);
}

async function linear(query: string, variables: Record<string, unknown>) {
  const body = await request('linear', 'https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: secret('LINEAR_API_KEY') },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length || !body.data) throw new Error(`linear: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

const linearPage = <T>(conn: any, pick: (node: any) => T): Page<T> => ({
  items: conn.nodes.map(pick),
  next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
});

async function pullLinear() {
  await pageThrough<LinearUser>(dir('linear', 'users'), 'linear users', async (after) => {
    const data = await linear(
      `query($after: String) { users(first: 100, after: $after, includeDisabled: true) {
        pageInfo { hasNextPage endCursor } nodes { id name displayName email active } } }`,
      { after },
    );
    return linearPage(data.users, (n) => ({
      id: n.id,
      name: n.name,
      displayName: n.displayName,
      email: str(n.email)?.toLowerCase() ?? null,
      active: !!n.active,
    }));
  });
  await pageThrough<LinearTeam>(dir('linear', 'teams'), 'linear teams', async (after) => {
    const data = await linear(
      `query($after: String) { teams(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id key name } } }`,
      { after },
    );
    return linearPage(data.teams, (n) => ({ id: n.id, key: n.key, name: n.name }));
  });
  for (const team of readPages<LinearTeam>(dir('linear', 'teams'))) {
    await pageThrough<string>(dir('linear', 'team-members', team.id), `linear members ${team.key}`, async (after) => {
      const data = await linear(
        `query($id: String!, $after: String) { team(id: $id) { members(first: 100, after: $after, includeDisabled: true) {
          pageInfo { hasNextPage endCursor } nodes { id } } } }`,
        { id: team.id, after },
      );
      return linearPage(data.team.members, (n) => n.id as string);
    });
  }
  await pageThrough<LinearProject>(dir('linear', 'projects'), 'linear projects', async (after) => {
    const data = await linear(
      `query($after: String) { projects(first: 100, after: $after, includeArchived: true) {
        pageInfo { hasNextPage endCursor } nodes { id name } } }`,
      { after },
    );
    return linearPage(data.projects, (n) => ({ id: n.id, name: n.name }));
  });
}

async function pullNotion() {
  await pageThrough<NotionUser>(dir('notion', 'users'), 'notion users', async (cursor) => {
    const params = new URLSearchParams(withCursor({ page_size: '100' }, 'start_cursor', cursor));
    const body = await request('notion users', `https://api.notion.com/v1/users?${params}`, {
      headers: { Authorization: `Bearer ${secret('NOTION_API_KEY')}`, 'Notion-Version': '2022-06-28' },
    });
    return {
      items: (body.results ?? []).map((u: any) => ({
        id: u.id,
        type: String(u.type ?? ''),
        name: str(u.name),
        email: str(u.person?.email)?.toLowerCase() ?? null,
      })),
      next: body.has_more ? body.next_cursor : null,
    };
  });
}

export async function pull(window: Window) {
  if (fs.existsSync(STATE_FILE)) {
    const state = readJson(STATE_FILE);
    if (state.start !== window.start || state.end !== window.end) {
      throw new Error(
        'data/raw/registry was pulled for a different window than data/window.json. Remove data/raw/registry to pull this window.',
      );
    }
  } else {
    writeJson(STATE_FILE, { start: window.start, end: window.end });
  }
  await pullSlackDirectory();
  await pullSlackMembers(window);
  await pullLinear();
  await pullNotion();
}

export function readRaw(window: Window): Raw {
  const slackUsers = readPages<SlackUser>(dir('slack', 'users'));
  const slackChannels = readSlackChannels().all;
  const listed = new Set(slackChannels.map((c) => c.id));
  const exportMembers = new Map<string, string[]>();
  for (const c of readExportChannels(window)) {
    if (listed.has(c.id)) continue;
    exportMembers.set(c.id, c.members);
    slackChannels.push({
      id: c.id,
      name: c.name,
      isPrivate: c.isPrivate,
      isArchived: c.isArchived,
      isExtShared: false,
      isPendingExtShared: false,
      numMembers: c.members.length,
      teamIds: [],
      created: c.created === null ? null : c.created * 1000,
    });
  }
  const infoDir = dir('slack', 'users-info');
  if (fs.existsSync(infoDir)) {
    for (const file of fs.readdirSync(infoDir).filter((f) => f.endsWith('.json')).sort()) {
      slackUsers.push(readJson(path.join(infoDir, file)));
    }
  }
  return {
    companies: companies(),
    slackUsers,
    slackChannels,
    slackMembers: new Map(slackChannels.map((c) => [c.id, exportMembers.get(c.id) ?? readPages<string>(membersDir(c.id))])),
    linearUsers: readPages<LinearUser>(dir('linear', 'users')),
    linearTeams: readPages<LinearTeam>(dir('linear', 'teams')).map((team) => ({
      ...team,
      members: readPages<string>(dir('linear', 'team-members', team.id)),
    })),
    linearProjects: readPages<LinearProject>(dir('linear', 'projects')),
    notionUsers: readPages<NotionUser>(dir('notion', 'users')),
  };
}
