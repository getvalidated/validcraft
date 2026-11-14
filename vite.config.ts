import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { BUCKET, PARQUET_PREFIX } from './scripts/lib/bucket';
import { config } from './scripts/lib/config';

const CLIENT_LOG = path.resolve('data/raw/client-log.jsonl');
const CLIENT_LOG_MAX = 64 * 1024;

const clientLog = (): Plugin => ({
  name: 'client-log',
  configureServer(server) {
    server.middlewares.use('/__log', (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        if (body.length < CLIENT_LOG_MAX) body += chunk;
      });
      req.on('end', () => {
        const stamp = new Date().toISOString();
        const lines = body
          .slice(0, CLIENT_LOG_MAX)
          .split('\n')
          .filter(Boolean)
          .map((line) => `${stamp} ${line}\n`);
        fs.mkdirSync(path.dirname(CLIENT_LOG), { recursive: true });
        fs.appendFileSync(CLIENT_LOG, lines.join(''));
        res.statusCode = 204;
        res.end();
      });
    });
  },
});

const SIGNED_SECONDS = 3600;
let signer: { client_email: string; private_key: string } | null = null;

function signedUrl(bucket: string, object: string) {
  if (!signer) {
    if (!process.env.GCS_SIGNER_KEY) throw new Error('GCS_SIGNER_KEY is not set');
    signer = JSON.parse(process.env.GCS_SIGNER_KEY);
  }
  const { client_email, private_key } = signer!;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
  const pathName = `/${bucket}/${object.split('/').map(encodeURIComponent).join('/')}`;
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
  const canonical = ['GET', pathName, query, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', stamp, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  return `https://storage.googleapis.com${pathName}?${query}&X-Goog-Signature=${crypto.createSign('RSA-SHA256').update(toSign).sign(private_key, 'hex')}`;
}

const signedLinks = (name: string, route: string, bucket: string, prefix = ''): Plugin => ({
  name,
  configureServer(server) {
    server.middlewares.use(route, (req, res) => {
      try {
        const object = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\/+/, ''));
        if (!object || object.includes('..')) throw new Error('no object named');
        res.statusCode = 302;
        res.setHeader('Location', signedUrl(bucket, `${prefix}${object}`));
        res.setHeader('Cache-Control', 'no-store');
        res.end();
      } catch {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Could not sign a link for this file');
      }
    });
  },
});

export default defineConfig({
  plugins: [clientLog(), ...(BUCKET ? [signedLinks('rts-files', '/__rts', BUCKET.replace(/^gs:\/\//, ''), `${PARQUET_PREFIX}/`)] : [])],
  define: {
    __RTS__: JSON.stringify({ linear: config.linear.workspace, github: config.github.org, slack: config.slack.workspace, lead: config.org.lead }),
  },
  server: {
    watch: { ignored: ['**/data/raw/**', '**/data/archive/**'] },
  },
});
