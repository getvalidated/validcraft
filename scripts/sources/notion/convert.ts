import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type EventKind,
  type Feature,
  type SourceEvent,
  type SourceFile,
  type SourceHolding,
  type Window,
} from '../../../src/schema';
import { attach, type Found } from '../../lib/attach';
import { markdownLinks, refKey } from '../../lib/refs';
import { OWNER_NAMES, pageInWindow, type RawBlock, type RawComment, type RawPage, type RawUser } from './pull';

export interface RawInput {
  window: Window;
  users: RawUser[];
  pages: RawPage[];
  comments: Map<string, RawComment[]>;
  blocks?: Map<string, RawBlock[]>;
}

export interface Report {
  pagesSeen: number;
  pagesInWindow: number;
  commentsInWindow: number;
  commentsWithoutAuthor: number;
  links: number;
  pagesWithBlocks: number;
  features: Record<string, number>;
  events: Record<EventKind, number>;
  actors: number;
  initial: number;
  checks: { label: string; ok: boolean }[];
  ok: boolean;
}

const BUILDING = 'notion';
const PREFIX = 'notion:';
const NOTION: Building = { id: BUILDING, region: INTERNAL_REGION, name: 'Notion', resource: 'page' };
const ACTIONS: Record<string, string> = {
  pages: 'New pages',
  rows: 'Database rows',
  owners: 'Owners',
  edits: 'Edits',
  blocks: 'Block edits',
  trashed: 'Trashed',
  discussions: 'Discussions',
  replies: 'Replies',
  mentions: 'Mentions',
};
const feature = (slug: keyof typeof ACTIONS) => `${BUILDING}/${slug}`;
const MINUTE = 60_000;

const userKey = (id: string) => `${PREFIX}${id}`;

function ownerOf(page: RawPage): string | null {
  for (const want of OWNER_NAMES) {
    const property = page.people.find((p) => p.name === want);
    if (property) return property.ids[0] ?? null;
  }
  return null;
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}

