import {
  INTERNAL_REGION,
  RECRUIT_HINT,
  RECRUIT_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Group,
  type Region,
  type Registry,
  type SourceFile,
  type Unit,
  type UnitKind,
} from '../../src/schema';
import { config } from '../lib/config';
import type { Company, Raw, SlackUser } from './pull';

export interface Overrides {
  identities: Record<string, string | null>;
  clientHints: Record<string, string | null>;
  ignoreChannels: string[];
}

export interface RegistryReport {
  regions: { total: number; internal: number; client: number };
  units: { total: number } & Record<UnitKind, number>;
  groups: number;
  identities: { total: number; slack: number; linear: number; notion: number; other: number };
  emails: number;
  clientHints: Record<string, number>;
  sharedChannels: { total: number; matched: number; unmatched: string[] };
  sourceActors: { total: number; unmapped: string[] };
  linearProjects: { total: number; matched: number; unmatched: string[] };
}

export const COMPANY_DOMAINS = config.org.domains.map((domain) => domain.toLowerCase());
const NON_PERSON = /(^|[._\-+])(test|trial|demo|qa)\d*($|[._\-+])|^room\.|\+/;
const CHANNEL_PREFIXES = [...config.slack.channelPrefixes].map((prefix) => prefix.toLowerCase()).sort((a, b) => b.length - a.length);
const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'hey.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'fastmail.com',
  'yandex.com',
  'qq.com',
  '163.com',
]);
const AUTOMATIONS = `${INTERNAL_REGION}/automations`;
const MASKED_EMAIL = /^(.)\*+(.)@(.+)$/;
const DEACTIVATED = 'deactivated';
const SLACK_CHANNEL = 'slack-channel:';
const INTERNAL_PREFIX = 'internal-';
const PRELUDE = 7 * 86_400_000;
const LOOSE_MIN = 4;
const RECRUITING = /recruit|hiring/i;

const regionId = (companyId: string) => `c:${companyId}`;
const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = (text: string) => tokens(text).join('');
const nameTokens = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const sortRecord = <T>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).sort((a, b) => a[0].localeCompare(b[0]))) as Record<string, T>;

