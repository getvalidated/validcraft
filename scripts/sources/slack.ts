import fs from 'node:fs';
import path from 'node:path';
import type { Window } from '../../src/schema';
import { loadWindow } from '../lib/window';
import { driveIds } from '../lib/attach';
import { driveFiles } from '../lib/drive';
import { linksOf, printReport, toSourceFile, type RawChannel } from './slack/convert';
import { importExport, readExportChannels, readExportMessages } from './slack/export';
import { RAW, isTopLevel, pagesIn, pull, readChannels, readPage, readTeamId, requestCount, type RawMessage } from './slack/pull';

const OUT = path.resolve('data/sources/slack.json');

function readRaw(window: Window) {
  const exported = new Set(readExportChannels(window).map((c) => c.id));
  const listed = new Set(readChannels().map((c) => c.id));
  const origin = { exportOnly: 0, botsOnly: 0, both: 0 };
  const channels: RawChannel[] = [];
  for (const id of new Set([...listed, ...exported])) {
    const fromExport = exported.has(id) ? readExportMessages(id) : [];
    if (!listed.has(id) && !fromExport.length) continue;
    const pages = pagesIn(path.join(RAW, 'history', id));
    const threads = path.join(RAW, 'replies', id);
    const kept = new Map<string, RawMessage>();
    const keep = (files: string[]) => {
      for (const file of files) for (const m of readPage(file).messages as RawMessage[]) if (!kept.has(m.ts)) kept.set(m.ts, m);
    };
    keep(pages);
    if (fs.existsSync(threads)) {
      for (const ts of fs.readdirSync(threads)) if (/^\d+\.\d+$/.test(ts)) keep(pagesIn(path.join(threads, ts)));
    }
    const fromBots = kept.size;
    const known = new Set([...kept.keys(), ...fromExport.map((m) => m.ts)]);
    let shared = 0;
    for (const m of fromExport) {
      if (kept.has(m.ts)) shared++;
      else if (isTopLevel(m) || known.has(m.thread_ts!)) kept.set(m.ts, m);
    }
    origin.both += shared;
    origin.botsOnly += fromBots - shared;
    origin.exportOnly += kept.size - fromBots;
    const messages: RawMessage[] = [];
    const replies = new Map<string, RawMessage[]>();
    for (const m of kept.values()) {
      if (isTopLevel(m)) messages.push(m);
      else if (replies.has(m.thread_ts!)) replies.get(m.thread_ts!)!.push(m);
      else replies.set(m.thread_ts!, [m]);
    }
    channels.push({ id, readable: pages.length > 0 || exported.has(id), messages, replies });
  }
  return { teamId: readTeamId(), channels, origin };
}

async function main() {
  const window = loadWindow();
  await pull(window);
  if (process.env.SLACK_EXPORT) importExport(process.env.SLACK_EXPORT, window);
  const raw = readRaw(window);
  const drive = await driveFiles(path.join(RAW, 'drive'), driveIds(linksOf(raw.channels)));
  const { file, report } = toSourceFile({ window, ...raw, drive });
  printReport(report);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors, ${file.initial.length} initial holdings.`,
  );
}

main().catch((err) => {
  console.error(
    `Stopped on error after ${requestCount()} requests this run. Saved pages are kept; rerun resumes from them.`,
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
