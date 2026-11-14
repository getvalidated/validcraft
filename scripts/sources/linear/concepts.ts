import type { SourceConcept, SourceLink } from '../../../src/schema';
import { config } from '../../lib/config';
import { markdownLinks, refKey } from '../../lib/refs';
import type { RawIssue } from './convert';
import { readDelivery, type DeliveredIssue } from './pull';

type Extra = {
  title?: string | null;
  labels?: { nodes: { name: string }[] };
  parent?: { identifier: string } | null;
  relations?: { nodes: { type: string; relatedIssue: { identifier: string } | null }[] };
  inverseRelations?: { nodes: { type: string; issue: { identifier: string } | null }[] };
};
type Issue = RawIssue & Extra;

export type ConceptRule = 'label';

const TEAM = config.linear.conceptTeam;
const TYPES = /^(?:ai )?(?:videos?|statics?|animations?|ugc|slides?)$/i;
const MARKS = new Set(config.linear.conceptLabels.map((label) => label.toLowerCase()));
const ISSUE_URL = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/;

const userKey = (id: string) => `linear:${id}`;
const actorOf = (issue: RawIssue) => (issue.creator ? userKey(issue.creator.id) : `linear:bot:${issue.botActor?.name?.trim() || 'Linear'}`);
const teamOf = (ident: string) => ident.slice(0, ident.lastIndexOf('-'));

function mentions(issue: RawIssue) {
  const out: { ident: string; t: number }[] = [];
  const add = (text: string, t: number) => {
    for (const { link } of markdownLinks(text)) {
      const m = ISSUE_URL.exec(link);
      if (m && m[1].toUpperCase() !== issue.identifier) out.push({ ident: m[1].toUpperCase(), t });
    }
  };
  add(issue.description ?? '', Date.parse(issue.createdAt));
  for (const a of issue.attachments?.nodes ?? []) add(a.url ?? '', Date.parse(a.createdAt));
  for (const c of issue.comments) add(c.body ?? '', Date.parse(c.createdAt));
  return out;
}

const SHEET_ROWS = /\[([\d\s,\-–]+)\]\(<?https?:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})([^\s)>]*)/g;
const MAX_RANGE = 200;

export function sheetRows(issue: Pick<RawIssue, 'description' | 'createdAt' | 'comments'>) {
  const out: { sheet: string; row: number; t: number; tab: string | null }[] = [];
  const add = (text: string, t: number) => {
    for (const m of text.matchAll(SHEET_ROWS)) {
      for (const part of m[1].split(',')) {
        const [a, b] = part.split(/[-–]/).map((x) => Number(x.trim()));
        if (!Number.isInteger(a) || a <= 0) continue;
        const end = Number.isInteger(b) && b >= a && b - a <= MAX_RANGE ? b : a;
        for (let row = a; row <= end; row++) out.push({ sheet: m[2], row, t, tab: /gid=(\d+)/.exec(m[3])?.[1] ?? null });
      }
    }
  };
  add(issue.description ?? '', Date.parse(issue.createdAt));
  for (const c of issue.comments) add(c.body ?? '', Date.parse(c.createdAt));
  return out;
}

function ruleOf(issue: Issue, labels: string[]): ConceptRule | null {
  if (teamOf(issue.identifier) !== TEAM) return null;
  const lower = labels.map((l) => l.toLowerCase());
  const typed = labels.some((l) => TYPES.test(l));
  return typed || lower.some((l) => MARKS.has(l)) ? 'label' : null;
}

