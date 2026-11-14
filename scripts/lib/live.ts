import fs from 'node:fs';
import path from 'node:path';
import type { Ledger } from './lineage';

const ADS = path.resolve('data/raw/outputs/ads');
const LIVE = new Set(['ACTIVE', 'WITH_ISSUES']);

interface AdEntity {
  id: string;
  channel: string;
  type: string;
  history: [string, number][];
}

export function liveSpans(ledgers: Ledger[]): Record<string, number[]> {
  const wanted = new Set<string>();
  for (const ledger of ledgers) for (const link of ledger.links) if (link.child.startsWith('ad:')) wanted.add(link.child);
  const out: Record<string, number[]> = {};
  if (!wanted.size || !fs.existsSync(ADS)) return out;
  for (const file of fs.readdirSync(ADS).filter((f) => /^\d+\.json$/.test(f)).sort()) {
    for (const entity of JSON.parse(fs.readFileSync(path.join(ADS, file), 'utf8')) as AdEntity[]) {
      const key = `ad:${entity.channel}:${entity.id}`;
      if (entity.type !== 'ad' || !wanted.has(key)) continue;
      const flips: number[] = [];
      for (const [state, t] of [...entity.history].sort((a, b) => a[1] - b[1])) if (LIVE.has(state) !== (flips.length % 2 === 1)) flips.push(t);
      out[key] = flips;
    }
  }
  return out;
}