export function toSourceFile(raw: RawInput): { file: SourceFile; report: Report } {
  const { start, end } = raw.window;
  const inWindow = (t: number) => t >= start && t <= end;
  const pages = dedupe(raw.pages);

  const events: SourceEvent[] = [];
  const initial: SourceHolding[] = [];
  const found: Found[] = [];
  let blockEdits = 0;
  let pagesInWindow = 0;
  let commentsInWindow = 0;
  let commentsWithoutAuthor = 0;

  for (const page of pages) {
    const created = Date.parse(page.created_time);
    const edited = Date.parse(page.last_edited_time);
    if (edited < start || created > end) continue;
    if (pageInWindow(page, raw.window)) pagesInWindow++;

    const emit = (kind: EventKind, t: number, actor: string, rest: Partial<SourceEvent> = {}) => {
      events.push({
        kind,
        t,
        actor,
        via: null,
        resource: 'page',
        resourceId: page.id,
        building: BUILDING,
        from: null,
        to: null,
        isReturn: false,
        count: 1,
        clientHint: null,
        ...rest,
      });
    };

    const owner = ownerOf(page);
    const creator = page.created_by;
    let holder = owner ? userKey(owner) : null;
    const held = new Set<string>();
    if (holder) held.add(holder);

    if (created < start) {
      initial.push({ resource: 'page', resourceId: page.id, holder, building: BUILDING });
    } else if (creator) {
      emit('create', created, userKey(creator), { feature: feature(page.parent?.type === 'database_id' ? 'rows' : 'pages') });
      if (owner && owner !== creator) emit('assign', created, userKey(creator), { to: userKey(owner), feature: feature('owners') });
    }

    if (inWindow(edited) && edited !== created && page.last_edited_by) {
      emit('edit', edited, userKey(page.last_edited_by), { feature: feature(page.archived ? 'trashed' : 'edits') });
    }
    const minute = (t: number) => Math.floor(t / MINUTE) * MINUTE;
    const touched = new Map<string, { t: number; who: string }>();
    for (const b of raw.blocks?.get(page.id) ?? []) {
      for (const [iso, who] of [
        [b.created_time, b.created_by],
        [b.last_edited_time, b.last_edited_by],
      ] as const) {
        const t = Date.parse(iso);
        if (!who || !inWindow(t) || Math.abs(t - created) < 2 * MINUTE) continue;
        if (who === page.last_edited_by && minute(t) === minute(edited)) continue;
        touched.set(`${who}|${minute(t)}`, { t: Math.min(t, touched.get(`${who}|${minute(t)}`)?.t ?? t), who });
      }
    }
    for (const { t, who } of touched.values()) {
      blockEdits++;
      emit('edit', t, userKey(who), { feature: feature('blocks') });
    }

    const all = dedupe(raw.comments.get(page.id) ?? [])
      .map((c) => ({ c, t: Date.parse(c.created_time) }))
      .sort((a, b) => a.t - b.t);
    const opened = new Set<string>();
    const starts = new Set(
      all
        .filter(({ c }) => {
          const first = !c.discussion_id || !opened.has(c.discussion_id);
          if (c.discussion_id) opened.add(c.discussion_id);
          return first;
        })
        .map(({ c }) => c.id),
    );

    for (const { c, t } of all) {
      const parent = refKey('page', page.id);
      const author = c.created_by ? userKey(c.created_by) : null;
      if (author) {
        for (const { link, name } of [...markdownLinks(c.text ?? ''), ...(c.links ?? []).map((link) => ({ link, name: '' }))]) {
          found.push({ t, actor: author, parent, link, name, clientHint: null });
        }
      }
      if (!inWindow(t)) continue;
      commentsInWindow++;
      if (!author) {
        commentsWithoutAuthor++;
        continue;
      }
      const mentioned = c.mentions.find((id) => id !== c.created_by);
      const target = mentioned ? userKey(mentioned) : null;
      if (target && target !== holder) {
        const from = holder ?? author;
        emit('send', t, author, { from, to: target, isReturn: held.has(target), feature: feature('mentions') });
        held.add(from);
        held.add(target);
        holder = target;
      } else {
        emit('comment', t, author, { to: holder, feature: feature(starts.has(c.id) ? 'discussions' : 'replies') });
      }
    }
  }

  const attached = attach(found, new Map(), raw.window, NOTION, 'Links');
  events.push(...attached.events);
  events.sort((a, b) => a.t - b.t);
  const featureCounts: Record<string, number> = {};
  for (const e of events) if (e.feature) featureCounts[e.feature] = (featureCounts[e.feature] ?? 0) + 1;
  const own: Feature[] = Object.keys(featureCounts)
    .filter((id) => id.startsWith(`${BUILDING}/`) && id.slice(BUILDING.length + 1) in ACTIONS)
    .sort()
    .map((id) => ({ id, building: BUILDING, name: ACTIONS[id.slice(BUILDING.length + 1)] }));
  const features = [...own, ...attached.features.filter((f) => !own.some((o) => o.id === f.id))];

  const used = new Set(
    [...events.flatMap((e) => [e.actor, e.from, e.to]), ...initial.map((h) => h.holder)].filter(
      (key): key is string => !!key,
    ),
  );
  const users = new Map(raw.users.map((u) => [u.id, u]));
  const actors: ActorRef[] = [...used].sort().map((key) => {
    const id = key.slice(PREFIX.length);
    const user = users.get(id);
    return {
      key,
      email: user?.email ?? null,
      name: user?.name ?? `user-${id.slice(0, 4)}`,
      kind: user?.type === 'bot' ? 'automation' : 'person',
      groupHint: null,
      clientHint: null,
    };
  });

  const counts: Report['events'] = { create: 0, send: 0, assign: 0, comment: 0, done: 0, edit: 0, bulk: 0, use: 0, run: 0, error: 0, status: 0 };
  for (const e of events) counts[e.kind]++;

  const checks = [
    {
      label: 'comment + send events = in-window comments with an author',
      ok: counts.comment + counts.send === commentsInWindow - commentsWithoutAuthor,
    },
    { label: 'every event falls inside the window', ok: events.every((e) => inWindow(e.t)) },
    { label: 'no send goes from a person to themselves', ok: events.every((e) => e.kind !== 'send' || e.from !== e.to) },
    { label: 'every event feature is listed in features', ok: events.every((e) => !e.feature || features.some((f) => f.id === e.feature)) },
    { label: 'block edit events = distinct in-window block editors by minute', ok: (featureCounts[feature('blocks')] ?? 0) === blockEdits },
  ];

  return {
    file: {
      schemaVersion: SCHEMA_VERSION,
      source: 'notion',
      window: raw.window,
      actors,
      buildings: [NOTION, ...attached.buildings.filter((b) => b.id !== BUILDING)],
      features,
      events,
      initial,
      sessions: [],
      measures: [],
      artifacts: [],
      links: attached.links,
    },
    report: {
      pagesSeen: pages.length,
      pagesInWindow,
      commentsInWindow,
      commentsWithoutAuthor,
      links: attached.links.length,
      pagesWithBlocks: raw.blocks?.size ?? 0,
      features: featureCounts,
      events: counts,
      actors: actors.length,
      initial: initial.length,
      checks,
      ok: checks.every((c) => c.ok),
    },
  };
}

export function printReport(report: Report) {
  const row = (label: string, value: number | string) => console.log(`  ${label.padEnd(34)}${String(value).padStart(8)}`);
  console.log('Notion source');
  row('pages seen', report.pagesSeen);
  row('pages in window', report.pagesInWindow);
  row('comments', report.commentsInWindow);
  if (report.commentsWithoutAuthor) row('  without an author (skipped)', report.commentsWithoutAuthor);
  row('actors', report.actors);
  row('pages existing at window start', report.initial);
  row('pages with blocks read', report.pagesWithBlocks);
  row('links to other resources', report.links);
  console.log('Events by action cell');
  for (const [id, count] of Object.entries(report.features).sort()) row(id, count);
  console.log('Events');
  for (const [kind, count] of Object.entries(report.events)) if (kind !== 'bulk' && kind !== 'done') row(kind, count);
  console.log('Checks');
  for (const check of report.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.label}`);
}
