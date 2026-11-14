import fs from 'node:fs';
import path from 'node:path';
import type { Metric, MetricRow, Window } from '../../src/schema';
import type { RawPull } from '../sources/github/convert';
import { RAW as GITHUB, readAuthors, readRaw as readGithub } from '../sources/github/pull';
import { readDelivery, type DeliveredIssue } from '../sources/linear/pull';
import { config } from './config';

type Part = { by: string; rows: MetricRow[] };

const DAY = 86_400_000;
const HOUR = 3_600_000;

const cell = (label: string, value: number | null, num?: number, den?: number): MetricRow => ({
  label,
  value: value === null ? '' : String(value),
  num: num === undefined ? '' : String(num),
  den: den === undefined ? '' : String(den),
  start: '',
  end: '',
  note: '',
});
const share = (label: string, num: number, den: number) => cell(label, den ? num / den : null, num, den);
const metric = (fn: string, name: string, unit: string, note: string, head: MetricRow | null, parts: Part[] = []): Metric => ({
  fn,
  name,
  unit,
  head: head && { ...head, note: head.note ? `${note} ${head.note}` : note },
  parts: parts
    .filter((part) => part.rows.length)
    .map((part) => ({ by: part.by, rows: part.rows.map((row) => ({ ...row, note: row.note ? `${note} ${row.note}` : note })) })),
});
const noted = (row: MetricRow, note: string): MetricRow => ({ ...row, note });
const on = (row: MetricRow, day: string): MetricRow => ({ ...row, start: day, end: day });
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const days = (from: number, to: number) => round((to - from) / DAY);
const pacificDay = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t);

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return round(sorted[low] + ((sorted[low + 1] ?? sorted[low]) - sorted[low]) * (at - low));
}
const median = (label: string, values: number[]) => cell(label, values.length ? quantile(values, 0.5) : null, undefined, values.length);
const counts = <T>(items: T[], key: (item: T) => string) => groupBy(items, key).map(([label, group]) => cell(label, group.length));

function groupBy<T>(items: T[], key: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(item);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b));
}

const BULK_PER_HOUR = 20;

function bulkWarning(stamps: number[]) {
  const hours = groupBy(stamps, (t) => String(Math.floor(t / HOUR))).filter(([, group]) => group.length >= BULK_PER_HOUR);
  const moved = hours.reduce((sum, [, group]) => sum + group.length, 0);
  return moved ? `WARNING: ${moved} were moved to Done in a bulk update (${BULK_PER_HOUR} or more in one hour), so their completion time is the bulk update time.` : '';
}

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function firstPass(pr: RawPull) {
  const human = (author: { login: string; __typename: string } | null) => !!author && author.__typename !== 'Bot' && !author.login.endsWith('[bot]');
  const signals: number[] = [];
  for (const item of pr.items) {
    if (item.__typename === 'IssueComment' && human(item.author)) signals.push(Date.parse(item.createdAt));
    if (item.__typename === 'PullRequestReview' && item.submittedAt && human(item.author)) signals.push(Date.parse(item.submittedAt));
  }
  if (!signals.length) return { ok: true, reviewed: false };
  const first = Math.min(...signals);
  return { ok: !pr.items.some((item) => item.__typename === 'PullRequestCommit' && Date.parse(item.commit.committedDate) > first), reviewed: true };
}

function engMetrics(window: Window): Metric[] {
  const F = 'internal_ops';
  const team = config.linear.engTeam;
  const org = config.github.org;
  const focus = config.github.focusAuthor;
  const { engDone, engPulled } = readDelivery();
  if (!team || !engPulled) return [];
  const authors = readAuthors();
  const by = (login: string) => (pr: { login: string; id: string }) => pr.login === login || (!!authors[login] && pr.id === authors[login]);
  const pulls = new Map<string, RawPull>(fs.existsSync(path.join(GITHUB, 'state.json')) ? readGithub().pulls.map((pr) => [`${pr.repo}#${pr.number}`.toLowerCase(), pr]) : []);
  const passes: ({ mine: boolean } & ReturnType<typeof firstPass>)[] = [];
  const seen = new Set<string>();
  const leads: { mine: boolean; lead: number }[] = [];
  for (const issue of engDone) {
    const merges: { mine: boolean; merged: number }[] = [];
    for (const attachment of issue.attachments.nodes) {
      const link = PR_URL.exec(attachment.url ?? '');
      if (!link || (org && link[1].toLowerCase() !== org.toLowerCase())) continue;
      const meta = attachment.metadata ?? {};
      const author = { login: String(meta.userLogin ?? ''), id: String(meta.userId ?? '') };
      const key = `${link[2]}#${link[3]}`.toLowerCase();
      const pr = pulls.get(key);
      const merged = Date.parse(pr?.mergedAt ?? String(meta.mergedAt ?? ''));
      if (!Number.isFinite(merged)) continue;
      const mine = !!focus && (by(focus)(author) || pr?.author?.login === focus);
      merges.push({ mine, merged });
      if (pr && !seen.has(key) && merged >= window.start && merged < window.end) passes.push({ mine, ...firstPass(pr) });
      seen.add(key);
    }
    const created = Date.parse(issue.createdAt);
    for (const mine of [false, true]) {
      const kept = merges.filter((m) => !mine || m.mine).map((m) => m.merged);
      if (kept.length) leads.push({ mine, lead: days(created, Math.max(...kept)) });
    }
  }
  const leadOf = (mine: boolean) => leads.filter((l) => l.mine === mine).map((l) => l.lead);
  const passRate = (label: string, group: typeof passes) => share(label, group.filter((p) => p.ok).length, group.length);
  const leadNote = `Latest linked PR merge time minus ticket creation time, for ${team} tickets completed in the week with a merged PR${org ? ` in ${org}` : ''}. ${leadOf(false).filter((lead) => lead < 0).length} are negative (ticket created after the merge).`;
  const spread = (label: string, values: number[], q: number) => cell(label, values.length ? quantile(values, q) : null, undefined, values.length);
  return [
    metric(F, 'eng_tickets_completed', 'count', `${team} issues moved to a completed state in the week. ${bulkWarning(engDone.map((issue) => Date.parse(issue.completedAt)))}`, cell('', engDone.length)),
    metric(F, 'ticket_to_merge_lead_time_days_median', 'days', leadNote, spread('', leadOf(false), 0.5), focus ? [{ by: 'author', rows: [spread(focus, leadOf(true), 0.5)] }] : []),
    metric(F, 'ticket_to_merge_lead_time_days_p75', 'days', leadNote, spread('', leadOf(false), 0.75), focus ? [{ by: 'author', rows: [spread(focus, leadOf(true), 0.75)] }] : []),
    metric(
      F,
      'first_pass_merge_rate',
      'ratio',
      `Proxy: PRs merged in the week, linked to ${team} tickets completed in the week, with no commit after the first comment or review from a person. ${passes.filter((p) => !p.reviewed).length} had no such comment and count as first pass.`,
      passRate('', passes),
      focus ? [{ by: 'author', rows: [passRate(focus, passes.filter((p) => p.mine))] }] : [],
    ),
  ];
}

export function computeMetrics(window: Window): Metric[] {
  return [
    ...engMetrics(window),
  ];
}
