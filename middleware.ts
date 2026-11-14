import { Auth, type AuthConfig } from '@auth/core';
import Google from '@auth/core/providers/google';

const ALLOWED = new Set((process.env.RTS_ALLOWED_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
const RECHECK_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2000;

const allowed = (email?: string | null) => Boolean(email && ALLOWED.has(email.toLowerCase()));

const WAITLIST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Validcraft</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-15 -16 30 29' stroke-width='1.4' stroke-linejoin='round' stroke='%238FA3D6' fill='%238FA3D6'%3E%3Cpath d='M12.2 11V-5' fill='none'/%3E%3Ccircle cx='12.2' cy='-7.4' r='2.2'/%3E%3Cpath d='M-6 -1.5H6L9.5 11H-9.5Z' fill='%232C3854'/%3E%3Ccircle cy='-5.5' r='3.8' fill='%232C3854'/%3E%3Cpath d='M-7.2 -7L-4.8 -8.8L1.2 -14.6L4.8 -8.8L7.2 -7Z'/%3E%3C/svg%3E" /></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e6ebf5;font:15px/1.5 system-ui,sans-serif"><main style="max-width:420px;padding:24px;text-align:center"><h1 style="margin:0 0 8px;font-size:20px">You are on the waitlist</h1><p style="margin:0;color:#9aa6c0">Your account does not have access to Validcraft yet. Your request has been recorded, and you can sign in again once you are added.</p></main></body></html>`;

const authConfig: AuthConfig = {
  basePath: '/api/auth',
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: { params: { access_type: 'offline', prompt: 'consent', ...(process.env.RTS_GOOGLE_DOMAIN ? { hd: process.env.RTS_GOOGLE_DOMAIN } : {}) } },
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      if (!profile?.email_verified || !profile.email) return false;
      if (allowed(profile.email)) return true;
      console.log(JSON.stringify({ event: 'rts_waitlist', email: profile.email.toLowerCase(), name: profile.name ?? '' }));
      return '/waitlist';
    },
    async jwt({ token, account }) {
      const now = Date.now();
      if (account) return { ...token, refreshToken: account.refresh_token, verifiedAt: now, retryAt: undefined };
      if (!token.refreshToken) return null;
      if (now - ((token.verifiedAt as number | undefined) ?? 0) < RECHECK_MS) return token;
      if (token.retryAt && now < (token.retryAt as number)) return token;
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID ?? '',
            client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
            grant_type: 'refresh_token',
            refresh_token: token.refreshToken as string,
          }),
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
        if (res.ok && body.access_token) return { ...token, refreshToken: body.refresh_token ?? token.refreshToken, verifiedAt: now, retryAt: undefined };
        if (body.error === 'invalid_grant') return null;
      } catch {}
      return { ...token, retryAt: now + RETRY_MS };
    },
  },
};

export default async function middleware(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/auth/')) return Auth(request, authConfig);
  if (url.pathname === '/waitlist') return new Response(WAITLIST_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  const res = await Auth(new Request(new URL('/api/auth/session', url), { headers: request.headers }), authConfig);
  const session = (await res.json().catch(() => null)) as { user?: { email?: string | null } } | null;
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
  if (allowed(session?.user?.email)) {
    headers.set('x-middleware-next', '1');
    return new Response(null, { headers });
  }
  if (!(request.headers.get('accept') ?? '').includes('text/html')) return new Response('Sign in to see this', { status: 401, headers });
  headers.set('Location', `/api/auth/signin?callbackUrl=${encodeURIComponent(url.pathname + url.search)}`);
  return new Response(null, { status: 307, headers });
}
