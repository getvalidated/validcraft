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
import type { DriveFile } from '../../lib/drive';
import { refKey } from '../../lib/refs';
import { isMessage, isTopLevel, toMs, type RawMessage } from './pull';

export interface RawChannel {
  id: string;
  readable: boolean;
  messages: RawMessage[];
  replies: Map<string, RawMessage[]>;
}

export interface RawInput {
  window: Window;
  teamId: string;
  channels: RawChannel[];
  origin: { exportOnly: number; botsOnly: number; both: number };
  drive: Map<string, DriveFile>;
}

export interface Report {
  channelsRead: number;
  channelsUnreadable: number;
  messagesExportOnly: number;
  messagesBotsOnly: number;
  messagesBoth: number;
  threads: number;
  events: Record<EventKind, number>;
  initial: number;
  videos: number;
  reports: number;
  links: number;
  actorsInside: number;
  actorsOutside: number;
}

const BUILDING = 'slack';
const BOT_PREFIX = 'slack:bot:';
const SLACK: Building = { id: BUILDING, region: INTERNAL_REGION, name: 'Slack', resource: 'thread' };

export const linksOf = (channels: RawChannel[]) =>
  channels.flatMap((channel) => [...channel.messages, ...[...channel.replies.values()].flat()].flatMap((m) => m.links ?? []));

