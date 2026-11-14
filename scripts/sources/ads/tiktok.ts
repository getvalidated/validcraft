import type { Building, ResourceType, Window } from '../../../src/schema';
import { config } from '../../lib/config';
import { ADS, OWN_TOTAL, collect, logsOf, ownAd, type Account, type Made } from './shared';

export interface TikTokRow {
  at: number;
  log_object_type?: string;
  'Object ID'?: string;
  Object?: string;
  Operator?: string;
  'Activity details'?: string;
}

interface Detail {
  action?: string;
  name?: string;
  before_after?: { before?: string; after?: string }[];
}

const RESOURCES: Record<string, ResourceType> = { Campaign: 'campaign', 'Ad group': 'adset', Ad: 'ad' };
const SETUP_MS = 5 * 60_000;
const SETUP = new Set(['Creative', 'Destination page', 'Tracking', 'Auto-generated for you']);
const PASSED = new Set(['Approved', 'Partially Approved']);
const WAITING = new Set(['In review', 'No creative assets are available']);
const SWITCH = new Set(['Enabled', 'Paused']);
const MASKED = /^.\*+.@.+$/;
const NAMES: [string, string] = ['tiktok-names', 'TikTok renames'];
const BUDGETS: [string, string] = ['tiktok-budgets', 'TikTok budgets, bids and schedule'];
const OTHER: [string, string] = ['tiktok-settings', 'TikTok settings'];
const ACTIONS: Record<string, [string, string]> = {
  Creative: ['tiktok-creative', 'TikTok creative swaps'],
  'Auto-generated for you': ['tiktok-creative', 'TikTok creative swaps'],
  'Destination page': ['tiktok-links', 'TikTok links and tracking'],
  Tracking: ['tiktok-links', 'TikTok links and tracking'],
  Targeting: ['tiktok-targeting', 'TikTok targeting'],
  'Budget & Schedule': BUDGETS,
  'Bidding & Optimization': BUDGETS,
};

