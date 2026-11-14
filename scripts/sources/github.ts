import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config';
import { loadWindow } from '../lib/window';
import { printReport, toSourceFile } from './github/convert';
import { QuotaStop, pull, pullAuthors, readRaw, requestCount } from './github/pull';

const OUT = path.resolve('data/sources/github.json');

function main() {
  const window = loadWindow();
  pull(window);
  pullAuthors(config.github.focusAuthor ? [config.github.focusAuthor] : []);
  const { file, report } = toSourceFile({ window, ...readRaw() });
  printReport(report);
  if (!report.ok) {
    console.error('Reconciliation failed. data/sources/github.json was not written.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors, ${file.initial.length} initial holdings. ${requestCount()} API requests this run.`,
  );
}

try {
  main();
} catch (err) {
  if (err instanceof QuotaStop) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(`Stopped on error after ${requestCount()} requests this run. Saved pages are kept; rerun resumes from them.`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
