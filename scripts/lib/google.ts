import crypto from 'node:crypto';
import { secret } from './config';

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export async function serviceToken(scope: string, sub?: string) {
  const key: { client_email: string; private_key: string; token_uri: string } = JSON.parse(secret('GOOGLE_SERVICE_ACCOUNT_KEY'));
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ iss: key.client_email, ...(sub ? { sub } : {}), scope, aud: key.token_uri, iat: now, exp: now + 600 }));
  const signature = b64(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google token failed (${body.error ?? res.status}: ${String(body.error_description ?? '').slice(0, 120)})`);
  return body.access_token as string;
}
