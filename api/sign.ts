import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SIGNED_SECONDS = 3600;

function signedUrl(bucket: string, object: string, method = 'GET') {
  const { client_email, private_key } = JSON.parse(process.env.GCS_SIGNER_KEY ?? '{}') as { client_email?: string; private_key?: string };
  if (!client_email || !private_key) throw new Error('no signing key set');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
  const pathName = `/${bucket}/${object.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
  const params: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${client_email}/${scope}`,
    'X-Goog-Date': stamp,
    'X-Goog-Expires': String(SIGNED_SECONDS),
    'X-Goog-SignedHeaders': 'host',
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const canonical = [method, pathName, query, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', stamp, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  return `https://storage.googleapis.com${pathName}?${query}&X-Goog-Signature=${crypto.createSign('RSA-SHA256').update(toSign).sign(private_key, 'hex')}`;
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = req.url ?? '';
    const kind = /[?&]kind=([^&]*)/.exec(url)?.[1];
    const object = decodeURIComponent(/[?&]object=([^&]*)/.exec(url)?.[1] ?? '').replace(/^\/+/, '');
    if (!object || object.includes('..')) throw new Error('no object named');
    const rts = (process.env.RTS_BUCKET ?? '').replace(/^gs:\/\//, '');
    const [bucket, prefix] = kind === 'rts' ? [rts, 'parquet/'] : kind === 'library' ? [rts, 'library/'] : kind === 'gear' ? [rts, 'gear/'] : ['', ''];
    if (!bucket) throw new Error('no bucket for this file');
    res.statusCode = 302;
    res.setHeader('Location', signedUrl(bucket, `${prefix}${object}`));
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Could not sign a link for this file');
  }
}