export function conceptsOf(issues: RawIssue[]) {
  const delivery = readDelivery();
  const delivered = new Map<string, DeliveredIssue>();
  for (const d of [...delivery.creativeOpen, ...delivery.creativeDone]) delivered.set(d.identifier, d);
  const byUuid = new Map(issues.map((i) => [i.id, i.identifier]));

  const concepts = new Map<string, SourceConcept & { rule: ConceptRule }>();
  const seen = new Set<string>();
  for (const raw of issues as Issue[]) {
    if (seen.has(raw.identifier)) continue;
    seen.add(raw.identifier);
    const d = delivered.get(raw.identifier);
    const title = raw.title?.trim() || d?.title?.trim() || null;
    const labels = [...(raw.labels?.nodes ?? []), ...(d?.labels.nodes ?? [])].map((l) => l.name);
    const rule = ruleOf(raw, labels);
    if (!rule) continue;
    const origin = mentions(raw).find((m) => m.t === Date.parse(raw.createdAt) && teamOf(m.ident) === TEAM);
    concepts.set(raw.identifier, {
      id: refKey('ticket', raw.identifier),
      name: title ?? raw.identifier,
      t: Date.parse(raw.createdAt),
      actor: actorOf(raw),
      clientHint: raw.project ? `linear-project:${raw.project.name}` : null,
      ...(origin ? { from: refKey('ticket', origin.ident) } : {}),
      rule,
    });
  }
  for (const d of delivered.values()) {
    if (seen.has(d.identifier)) continue;
    const labels = d.labels.nodes.map((l) => l.name);
    const fake = { identifier: d.identifier, description: '' } as Issue;
    const rule = ruleOf(fake, labels);
    if (!rule) continue;
    concepts.set(d.identifier, {
      id: refKey('ticket', d.identifier),
      name: d.title.trim(),
      t: Date.parse(d.createdAt),
      actor: null,
      clientHint: null,
      rule,
    });
  }

  const links: SourceLink[] = [];
  const isConcept = (ident: string) => concepts.has(ident);
  const created = new Map(issues.map((i) => [i.identifier, Date.parse(i.createdAt)]));
  const titles = new Map((issues as Issue[]).map((i) => [i.identifier, i.title?.trim() || delivered.get(i.identifier)?.title?.trim() || i.identifier]));
  const hook = (parent: string, child: string, t: number) => {
    if (parent !== child && !isConcept(child) && teamOf(child) === TEAM) links.push({ parent: refKey('ticket', parent), child: refKey('ticket', child), t, name: titles.get(child) ?? child });
  };
  for (const raw of issues as Issue[]) {
    const t = Date.parse(raw.createdAt);
    const parent = raw.parent?.identifier ?? (delivered.get(raw.identifier)?.parent ? byUuid.get(delivered.get(raw.identifier)!.parent!.id) : undefined);
    if (parent) hook(parent, raw.identifier, t);
    const related = [
      ...(raw.relations?.nodes ?? []).map((r) => r.relatedIssue?.identifier),
      ...(raw.inverseRelations?.nodes ?? []).map((r) => r.issue?.identifier),
    ].filter((x): x is string => !!x);
    for (const other of related) {
      if (isConcept(raw.identifier) && teamOf(other) === TEAM) hook(raw.identifier, other, Math.max(t, created.get(other) ?? t));
      else if (isConcept(other) && teamOf(raw.identifier) === TEAM) hook(other, raw.identifier, Math.max(t, created.get(other) ?? t));
    }
    if (teamOf(raw.identifier) !== TEAM) continue;
    const rows = new Set<string>();
    for (const { sheet, row, t: at } of sheetRows(raw)) {
      const child = refKey('row', `sheet:${sheet}:${row}`);
      if (rows.has(child)) continue;
      rows.add(child);
      links.push({ parent: refKey('ticket', raw.identifier), child, t: at, name: `Row ${row}` });
    }
    if (isConcept(raw.identifier)) continue;
    for (const m of mentions(raw)) if (isConcept(m.ident)) hook(m.ident, raw.identifier, m.t);
  }

  const rules: Record<ConceptRule, number> = { label: 0 };
  for (const c of concepts.values()) rules[c.rule]++;
  return {
    concepts: [...concepts.values()].map(({ rule, ...c }) => c).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)),
    links: links.sort((a, b) => a.t - b.t),
    rules,
  };
}

export function conceptFields(issues: RawIssue[], links: SourceLink[]) {
  const found = conceptsOf(issues);
  return { links: [...links, ...found.links], concepts: found.concepts };
}
