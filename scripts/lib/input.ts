import fs from 'node:fs';
import path from 'node:path';

export function inputId(file: string) {
  const stat = fs.statSync(file);
  return `${path.basename(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}
