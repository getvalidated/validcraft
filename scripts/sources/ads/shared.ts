import fs from 'node:fs';
import path from 'node:path';
import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type Feature,
  type ResourceStatus,
  type ResourceType,
  type SourceEvent,
  type SourceFile,
  type Window,
} from '../../../src/schema';
import { config, setting } from '../../lib/config';
import { openState, pagesIn, readPage } from '../sessions/shared';

export type Kind = 'create' | 'status' | 'edit';

export type Made = (
  resource: ResourceType | null,
  t: number | null,
  actor: string,
  building: Building,
  slug: string,
  name: string,
  company: string | null,
  status?: ResourceStatus | null,
  kind?: Kind,
  id?: string | null,
) => SourceEvent | null;

export interface Account {
  company: string;
  name: string;
  account: string;
}

export const ADS: Building = { id: 'ad-platforms', region: INTERNAL_REGION, name: 'Ad Platforms', resource: 'ad' };
export const OWN_TOTAL = 'ad made by us';

const MINUTE = 60_000;

export const ms = (value: unknown) => (value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value.replace(/(\.\d{3})\d+/, '$1')) : NaN);

export function accountsOf(field: 'metaAccounts' | 'tiktokAdvertisers') {
  const list: Account[] = [];
  const seen = new Set<string>();
  for (const client of config.clients) {
    for (const id of client[field] ?? []) {
      const account = String(id).trim().replace(/^act_/, '');
      if (!account || seen.has(account)) continue;
      seen.add(account);
      list.push({ company: client.id, name: client.shortname ?? client.name, account });
    }
  }
  setting(list.length || null, `clients[].${field}`);
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
}

export function logsOf<T>(root: string, window: Window, accounts: Account[]) {
  return accounts.flatMap((account) => {
    const dir = path.join(root, account.account);
    const state = openState(dir, window);
    return state.complete && !state.denied ? [{ ...account, events: pagesIn(dir).flatMap((file) => readPage<T[]>(file)) }] : [];
  });
}

export function ownAd(pattern: string | null) {
  const test = pattern ? new RegExp(pattern, 'i') : null;
  return (name: string) => !!test?.test(name);
}

export function collect(window: Window) {
  const actors = new Map<string, ActorRef>();
  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const grouped = new Map<string, SourceEvent>();
  const totals: Record<string, number> = {};
  const born = new Set<string>();
  const system = (key: string, name: string) => {
    if (!actors.has(key)) actors.set(key, { key, email: null, name, kind: 'system', groupHint: null, clientHint: null });
    return key;
  };
  const made: Made = (resource, t, actor, building, slug, name, company, status = null, kind = 'create', id = null) => {
    if (t === null || !(t >= window.start && t < window.end)) return null;
    const total = kind === 'status' ? `${resource} turned ${status}` : `${resource ?? slug}${kind === 'create' ? '' : ` ${kind}`}`;
    totals[total] = (totals[total] ?? 0) + 1;
    buildings.set(building.id, building);
    const feature = `${building.id}/${slug}`;
    features.set(feature, { id: feature, building: building.id, name });
    const minute = Math.floor(t / MINUTE) * MINUTE;
    const key = `${resource}|${actor}|${feature}|${company}|${minute}|${kind}|${status}|${id}`;
    let event = grouped.get(key);
    if (event) event.count++;
    else {
      let resourceId = resource && (id ?? `${resource}:${company ?? 'none'}:${slug}:${minute}`);
      for (let n = 2; resourceId && !id && kind === 'create' && born.has(resourceId); n++) resourceId = `${resource}:${company ?? 'none'}:${slug}:${minute}:${n}`;
      if (resourceId) born.add(resourceId);
      event = {
        kind,
        t: id ? t : minute,
        actor,
        via: null,
        resource,
        resourceId,
        building: building.id,
        from: null,
        to: null,
        isReturn: false,
        count: 1,
        clientHint: company ? `company:${company}` : null,
        feature,
        ...(status ? { status } : {}),
      };
      grouped.set(key, event);
    }
    return event;
  };
  const write = (label: string, out: string) => {
    const file: SourceFile = {
      schemaVersion: SCHEMA_VERSION,
      source: 'outputs',
      window,
      actors: [...actors.values()].sort((a, b) => a.key.localeCompare(b.key)),
      buildings: [...buildings.values()],
      features: [...features.values()],
      events: [...grouped.values()].sort((a, b) => a.t - b.t),
      initial: [],
      sessions: [],
      measures: [],
      artifacts: [],
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(file));
    for (const [resource, n] of Object.entries(totals)) console.log(`  ${resource.padEnd(24)}${String(n).padStart(8)}`);
    console.log(`Wrote ${path.relative(process.cwd(), out)}: ${file.events.length} ${label} events, ${file.actors.length} actors.`);
  };
  return { actors, totals, system, made, write };
}
