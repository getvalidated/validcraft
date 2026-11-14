import fs from 'node:fs';
import path from 'node:path';
import {
  INTERNAL_REGION,
  SCHEMA_VERSION,
  type ActorRef,
  type Building,
  type Feature,
  type SourceEvent,
  type SourceFile,
  type SourceSession,
  type Window,
} from '../../src/schema';
import { describeWindow, loadWindow } from '../lib/window';
import { collectChat } from './sessions/chat';
import { collectCowork } from './sessions/cowork';
import { collectLocal } from './sessions/local';
import { Skip, emailActor, type Collected, type SkillUse } from './sessions/shared';

const OUT = path.resolve('data/sources/sessions.json');
const MINUTE = 60_000;
const SKILLS: Building = { id: 'skills', region: INTERNAL_REGION, name: 'Skills', resource: null };
const HIDDEN: Record<string, string> = { 'third-party': 'Plugin skill, name hidden', custom_skill: 'Unnamed skill' };

const COLLECTORS: { name: string; run: (window: Window) => Promise<Collected> }[] = [
  { name: 'local', run: collectLocal },
  { name: 'cowork', run: collectCowork },
  { name: 'chat', run: collectChat },
];

const rawId = (id: string) => id.slice(id.indexOf(':') + 1);

const short = (skill: string) => skill.slice(skill.lastIndexOf(':') + 1);

async function main() {
  const window = loadWindow();
  console.log(`Window ${describeWindow(window)}`);

  const sessions: SourceSession[] = [];
  const actors = new Map<string, ActorRef>();
  const seen = new Set<string>();
  const lines: string[] = [];
  const uses: SkillUse[] = [];

  for (const { name, run } of COLLECTORS) {
    let collected: Collected;
    try {
      collected = await run(window);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const line = `${name.padEnd(10)} skipped: ${err instanceof Skip ? reason : `stopped on an error (${reason})`}`;
      console.log(line);
      lines.push(line);
      continue;
    }
    const kept = collected.sessions.filter((s) => !seen.has(rawId(s.id)));
    for (const s of kept) seen.add(rawId(s.id));
    const owners = new Set(kept.map((s) => s.owner));
    for (const actor of collected.actors) if (owners.has(actor.key) && !actors.has(actor.key)) actors.set(actor.key, actor);
    sessions.push(...kept);
    uses.push(...(collected.uses ?? []));
    if (collected.uses?.length) {
      lines.push(`${name.padEnd(10)} skill uses ${collected.uses.length} · people ${new Set(collected.uses.map((u) => u.email)).size}`);
    }
    const withTokens = kept.filter((s) => s.tokens !== null);
    const tokens = withTokens.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    const dropped = collected.sessions.length - kept.length;
    lines.push(
      `${name.padEnd(10)} sessions ${kept.length} · owners ${owners.size} · tokens ${kept.length && !withTokens.length ? 'not available' : tokens.toLocaleString('en-US')}` +
        (dropped ? ` · ${dropped} already seen in an earlier collector` : ''),
    );
  }

  sessions.sort((a, b) => a.start - b.start);
  const ids = new Set(sessions.map((s) => s.id));
  const grouped = new Map<string, SourceEvent>();
  const counts = new Map<string, number>();
  for (const use of uses) {
    const skill = short(use.skill);
    const actor = emailActor(use.email);
    if (!actors.has(actor.key)) actors.set(actor.key, actor);
    const feature = `${SKILLS.id}/${skill}`;
    counts.set(skill, (counts.get(skill) ?? 0) + 1);
    const t = Math.floor(use.t / MINUTE) * MINUTE;
    const key = `${actor.key}|${use.session}|${feature}|${t}`;
    const event = grouped.get(key);
    if (event) event.count++;
    else
      grouped.set(key, {
        kind: 'use',
        t,
        actor: actor.key,
        via: ids.has(use.session) ? use.session : null,
        resource: null,
        resourceId: null,
        building: SKILLS.id,
        from: null,
        to: null,
        isReturn: false,
        count: 1,
        clientHint: null,
        feature,
      });
  }
  const features: Feature[] = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([skill]) => ({ id: `${SKILLS.id}/${skill}`, building: SKILLS.id, name: HIDDEN[skill] ?? skill }));
  const file: SourceFile = {
    schemaVersion: SCHEMA_VERSION,
    source: 'sessions',
    window,
    actors: [...actors.values()].sort((a, b) => a.key.localeCompare(b.key)),
    buildings: [{ id: 'claude', region: INTERNAL_REGION, name: 'Claude', resource: null }, ...(uses.length ? [SKILLS] : [])],
    features,
    events: [...grouped.values()].sort((a, b) => a.t - b.t),
    initial: [],
    sessions,
    measures: [],
    artifacts: [],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));

  console.log('Sessions source');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${sessions.length} sessions, ${file.events.length} skill events across ${features.length} skills, ${file.actors.length} actors.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
