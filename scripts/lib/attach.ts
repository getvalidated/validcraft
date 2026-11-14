import { INTERNAL_REGION, type ActorRef, type Building, type Feature, type SourceEvent, type SourceLink, type Window } from '../../src/schema';
import type { DriveFile } from './drive';
import { linkName, refKey, refOf, type Ref } from './refs';

export interface Found {
  t: number;
  actor: string;
  parent: string;
  link: string;
  name: string;
  clientHint: string | null;
  ref?: Ref;
}

const GENERIC = /→|^https?:|^(?:open|view|here|link|frame\.io|f\.io\/|board|video|final)\b/i;

const BUILDINGS: Record<string, Building> = {
  drive: { id: 'drive', region: INTERNAL_REGION, name: 'Google Drive', resource: 'video' },
  reports: { id: 'reports', region: INTERNAL_REGION, name: 'Reports', resource: 'report' },
  'video-tools': { id: 'video-tools', region: INTERNAL_REGION, name: 'Video Tools', resource: 'video' },
};

export const driveIds = (links: string[]) =>
  links.flatMap((link) => {
    const ref = refOf(link);
    return ref && 'drive' in ref ? [ref.drive] : [];
  });

export function attach(found: Found[], drive: Map<string, DriveFile>, window: Window, home: Building, shelf: string) {
  const events: SourceEvent[] = [];
  const links: SourceLink[] = [];
  const actors = new Map<string, ActorRef>();
  const buildings = new Map<string, Building>();
  const features = new Map<string, Feature>();
  const seen = new Set<string>();
  for (const item of [...found].sort((a, b) => a.t - b.t)) {
    let ref = item.ref ?? refOf(item.link, item.name);
    if (!ref) continue;
    let { t, actor, name } = item;
    if ('drive' in ref) {
      const file = drive.get(ref.drive);
      if (!file?.mime.startsWith('video/') || file.created === null) continue;
      t = file.created;
      name ||= file.name;
      if (file.email) {
        actor = `drive:email:${file.email}`;
        actors.set(actor, { key: actor, email: file.email, name: null, kind: 'person', groupHint: null, clientHint: null });
      }
      ref = { resource: 'video', id: `drive:${file.id}`, building: 'drive', feature: 'Linked videos' };
    }
    const child = refKey(ref.resource, ref.id);
    if (child === item.parent) continue;
    const label = (name?.trim() && !GENERIC.test(name.trim()) ? name.trim() : '') || linkName(item.link);
    links.push({ parent: item.parent, child, t: item.t, ...(label ? { name: label } : {}) });
    if ((ref.resource !== 'video' && ref.resource !== 'report') || ref.known || seen.has(child) || t < window.start || t >= window.end) continue;
    seen.add(child);
    const building = (ref.building ? BUILDINGS[ref.building] : undefined) ?? home;
    const feature = `${building.id}/${(ref.feature ?? shelf).toLowerCase().replace(/\s+/g, '-')}`;
    buildings.set(building.id, building);
    features.set(feature, { id: feature, building: building.id, name: ref.feature ?? shelf });
    events.push({
      kind: 'create',
      t,
      actor,
      via: null,
      resource: ref.resource,
      resourceId: ref.id,
      building: building.id,
      from: null,
      to: null,
      isReturn: false,
      count: 1,
      clientHint: item.clientHint,
      feature,
      parent: item.parent,
    });
  }
  return { events, links, actors: [...actors.values()], buildings: [...buildings.values()], features: [...features.values()] };
}