function splitEmail(email: string) {
  const at = email.lastIndexOf('@');
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

const onCompanyDomain = (email: string | null) => !!email && COMPANY_DOMAINS.includes(splitEmail(email).domain);

function near(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (text: string, skip: number) => text.slice(i + skip);
  return rest(a, 1) === rest(b, 1) || rest(a, 1) === rest(b, 0) || rest(a, 0) === rest(b, 1);
}

function top(counts: Map<string, number>) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function bump(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function stripPrefix(name: string) {
  const lower = name.toLowerCase();
  const prefix = CHANNEL_PREFIXES.find((p) => lower.startsWith(p));
  return prefix ? lower.slice(prefix.length) : lower;
}

function containsName(hay: string[], needle: string) {
  for (let i = 0; i < hay.length; i++) {
    let joined = '';
    for (let j = i; j < hay.length && joined.length < needle.length; j++) {
      joined += hay[j];
      if (joined === needle) return true;
    }
  }
  return false;
}

const slackName = (u: SlackUser) => u.displayName ?? u.realName ?? u.handle ?? u.id;

export function derive(raw: Raw, sources: SourceFile[], overrides: Overrides): { registry: Registry; report: RegistryReport } {
  const companies = [...raw.companies].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const companyKeys = new Map<Company, string[]>(
    companies.map((c) => [c, [...new Set([c.shortname ?? '', c.name].map(norm).filter((key) => key.length > 1))]]),
  );
  const companiesNamed = (match: (key: string) => boolean) => companies.filter((c) => companyKeys.get(c)!.some(match));

  const regions: Region[] = [
    { id: INTERNAL_REGION, kind: 'internal', name: config.org.name },
    ...companies.map((c): Region => ({ id: regionId(c.id), kind: 'client', name: c.name, ...(c.since !== null ? { since: c.since } : {}) })),
  ];
  const clientRegions = new Set(companies.map((c) => regionId(c.id)));
  const born = new Map(companies.map((c) => [regionId(c.id), c.since]));

  const units = new Map<string, Unit>();
  const identities: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const clientHints: Record<string, string> = {};

  const slackById = new Map(raw.slackUsers.map((u) => [u.id, u]));
  const teamCounts = new Map<string, number>();
  for (const u of raw.slackUsers) if (u.teamId) bump(teamCounts, u.teamId);
  const homeTeam = top(teamCounts);

  const domainRank = (u: SlackUser) => COMPANY_DOMAINS.indexOf(splitEmail(u.email!).domain);
  const team = raw.slackUsers
    .filter((u) => !u.isBot && u.teamId === homeTeam && onCompanyDomain(u.email) && !NON_PERSON.test(splitEmail(u.email!).local))
    .sort((a, b) => domainRank(a) - domainRank(b) || Number(a.deleted) - Number(b.deleted) || a.id.localeCompare(b.id));
  const byLocal = new Map<string, string>();
  const active = new Set<string>();
  for (const u of team) {
    const { local } = splitEmail(u.email!);
    const id = byLocal.get(local) ?? `u:${u.email}`;
    byLocal.set(local, id);
    if (!units.has(id)) units.set(id, { id, kind: 'person', name: slackName(u), region: INTERNAL_REGION, group: null });
    emails[u.email!] = id;
    identities[`slack:${u.id}`] = id;
    if (!u.deleted) active.add(id);
  }

  const isOutside = (u: SlackUser) =>
    !u.isBot && !identities[`slack:${u.id}`] && (u.teamId !== homeTeam || (u.isRestricted && !onCompanyDomain(u.email)));
  const membersOf = (channel: string) =>
    (raw.slackMembers.get(channel) ?? []).map((id) => slackById.get(id)).filter((u): u is SlackUser => !!u);

  const ignored = new Set(overrides.ignoreChannels);
  const channels = raw.slackChannels.filter((c) => !c.isArchived && !ignored.has(c.id));
  const channelRegion = new Map<string, string>();
  const internalOwners = new Map<string, Set<string>>();
  for (const c of companies) {
    if (!c.internalChannel || ignored.has(c.internalChannel)) continue;
    if (!internalOwners.has(c.internalChannel)) internalOwners.set(c.internalChannel, new Set());
    internalOwners.get(c.internalChannel)!.add(regionId(c.id));
  }
  for (const [channel, owners] of internalOwners) if (owners.size === 1) channelRegion.set(channel, [...owners][0]);

  const shared = channels.filter((c) => c.isExtShared || c.isPendingExtShared || membersOf(c.id).some(isOutside));
  const companiesFor = (key: string) => {
    const hits = companiesNamed((k) => k === key);
    if (hits.length || key.length < LOOSE_MIN) return hits;
    return companies.filter((co) => {
      const name = norm(co.name);
      return name.length >= LOOSE_MIN && (name.startsWith(key) || key.startsWith(name));
    });
  };
  for (const c of shared) {
    if (channelRegion.has(c.id)) continue;
    const hits = companiesFor(norm(stripPrefix(c.name)));
    if (hits.length === 1) channelRegion.set(c.id, regionId(hits[0].id));
  }
  for (const c of channels) if (!channelRegion.has(c.id) && RECRUITING.test(c.name)) channelRegion.set(c.id, RECRUIT_REGION);
  for (const [hint, region] of Object.entries(overrides.clientHints)) {
    if (!hint.startsWith(SLACK_CHANNEL)) continue;
    if (region) channelRegion.set(hint.slice(SLACK_CHANNEL.length), region);
    else channelRegion.delete(hint.slice(SLACK_CHANNEL.length));
  }
  for (const [channel, region] of channelRegion) clientHints[`${SLACK_CHANNEL}${channel}`] = region;
  const opened = new Map<string, number>();
  const open = (region: string, created: number | null | undefined) => {
    if (created && clientRegions.has(region) && created >= (born.get(region) ?? 0) - PRELUDE) opened.set(region, Math.min(opened.get(region) ?? Infinity, created));
  };
  for (const c of raw.slackChannels) {
    const linked = channelRegion.get(c.id);
    const name = c.name.toLowerCase();
    const hits = linked || !name.startsWith(INTERNAL_PREFIX) ? [] : companiesFor(norm(name.slice(INTERNAL_PREFIX.length)));
    open(linked ?? (hits.length === 1 ? regionId(hits[0].id) : ''), c.created);
  }
  for (const region of regions) if (opened.has(region.id)) region.since = opened.get(region.id);
  for (const region of clientRegions) clientHints[`company:${region.slice(2)}`] = region;

  const outsiders = new Map<string, { users: Map<string, SlackUser>; regions: Map<string, number> }>();
  for (const [channel, region] of channelRegion) {
    for (const u of membersOf(channel)) {
      if (!isOutside(u)) continue;
      const key = u.email ?? u.id;
      if (!outsiders.has(key)) outsiders.set(key, { users: new Map(), regions: new Map() });
      outsiders.get(key)!.users.set(u.id, u);
      bump(outsiders.get(key)!.regions, region);
    }
  }
  const domainRegions = new Map<string, Set<string>>();
  for (const person of outsiders.values()) {
    const accounts = [...person.users.values()].sort((a, b) => a.id.localeCompare(b.id));
    const id = `u:slack:${accounts[0].id}`;
    const region = top(person.regions)!;
    units.set(id, { id, kind: 'client', name: slackName(accounts[0]), region, group: null });
    for (const u of accounts) {
      identities[`slack:${u.id}`] = id;
      if (!u.email) continue;
      emails[u.email] ??= id;
      const { domain } = splitEmail(u.email);
      if (CONSUMER_DOMAINS.has(domain) || COMPANY_DOMAINS.includes(domain)) continue;
      if (!domainRegions.has(domain)) domainRegions.set(domain, new Set());
      domainRegions.get(domain)!.add(region);
    }
  }
  for (const [domain, found] of domainRegions) if (found.size === 1) clientHints[`email-domain:${domain}`] = [...found][0];

  const teamChannels = new Map<string, Set<string>>();
  for (const c of channels) {
    const teams = new Set(c.teamIds);
    for (const u of membersOf(c.id)) if (u.teamId) teams.add(u.teamId);
    if (homeTeam) teams.delete(homeTeam);
    for (const id of teams) {
      if (!teamChannels.has(id)) teamChannels.set(id, new Set());
      teamChannels.get(id)!.add(c.id);
    }
  }
  for (const [id, found] of teamChannels) {
    const mapped = new Set([...found].map((channel) => channelRegion.get(channel) ?? null));
    const only = mapped.size === 1 ? [...mapped][0] : null;
    if (only) clientHints[`slack-team:${id}`] = only;
  }

  const unmatchedProjects: string[] = [];
  let matchedProjects = 0;
  for (const project of raw.linearProjects) {
    const words = project.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const lower = words.map((word) => word.toLowerCase());
    const hits = companies.filter((co) => {
      const code = co.shortname;
      const name = norm(co.name);
      return (
        (!!code && (code === code.toUpperCase() ? words.includes(code) : lower.includes(code.toLowerCase()))) ||
        (name.length > 1 && containsName(lower, name))
      );
    });
    if (hits.length === 1) {
      clientHints[`linear-project:${project.name}`] = regionId(hits[0].id);
      matchedProjects++;
    } else {
      unmatchedProjects.push(project.id);
    }
  }

  const unitForEmail = (email: string | null) => {
    if (!email) return null;
    const address = email.toLowerCase();
    if (emails[address]) return emails[address];
    const { local, domain } = splitEmail(address);
    const id = COMPANY_DOMAINS.includes(domain) ? byLocal.get(local) : undefined;
    if (id) emails[address] = id;
    return id ?? null;
  };

  const linearUnit = new Map<string, string>();
  for (const u of raw.linearUsers) {
    const id = unitForEmail(u.email);
    if (!id) continue;
    identities[`linear:${u.id}`] = id;
    linearUnit.set(u.id, id);
  }
  for (const u of raw.notionUsers) {
    const id = unitForEmail(u.email);
    if (id) identities[`notion:${u.id}`] = id;
  }

  const notionById = new Map(raw.notionUsers.map((u) => [`notion:${u.id}`, u]));
  const slackActor = (key: string) => (key.startsWith('slack:') ? slackById.get(key.slice('slack:'.length)) : undefined);
  const isBotActor = (a: ActorRef) =>
    a.kind === 'automation' || a.kind === 'system' || notionById.get(a.key)?.type === 'bot' || slackActor(a.key)?.isBot === true;

  const actorKeys = new Set<string>();
  const referenced = new Set<string>();
  const hintCounts = new Map<string, Map<string, number>>();
  const resolved = new Map<string, string | null>();
  for (const file of sources) {
    for (const actor of file.actors) {
      actorKeys.add(actor.key);
      let id: string | null;
      if (actor.key in overrides.identities) {
        id = overrides.identities[actor.key];
      } else {
        id = identities[actor.key] ?? unitForEmail(actor.email);
        if (!id && isBotActor(actor) && !actor.external) {
          id = `u:${actor.key}`;
          const name = actor.name ?? slackActor(actor.key)?.realName ?? notionById.get(actor.key)?.name ?? actor.key;
          units.set(id, { id, kind: 'automation', name, region: INTERNAL_REGION, group: AUTOMATIONS });
          identities[actor.key] = id;
        }
      }
      resolved.set(actor.key, id);
      if (!id) continue;
      referenced.add(id);
      if (actor.groupHint) {
        if (!hintCounts.has(id)) hintCounts.set(id, new Map());
        bump(hintCounts.get(id)!, actor.groupHint);
      }
    }
  }

  const forms = new Map<string, string[][]>();
  const addForm = (id: string | undefined, text: string | null) => {
    const form = id && text ? nameTokens(text) : [];
    if (!id || !form.length) return;
    if (!forms.has(id)) forms.set(id, []);
    forms.get(id)!.push(form);
  };
  for (const u of raw.slackUsers) {
    const id = identities[`slack:${u.id}`] ?? (u.email ? emails[u.email.toLowerCase()] : undefined);
    addForm(id, u.realName);
    addForm(id, u.displayName);
  }
  for (const [email, id] of Object.entries(emails)) addForm(id, splitEmail(email).local);
  const unitForName = (actor: ActorRef) => {
    const name = actor.kind === 'person' && !actor.email && actor.name ? nameTokens(actor.name) : [];
    if (name.length < 2) return null;
    const first = name[0];
    const last = name[name.length - 1];
    const region = actor.clientHint ? clientHints[actor.clientHint] ?? null : null;
    let best = 0;
    let found: string[] = [];
    for (const [id, list] of forms) {
      const unit = units.get(id);
      if (!unit) continue;
      let score = 0;
      let clash = false;
      for (const form of list) {
        const end = form[form.length - 1];
        if (form.join('') === name.join('') || (form.length > 1 && form[0] === first && end === last)) score = 3;
        else if (form.length > 1 && end === last && near(form[0], first)) score = Math.max(score, 2);
        else if (form.length === 1 && form[0] === first && first.length > 2) score = Math.max(score, 1);
        else if (form.length > 1 && form[0] === first) clash = true;
      }
      if (score === 1 && clash) continue;
      const allowed =
        unit.kind === 'person' ? score >= 2 || (score === 1 && !region) : unit.kind === 'client' && (score === 3 || (score > 0 && unit.region === region));
      if (!allowed || score < best) continue;
      if (score > best) {
        best = score;
        found = [];
      }
      found.push(id);
    }
    return found.length === 1 ? found[0] : null;
  };

  for (const file of sources) {
    for (const actor of file.actors) {
      if (resolved.get(actor.key) || actor.key in overrides.identities) continue;
      const id = unitForName(actor);
      if (!id) continue;
      identities[actor.key] = id;
      resolved.set(actor.key, id);
      referenced.add(id);
    }
  }

  const worked = new Map<string, Map<string, number>>();
  for (const file of sources) {
    for (const e of file.events) {
      const id = resolved.get(e.actor);
      const region = e.clientHint ? clientHints[e.clientHint] : undefined;
      if (!id || !region) continue;
      for (const key of [region, `${region}|${e.building}`]) {
        if (!worked.has(key)) worked.set(key, new Map());
        bump(worked.get(key)!, id);
      }
    }
  }
  for (const file of sources) {
    for (const actor of file.actors) {
      const masked = actor.email ? null : MASKED_EMAIL.exec(actor.name ?? '');
      if (!masked || resolved.get(actor.key) || actor.key in overrides.identities) continue;
      const [, first, last, domain] = masked;
      const found = new Set(
        Object.entries(emails)
          .filter(([address]) => splitEmail(address).domain === domain && address[0] === first && splitEmail(address).local.endsWith(last))
          .map(([, unit]) => unit),
      );
      const region = actor.clientHint ? clientHints[actor.clientHint] : undefined;
      const seen = (key: string) => [...found].filter((unit) => worked.get(key)?.has(unit));
      let id = found.size === 1 ? [...found][0] : [seen(`${region}|ad-platforms`), seen(`${region}`)].find((there) => there.length === 1)?.[0];
      if (!id && COMPANY_DOMAINS.includes(domain)) {
        id = `u:${actor.name}`;
        if (!units.has(id)) units.set(id, { id, kind: 'person', name: actor.name!, region: INTERNAL_REGION, group: null });
      }
      if (!id) continue;
      identities[actor.key] = id;
      resolved.set(actor.key, id);
      referenced.add(id);
    }
  }

  const bots = new Map<string, string>();
  for (const [id, unit] of [...units].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (unit.kind === 'automation' && unit.region === INTERNAL_REGION && !bots.has(unit.name.toLowerCase())) bots.set(unit.name.toLowerCase(), id);
  }
  for (const file of sources) {
    for (const actor of file.actors) {
      if (resolved.get(actor.key) || actor.key in overrides.identities) continue;
      const [local, domain] = (actor.email ?? (actor.name?.includes('@') ? actor.name : '')).toLowerCase().split('@');
      const id = bots.get((actor.name ?? '').toLowerCase()) ?? (COMPANY_DOMAINS.includes(domain ?? '') ? bots.get(local) : undefined);
      if (!id) continue;
      identities[actor.key] = id;
      resolved.set(actor.key, id);
      referenced.add(id);
    }
  }

  for (const [id, unit] of units) {
    if (unit.kind !== 'person' || active.has(id) || referenced.has(id)) continue;
    units.delete(id);
    for (const key of Object.keys(identities)) if (identities[key] === id) delete identities[key];
    for (const address of Object.keys(emails)) if (emails[address] === id) delete emails[address];
  }

  if ([...channelRegion.values()].includes(RECRUIT_REGION)) {
    regions.push({ id: RECRUIT_REGION, kind: 'recruiting', name: 'Recruiting' });
    clientHints[RECRUIT_HINT] = RECRUIT_REGION;
  }

  const teams = raw.linearTeams.filter((t) => t.members.length > 0);
  const teamKeys = new Set(teams.map((t) => t.key));
  const groups: Group[] = teams
    .map((t): Group => ({ id: `${INTERNAL_REGION}/${t.key}`, region: INTERNAL_REGION, name: t.key }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if ([...units.values()].some((u) => u.group === AUTOMATIONS)) {
    groups.push({ id: AUTOMATIONS, region: INTERNAL_REGION, name: 'Automations' });
  }
  const memberOf = new Map<string, Set<string>>();
  for (const t of teams) {
    for (const member of t.members) {
      const id = linearUnit.get(member);
      if (!id) continue;
      if (!memberOf.has(id)) memberOf.set(id, new Set());
      memberOf.get(id)!.add(t.key);
    }
  }
  for (const unit of units.values()) {
    if (unit.kind !== 'person') continue;
    const hinted = new Map([...(hintCounts.get(unit.id) ?? [])].filter(([key]) => teamKeys.has(key)));
    const member = memberOf.get(unit.id);
    const key = top(hinted) ?? (member?.size === 1 ? [...member][0] : null);
    unit.group = key ? `${INTERNAL_REGION}/${key}` : null;
  }

  for (const [key, id] of Object.entries(overrides.identities)) {
    if (id) identities[key] = id;
    else delete identities[key];
  }
  for (const [hint, region] of Object.entries(overrides.clientHints)) {
    if (region) clientHints[hint] = region;
    else delete clientHints[hint];
  }

  const left = [...new Set(byLocal.values())].filter((id) => units.get(id)?.kind === 'person' && !active.has(id));
  for (const id of left) {
    const unit = units.get(id)!;
    unit.region = DEACTIVATED;
    unit.group = null;
  }
  if (left.length) regions.push({ id: DEACTIVATED, kind: 'unmapped', name: 'Deactivated' });

  const registry: Registry = {
    schemaVersion: SCHEMA_VERSION,
    regions,
    groups,
    units: [...units.values()].sort((a, b) => a.id.localeCompare(b.id)),
    identities: sortRecord(identities),
    emails: sortRecord(emails),
    clientHints: sortRecord(clientHints),
  };

  const kinds: Record<UnitKind, number> = { person: 0, client: 0, automation: 0, system: 0, prospect: 0, recruit: 0, ambassador: 0 };
  for (const unit of registry.units) kinds[unit.kind]++;
  const bySource = { slack: 0, linear: 0, notion: 0, other: 0 };
  for (const key of Object.keys(registry.identities)) {
    if (key.startsWith('slack:')) bySource.slack++;
    else if (key.startsWith('linear:')) bySource.linear++;
    else if (key.startsWith('notion:')) bySource.notion++;
    else bySource.other++;
  }
  const hintKinds: Record<string, number> = {};
  for (const hint of Object.keys(registry.clientHints)) {
    const kind = hint.slice(0, hint.indexOf(':'));
    hintKinds[kind] = (hintKinds[kind] ?? 0) + 1;
  }
  const unmatchedChannels = shared.filter((c) => !channelRegion.has(c.id)).map((c) => c.id).sort();
  const unmappedActors = [...actorKeys].filter((key) => !units.has(resolved.get(key) ?? '')).sort();

  return {
    registry,
    report: {
      regions: { total: regions.length, internal: 1, client: regions.length - 1 },
      units: { total: registry.units.length, ...kinds },
      groups: groups.length,
      identities: { total: Object.keys(registry.identities).length, ...bySource },
      emails: Object.keys(registry.emails).length,
      clientHints: sortRecord(hintKinds),
      sharedChannels: { total: shared.length, matched: shared.length - unmatchedChannels.length, unmatched: unmatchedChannels },
      sourceActors: { total: actorKeys.size, unmapped: unmappedActors },
      linearProjects: { total: raw.linearProjects.length, matched: matchedProjects, unmatched: unmatchedProjects.sort() },
    },
  };
}
