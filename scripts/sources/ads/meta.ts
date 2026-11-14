import type { Building, ResourceType, Window } from '../../../src/schema';
import { config } from '../../lib/config';
import { ADS, OWN_TOTAL, collect, logsOf, ms, ownAd, type Account, type Made } from './shared';

export interface MetaEvent {
  actor_id?: string;
  actor_name?: string;
  application_name?: string;
  event_time?: string;
  event_type?: string;
  extra_data?: string;
  object_id?: string;
  object_name?: string;
  object_type?: string;
  translated_event_type?: string;
}

const RESOURCES: Record<string, ResourceType> = { CAMPAIGN_GROUP: 'campaign', CAMPAIGN: 'adset', ADGROUP: 'ad' };
const SKIP = /^(first_delivery_event|ad_account_billing_|ad_account_update_status)/;
const UPLOAD_MS = 5 * 60_000;
const GONE = new Set(['Deleted', 'Permanently Removed', 'Archived']);
const META_EDITOR = 'Power Editor';
const TOOL_NAME = /(^|[^a-z])(api|ai|app|assistant|automation|cli|bot|claude|mcp|analytics|system)([^a-z]|$)/i;
const ACTIONS: [RegExp, string, string][] = [
  [/audience/, 'meta-audiences', 'Audiences'],
  [/^(add|edit)_images$/, 'meta-images', 'Image library'],
  [/user_(to|from)_role$/, 'meta-access', 'Account access'],
  [/^create_/, 'meta', 'Meta'],
  [/_name$|_labels$/, 'meta-names', 'Renames and labels'],
  [/creative/, 'meta-creative', 'Creative swaps'],
  [/target|value_rules|value_adjustment/, 'meta-targeting', 'Targeting'],
  [/budget|bid|spend_cap|spend_limit|optimization_goal|duration/, 'meta-budgets', 'Budgets, bids and schedule'],
  [/run_status/, 'meta-status', 'Status changes'],
];

const words = (value: string) => value.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function parse(extra: string | undefined) {
  try {
    return (JSON.parse(extra ?? '{}') ?? {}) as { old_value?: unknown; new_value?: unknown; image_url?: unknown };
  } catch {
    return {};
  }
}

function metaEvents(
  events: MetaEvent[],
  company: string,
  building: Building,
  made: Made,
  actorOf: (id: string | undefined) => string,
  platform: string,
  ours: (name: string) => boolean,
  totals: Record<string, number>,
) {
  const live = new Map<string, boolean>();
  const timed = events.map((e) => ({ e, t: ms(e.event_time) })).filter(({ t }) => Number.isFinite(t)).sort((a, b) => a.t - b.t);
  const fileOf = (extra: { image_url?: unknown }) => /\/([\w-]+)\.\w+(?:\?|$)/.exec(String(extra.image_url ?? ''))?.[1];
  const added = new Map<string, number>();
  for (const { e, t } of timed) if (e.event_type === 'add_images') added.set(fileOf(parse(e.extra_data)) ?? '', t);
  for (const { e, t } of timed) {
    const type = e.event_type ?? '';
    if (!type || SKIP.test(type)) continue;
    const [, slug, name] = ACTIONS.find(([test]) => test.test(type)) ?? [null, `meta-${type.replace(/_/g, '-')}`, e.translated_event_type?.trim() || words(type)];
    const actor = actorOf(e.actor_id);
    const extra = parse(e.extra_data);
    if (slug === 'meta-images') {
      const file = fileOf(extra);
      const add = type.startsWith('add_');
      if (file && !add && Math.abs(t - (added.get(file) ?? -Infinity)) < UPLOAD_MS) continue;
      made(file ? 'image' : null, t, actor, building, slug, name, company, null, add ? 'create' : 'edit', file ? `meta:${file}` : null);
      continue;
    }
    const resource = slug === 'meta-audiences' || slug === 'meta-access' ? null : (RESOURCES[e.object_type ?? ''] ?? null);
    const id = resource && e.object_id ? `meta:${e.object_id}` : null;
    if (resource && !id) continue;
    if (slug === 'meta' && resource) {
      live.set(id!, false);
      const event = made(resource, t, actor, building, slug, name, company, 'inactive', 'create', id);
      if (event && resource === 'ad' && ours(e.object_name ?? '')) {
        event.ours = (event.ours ?? 0) + 1;
        totals[OWN_TOTAL] = (totals[OWN_TOTAL] ?? 0) + 1;
      }
      continue;
    }
    if (resource && type.endsWith('_run_status')) {
      const was = live.get(id!) ?? extra.old_value === 'Active';
      const now = extra.new_value === 'Active';
      live.set(id!, now);
      if (GONE.has(String(extra.new_value))) made(resource, t, actor, building, 'meta-deletes', 'Deletes and archives', company, 'inactive', 'status', id);
      else if (extra.old_value === 'Pending Review' && actor === platform) made(resource, t, actor, building, 'meta-review', 'Ad review', company, now ? 'active' : 'inactive', 'status', id);
      else if (was !== now) made(resource, t, actor, building, slug, name, company, now ? 'active' : 'inactive', 'status', id);
      continue;
    }
    made(resource, t, actor, building, slug, name, company, null, slug === 'meta' ? 'create' : 'edit', id);
  }
}

export function writeMetaSource(window: Window, root: string, accounts: Account[], out: string) {
  const { actors, totals, system, made, write } = collect(window);
  const logs = logsOf<MetaEvent>(root, window, accounts);
  const profiles = new Map<string, { name: string; apps: Map<string, number>; companies: Set<string>; editor: boolean }>();
  for (const { company, events } of logs) {
    for (const e of events) {
      if (!e.actor_id) continue;
      let profile = profiles.get(e.actor_id);
      if (!profile) profiles.set(e.actor_id, (profile = { name: (e.actor_name ?? '').trim(), apps: new Map(), companies: new Set(), editor: false }));
      profile.companies.add(company);
      if (e.application_name === META_EDITOR) profile.editor = true;
      else if (e.application_name) profile.apps.set(e.application_name, (profile.apps.get(e.application_name) ?? 0) + 1);
    }
  }
  const metaAds = () => system('outputs:ads:meta', 'Meta Ads');
  const metaActor = (id: string | undefined) => {
    const profile = id ? profiles.get(id) : undefined;
    if (!id || !profile || profile.name === 'Meta') return metaAds();
    const key = `meta:${id}`;
    if (actors.has(key)) return key;
    const apps = [...profile.apps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([app]) => app);
    const parts = profile.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const tool =
      !profile.name ||
      (!profile.editor &&
        (!/\s/.test(profile.name) || TOOL_NAME.test(profile.name) || apps.some((app) => parts.some((word) => app.toLowerCase().split(/[^a-z0-9]+/).includes(word)))));
    const [only] = profile.companies.size === 1 ? [...profile.companies] : [];
    actors.set(key, {
      key,
      email: null,
      name: profile.name || apps[0] || 'Meta system user',
      kind: tool ? 'automation' : 'person',
      groupHint: null,
      clientHint: only ? `company:${only}` : null,
      ...(tool && only ? { external: true } : {}),
    });
    return key;
  };
  const ours = ownAd(config.meta.ownAdName);
  for (const { company, events } of logs) metaEvents(events, company, ADS, made, metaActor, metaAds(), ours, totals);
  write('Meta activity', out);
}