function parse(row: TikTokRow): Detail[] {
  try {
    const list = JSON.parse(row['Activity details'] ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const did = (details: Detail[], action: string) => details.some((d) => d.action?.trim() === action);

function timed(rows: TikTokRow[]) {
  return rows
    .filter((row) => Number.isFinite(row.at))
    .map((row) => {
      const details = parse(row);
      return { row, details, t: row.at, fresh: row.Object === row.log_object_type && did(details, 'Create') };
    })
    .sort((a, b) => a.t - b.t || Number(b.fresh) - Number(a.fresh));
}

function adNames(rows: TikTokRow[]) {
  const ads = new Map<string, { t: number; video: string; renamed: string }>();
  for (const { row, details, t, fresh } of timed(rows)) {
    const id = row['Object ID'];
    if (row.log_object_type !== 'Ad' || !id) continue;
    if (fresh) {
      ads.set(id, { t, video: '', renamed: '' });
      continue;
    }
    const ad = ads.get(id);
    if (!ad) continue;
    for (const d of details) {
      const after = d.before_after?.[0]?.after?.split(' ; ')[0].trim();
      if (!after) continue;
      if (row.Object === 'Settings' && d.name === 'Ad name') ad.renamed = after;
      else if (row.Object === 'Creative' && d.name === 'Video' && !ad.video && t - ad.t < SETUP_MS) ad.video = after;
    }
  }
  return new Map([...ads].map(([id, { video, renamed }]) => [id, [video, renamed]]));
}

function tiktokEvents(
  rows: TikTokRow[],
  company: string,
  building: Building,
  made: Made,
  actorOf: (operator: string | undefined) => string,
  ours: (name: string) => boolean,
  totals: Record<string, number>,
) {
  const names = adNames(rows);
  const on = new Map<string, boolean>();
  const passed = new Map<string, boolean>();
  const born = new Map<string, number>();
  const live = (id: string, wasOn = true, hadPassed = true) => (on.get(id) ?? wasOn) && (passed.get(id) ?? hadPassed);
  for (const { row, details, t, fresh } of timed(rows)) {
    const resource = RESOURCES[row.log_object_type ?? ''];
    const raw = row['Object ID'];
    if (!resource || !raw) continue;
    const id = `tiktok:${raw}`;
    const actor = actorOf(row.Operator);
    const object = row.Object ?? '';
    const changes = details.flatMap((d) => d.before_after ?? []);
    if (fresh) {
      born.set(id, t);
      on.set(id, !details.some((d) => /Status: Paused/.test(d.name ?? '')));
      passed.set(id, resource === 'campaign');
      const event = made(resource, t, actor, building, 'tiktok', 'TikTok', company, live(id) ? 'active' : 'inactive', 'create', id);
      if (event && resource === 'ad' && (names.get(raw) ?? []).some(ours)) {
        event.ours = (event.ours ?? 0) + 1;
        totals[OWN_TOTAL] = (totals[OWN_TOTAL] ?? 0) + 1;
      }
      continue;
    }
    if (object === 'On/Off Status') {
      const gone = did(details, 'Delete');
      const change = changes.find((c) => SWITCH.has(c.after ?? ''));
      if (!gone && !change) continue;
      const was = gone ? live(id, false) : live(id, change!.before === 'Enabled');
      on.set(id, !gone && change!.after === 'Enabled');
      const now = live(id);
      if (gone) made(resource, t, actor, building, 'tiktok-deletes', 'TikTok deletes', company, was ? 'inactive' : null, was ? 'status' : 'edit', id);
      else if (was !== now) made(resource, t, actor, building, 'tiktok-status', 'TikTok status changes', company, now ? 'active' : 'inactive', 'status', id);
      else made(resource, t, actor, building, 'tiktok-status', 'TikTok status changes', company, null, 'edit', id);
      continue;
    }
    if (object === 'Review Status') {
      const change = changes.find((c) => c.after);
      const after = change?.after ?? '';
      if (!PASSED.has(after) && after !== 'Not approved') continue;
      const was = live(id, true, !WAITING.has(change?.before ?? ''));
      passed.set(id, PASSED.has(after));
      const now = live(id);
      if (after === 'Not approved') made(resource, t, actor, building, 'tiktok-rejected', 'TikTok rejections', company, was ? 'inactive' : null, was ? 'status' : 'edit', id);
      else if (was !== now) made(resource, t, actor, building, 'tiktok-review', 'TikTok ad review', company, 'active', 'status', id);
      continue;
    }
    if (SETUP.has(object) && t - (born.get(id) ?? -Infinity) < SETUP_MS) continue;
    const [slug, name] = object === 'Settings' ? (details.every((d) => /name/i.test(d.name ?? '')) ? NAMES : BUDGETS) : (ACTIONS[object] ?? OTHER);
    made(resource, t, actor, building, slug, name, company, null, 'edit', id);
  }
}

export function writeTikTokSource(window: Window, root: string, accounts: Account[], out: string) {
  const { actors, totals, system, made, write } = collect(window);
  const actorOf = (company: string) => (operator: string | undefined) => {
    const name = (operator ?? '').trim().toLowerCase();
    if (name === 'automated rule') return system('outputs:ads:tiktok-rules', 'TikTok Automated Rules');
    if (!MASKED.test(name)) return system('outputs:ads:tiktok', 'TikTok Ads');
    const key = `tiktok:${company}:${name}`;
    if (!actors.has(key)) actors.set(key, { key, email: null, name, kind: 'person', groupHint: null, clientHint: `company:${company}` });
    return key;
  };
  const ours = ownAd(config.tiktok.ownAdName);
  for (const { company, events } of logsOf<TikTokRow>(root, window, accounts)) tiktokEvents(events, company, ADS, made, actorOf(company), ours, totals);
  write('TikTok activity', out);
}
