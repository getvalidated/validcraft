import fs from 'node:fs';
import path from 'node:path';
import { buildTraces, type Ledger } from './lineage';

const SUFFIX = '.links.json';

export function readLedgers(library: string): Ledger[] {
  if (!fs.existsSync(library)) return [];
  return fs
    .readdirSync(library)
    .filter((f) => f.endsWith(SUFFIX))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(library, f), 'utf8')) as Ledger);
}

export function writeTraces(library: string, ledger: Ledger) {
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, `${ledger.id}${SUFFIX}`), JSON.stringify(ledger));
  const ledgers = readLedgers(library);
  const { traces } = buildTraces(ledgers);
  fs.writeFileSync(path.join(library, 'traces.json'), JSON.stringify(traces));
  return { traces, weeks: ledgers.length };
}