function byTs(messages: RawMessage[]) {
  const seen = new Map<string, RawMessage>();
  for (const m of messages) if (!seen.has(m.ts)) seen.set(m.ts, m);
  return [...seen.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

export function toSourceFile(raw: RawInput): { file: SourceFile; report: Report } {
  const { start, end } = raw.window;
  const inWindow = (t: number) => t >= start && t <= end;

  const each = (visit: (m: RawMessage) => void) => {
    for (const channel of raw.channels) {
      for (const m of channel.messages) if (isMessage(m)) visit(m);
      for (const replies of channel.replies.values()) for (const m of replies) if (isMessage(m)) visit(m);
    }
  };

  const botCounts = new Map<string, Map<string, number>>();
  const humans = new Set<string>();
  each((m) => {
    if (!m.user) return;
    if (!m.bot_id) {
      humans.add(m.user);
      return;
    }
    if (!botCounts.has(m.user)) botCounts.set(m.user, new Map());
    botCounts.get(m.user)!.set(m.bot_id, (botCounts.get(m.user)!.get(m.bot_id) ?? 0) + 1);
  });
  const botUsers = new Map<string, string>();
  for (const [user, bots] of botCounts) {
    if (humans.has(user)) continue;
    botUsers.set(user, [...bots.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }

  const userKey = (id: string) => (botUsers.has(id) ? `${BOT_PREFIX}${botUsers.get(id)}` : `slack:${id}`);
  const authorKey = (m: RawMessage) => (m.bot_id ? `${BOT_PREFIX}${m.bot_id}` : userKey(m.user!));
  const mentioned = (m: RawMessage) => {
    if (m.bot_id) return null;
    const author = authorKey(m);
    return m.mentions.map(userKey).find((key) => key !== author) ?? null;
  };

  const teams = new Map<string, string>();
  each((m) => {
    const key = authorKey(m);
    const team = m.user_team ?? m.team;
    if (team && !teams.has(key)) teams.set(key, team);
  });

  const events: SourceEvent[] = [];
  const initial: SourceHolding[] = [];
  let threads = 0;

  for (const channel of raw.channels) {
    const clientHint = `slack-channel:${channel.id}`;
    for (const top of byTs(channel.messages)) {
      if (!isTopLevel(top) || !isMessage(top)) continue;
      const t0 = toMs(top.ts);
      if (t0 > end) continue;
      const replies = byTs(channel.replies.get(top.ts) ?? []).filter(
        (r) => r.ts !== top.ts && isMessage(r) && toMs(r.ts) <= end,
      );
      if (t0 < start) {
        if (!replies.some((r) => toMs(r.ts) >= start)) continue;
      } else if (!replies.length && !top.reply_count && !top.mentions.length) {
        continue;
      }
      threads++;

      const resourceId = `${channel.id}:${top.ts}`;
      const emit = (kind: EventKind, t: number, actor: string, rest: Partial<SourceEvent> = {}) => {
        events.push({
          kind,
          t,
          actor,
          via: null,
          resource: 'thread',
          resourceId,
          building: BUILDING,
          from: null,
          to: null,
          isReturn: false,
          count: 1,
          clientHint,
          ...rest,
        });
      };

      const held = new Set<string>();
      let holder: string | null = null;
      const author = authorKey(top);
      if (inWindow(t0)) emit('create', t0, author);
      const assignee = mentioned(top);
      if (assignee) {
        if (inWindow(t0)) emit('assign', t0, author, { to: assignee });
        held.add(author).add(assignee);
        holder = assignee;
      }

      let atStart = holder;
      for (const r of replies) {
        const t = toMs(r.ts);
        const actor = authorKey(r);
        const to = mentioned(r);
        if (to && to !== holder) {
          const from: string = holder ?? actor;
          if (t >= start) emit('send', t, actor, { from, to, isReturn: held.has(to) });
          held.add(from).add(to);
          holder = to;
        } else if (t >= start) {
          emit('comment', t, actor, { to: holder });
        }
        if (t < start) atStart = holder;
      }

      if (t0 < start) initial.push({ resource: 'thread', resourceId, holder: atStart, building: BUILDING });
    }
  }

  const found: Found[] = [];
  for (const channel of raw.channels) {
    const posted = new Map<string, RawMessage>();
    for (const m of [...channel.messages, ...[...channel.replies.values()].flat()]) if (isMessage(m) && !posted.has(m.ts)) posted.set(m.ts, m);
    for (const m of posted.values()) {
      const base = { actor: authorKey(m), parent: refKey('thread', `${channel.id}:${m.thread_ts ?? m.ts}`), clientHint: `slack-channel:${channel.id}` };
      for (const link of m.links ?? []) found.push({ ...base, t: toMs(m.ts), link, name: '' });
      for (const file of m.files ?? []) {
        const resource = file.mimetype.startsWith('video/') ? 'video' : file.mimetype === 'text/html' ? 'report' : null;
        if (resource) found.push({ ...base, t: file.created ? file.created * 1000 : toMs(m.ts), link: '', name: file.name, ref: { resource, id: `slack:${file.id}`, building: null, feature: null } });
      }
    }
  }
  const attached = attach(found, raw.drive, raw.window, SLACK, 'Files and links');
  events.push(...attached.events);
  events.sort((a, b) => a.t - b.t);

  const keys = new Set(
    [...events.flatMap((e) => [e.actor, e.from, e.to]), ...initial.map((h) => h.holder)].filter(
      (key): key is string => !!key,
    ),
  );
  const listed = new Map(attached.actors.map((actor) => [actor.key, actor]));
  const actors: ActorRef[] = [...keys].sort().map((key) => {
    const team = teams.get(key);
    return listed.get(key) ?? {
      key,
      email: null,
      name: null,
      kind: key.startsWith(BOT_PREFIX) ? 'automation' : 'person',
      groupHint: null,
      clientHint: team && team !== raw.teamId ? `slack-team:${team}` : null,
    };
  });

  const counts: Report['events'] = { create: 0, send: 0, assign: 0, comment: 0, done: 0, edit: 0, bulk: 0, use: 0, run: 0, error: 0, status: 0 };
  for (const e of events) counts[e.kind]++;
  const outside = actors.filter((a) => a.clientHint).length;

  return {
    file: {
      schemaVersion: SCHEMA_VERSION,
      source: 'slack',
      window: raw.window,
      actors,
      buildings: [SLACK, ...attached.buildings.filter((b) => b.id !== BUILDING)],
      features: attached.features,
      events,
      initial,
      sessions: [],
      measures: [],
      artifacts: [],
      links: attached.links,
    },
    report: {
      channelsRead: raw.channels.filter((c) => c.readable).length,
      channelsUnreadable: raw.channels.filter((c) => !c.readable).length,
      messagesExportOnly: raw.origin.exportOnly,
      messagesBotsOnly: raw.origin.botsOnly,
      messagesBoth: raw.origin.both,
      threads,
      events: counts,
      initial: initial.length,
      videos: attached.events.filter((e) => e.resource === 'video').length,
      reports: attached.events.filter((e) => e.resource === 'report').length,
      links: attached.links.length,
      actorsInside: actors.length - outside,
      actorsOutside: outside,
    },
  };
}

export function printReport(report: Report) {
  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('Slack source');
  row('channels read', report.channelsRead);
  row('channels unreadable', report.channelsUnreadable);
  row('messages from the export only', report.messagesExportOnly);
  row('messages from the bots only', report.messagesBotsOnly);
  row('messages from both', report.messagesBoth);
  row('threads', report.threads);
  row('threads open at window start', report.initial);
  row('videos attached or linked', report.videos);
  row('reports attached or linked', report.reports);
  row('links to other resources', report.links);
  row('actors inside the workspace', report.actorsInside);
  row('actors outside the workspace', report.actorsOutside);
  console.log('Events before the bulk rule');
  for (const kind of ['create', 'assign', 'send', 'comment'] as const) row(kind, report.events[kind]);
}
