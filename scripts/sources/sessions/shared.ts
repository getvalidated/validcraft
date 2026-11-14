import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ActorRef, SessionTool, SourceSession, Window } from '../../../src/schema';
import { secret } from '../../lib/config';

export const RAW = path.resolve('data/raw/sessions');
export const GAP = 10 * 60_000;

export class Skip extends Error {}

export function secretOrSkip(name: string) {
  try {
    return secret(name);
  } catch (err) {
    throw new Skip(err instanceof Error ? err.message : String(err));
  }
}

export interface SkillUse {
  t: number;
  email: string;
  session: string;
  skill: string;
}

export interface Collected {
  sessions: SourceSession[];
  actors: ActorRef[];
  uses?: SkillUse[];
}

export interface State {
  start: number;
  end: number;
  complete: boolean;
  [key: string]: unknown;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const iso = (t: number) => new Date(t).toISOString();

export const parseTime = (value: unknown) =>
  typeof value === 'string' ? Date.parse(value.replace(/(\.\d{3})\d+/, '$1')) : NaN;

export function openState(dir: string, window: Window): State {
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) return { start: window.start, end: window.end, complete: false };
  const state: State = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.start !== window.start || state.end !== window.end) {
    const rel = path.relative(process.cwd(), dir);
    throw new Skip(`${rel} was pulled for a different window than data/window.json; remove ${rel} to pull this window`);
  }
  return state;
}

export function saveState(dir: string, state: State) {
  writeJson(path.join(dir, 'state.json'), state);
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export const readPage = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));

export function savePage(dir: string, n: number, value: unknown) {
  writeJson(path.join(dir, `${String(n).padStart(5, '0')}.json`), value);
}

export function gcloud(args: string[]) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function failure(err: unknown) {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function clampTimes(times: number[], before: number | null, after: number | null, window: Window) {
  const sorted = [...times].sort((a, b) => a - b);
  if (!sorted.length) return sorted;
  if (before !== null && sorted[0] - before <= GAP) sorted.unshift(window.start);
  if (after !== null && after - sorted[sorted.length - 1] <= GAP) sorted.push(window.end);
  return sorted;
}

export function toSession(
  id: string,
  owner: string,
  tool: SessionTool,
  times: number[],
  tokens: number | null,
  parent: string | null = null,
): SourceSession {
  const active: [number, number][] = [];
  for (const t of times) {
    const last = active[active.length - 1];
    if (last && t - last[1] <= GAP) last[1] = t;
    else active.push([t, t]);
  }
  return { id, owner, tool, start: times[0], end: times[times.length - 1], parent, tokens, active };
}

export const emailActor = (email: string): ActorRef => ({
  key: `sessions:email:${email}`,
  email,
  name: null,
  kind: 'person',
  groupHint: null,
  clientHint: null,
});
