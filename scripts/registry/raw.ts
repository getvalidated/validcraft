import fs from 'node:fs';
import path from 'node:path';

export const RAW = path.resolve('data/raw/registry');

let requests = 0;

export const requestCount = () => requests;

export async function request(label: string, url: string, init: RequestInit): Promise<any> {
  for (;;) {
    const res = await fetch(url, init);
    requests++;
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      if (!Number.isFinite(wait) || wait <= 0) throw new Error(`${label}: HTTP 429 without a Retry-After`);
      console.log(`${label}: rate limited, waiting ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

export function pagesIn(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export async function pageThrough<T>(dir: string, label: string, fetchPage: (cursor: string | null) => Promise<Page<T>>) {
  const saved = pagesIn(dir);
  let count = saved.length;
  let last: Page<T> | null = count ? readJson(saved[count - 1]) : null;
  while (!last || last.next) {
    const page = await fetchPage(last?.next ?? null);
    count++;
    writeJson(path.join(dir, `${String(count).padStart(5, '0')}.json`), page);
    last = page;
    console.log(`${label} page ${count}: ${page.items.length} rows`);
  }
}

export const readPages = <T>(dir: string): T[] => pagesIn(dir).flatMap((file) => (readJson(file) as Page<T>).items);
