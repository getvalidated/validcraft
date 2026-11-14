import fs from 'node:fs';
import path from 'node:path';
import { loadWindow } from '../lib/window';
import { printReport, toSourceFile } from './notion/convert';
import { pull, readRaw, requestCount } from './notion/pull';

const OUT = path.resolve('data/sources/notion.json');

async function main() {
  const window = loadWindow();
  await pull(window);
  const { file, report } = toSourceFile({ window, ...readRaw() });
  printReport(report);
  if (!report.ok) {
    console.error('Reconciliation failed. data/sources/notion.json was not written.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors, ${file.initial.length} initial holdings. ${requestCount()} API requests this run.`,
  );
}

main().catch((err) => {
  console.error(
    `Stopped on error after ${requestCount()} requests this run. Saved pages are kept; rerun resumes from them.`,
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
