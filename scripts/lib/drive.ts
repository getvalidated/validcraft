import fs from 'node:fs';
import path from 'node:path';
import { serviceToken } from './google';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FIELDS = 'name,mimeType,createdTime,owners(emailAddress),lastModifyingUser(emailAddress)';
const PAGE = 50;

export interface DriveFile {
  id: string;
  name: string;
  mime: string;
  created: number | null;
  email: string | null;
}

let requests = 0;

export const driveRequests = () => requests;

export async function driveFiles(dir: string, ids: string[]) {
  const known = new Map<string, DriveFile>();
  const pages = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort() : [];
  for (const page of pages) for (const file of JSON.parse(fs.readFileSync(path.join(dir, page), 'utf8')) as DriveFile[]) known.set(file.id, file);
  const todo = [...new Set(ids)].filter((id) => !known.has(id)).sort();
  if (!todo.length) return known;
  const token = await serviceToken(SCOPE);
  for (let i = 0; i < todo.length; i += PAGE) {
    const files: DriveFile[] = [];
    for (const id of todo.slice(i, i + PAGE)) {
      requests++;
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404 || res.status === 403) {
        files.push({ id, name: '', mime: '', created: null, email: null });
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Google Drive file ${id}: HTTP ${res.status}: ${JSON.stringify(body.error?.message ?? body).slice(0, 300)}`);
      const email = body.owners?.[0]?.emailAddress ?? body.lastModifyingUser?.emailAddress;
      const created = Date.parse(body.createdTime ?? '');
      files.push({ id, name: String(body.name ?? ''), mime: String(body.mimeType ?? ''), created: Number.isFinite(created) ? created : null, email: typeof email === 'string' ? email.toLowerCase() : null });
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(pages.length + i / PAGE + 1).padStart(5, '0')}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(files));
    fs.renameSync(`${file}.tmp`, file);
    for (const found of files) known.set(found.id, found);
    console.log(`drive files ${Math.min(i + PAGE, todo.length)}/${todo.length}`);
  }
  return known;
}
