import fs from 'node:fs';
import path from 'node:path';
import { loadWindow } from '../lib/window';
import { driveIds } from '../lib/attach';
import { driveFiles } from '../lib/drive';
import { linksOf, printReport, toSourceFile, type RawIssue, type RawUser } from './linear/convert';
import { QuotaStop, RAW, pagesIn, pull, pullDelivery, readData, requestCount } from './linear/pull';

const OUT = path.resolve('data/sources/linear.json');

function readRaw() {
  const pages = (dir: string) => pagesIn(dir).map(readData);
  const users: RawUser[] = pages(path.join(RAW, 'users')).flatMap((data) => data.users.nodes);
  const issues: RawIssue[] = [];
  for (const data of pages(path.join(RAW, 'issues'))) {
    for (const node of data.issues.nodes) {
      const history = [...node.history.nodes];
      for (const page of pages(path.join(RAW, 'history', node.id))) history.push(...page.issue.history.nodes);
      const comments = [...node.comments.nodes];
      for (const page of pages(path.join(RAW, 'comments', node.id))) comments.push(...page.issue.comments.nodes);
      issues.push({ ...node, history, comments });
    }
  }
  return { users, issues };
}

async function main() {
  const window = loadWindow();
  await pull(window);
  await pullDelivery(window);
  const raw = readRaw();
  const drive = await driveFiles(path.join(RAW, 'drive'), driveIds(linksOf(raw.issues).map(({ link }) => link)));
  const { file, report } = toSourceFile({ window, ...raw, drive });
  printReport(report);
  if (!report.ok) {
    console.error('Reconciliation failed. data/sources/linear.json was not written.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)}: ${file.events.length} events, ${file.actors.length} actors, ${file.initial.length} initial holdings.`,
  );
}

main().catch((err) => {
  if (err instanceof QuotaStop) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(
    `Stopped on error after ${requestCount()} requests this run. Saved pages are kept; rerun resumes from them.`,
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
