// Worker entry: auth and matchmaking routes. Race rooms live in Durable Objects.
import { verifyGoogle, makeSession, readSession, sessionCookie, cleanName } from './auth.js';
import { TRACKS } from '../shared/tracks.js';
export { Room } from './room.js';
export { Hub } from './hub.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser client
  const host = request.headers.get('X-Forwarded-Host') || new URL(request.url).host;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

const hub = (env) => env.HUB.get(env.HUB.idFromName('hub'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (request.method === 'POST' && !sameOrigin(request)) return json({ error: 'bad origin' }, 403);
      const allowGuests = env.ALLOW_GUESTS !== 'false';

      if (p === '/api/config') {
        return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', allowGuests, user: await readSession(request, env) });
      }

      if (p === '/api/auth/google' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        let user;
        try { user = await verifyGoogle(String(body.credential || ''), env); }
        catch (e) { return json({ error: 'Google sign-in failed' }, 401); }
        const token = await makeSession(user, env);
        return json({ user }, 200, { 'Set-Cookie': sessionCookie(token, request, 30 * 86400) });
      }

      if (p === '/api/auth/guest' && request.method === 'POST') {
        if (!allowGuests) return json({ error: 'Sign in with Google to fly' }, 403);
        const body = await request.json().catch(() => ({}));
        const user = { sub: `guest:${crypto.randomUUID()}`, name: cleanName(body.name, 'Guest'), pic: '', guest: true };
        const token = await makeSession(user, env);
        return json({ user }, 200, { 'Set-Cookie': sessionCookie(token, request, 2 * 86400) });
      }

      if (p === '/api/auth/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) });
      }

      if (p === '/api/leaderboard') {
        return hub(env).fetch(new Request(`https://hub/leaderboard?track=${encodeURIComponent(url.searchParams.get('track') || '')}`));
      }

      if (p === '/api/quick') {
        const track = TRACKS[url.searchParams.get('track')] ? url.searchParams.get('track') : 'field';
        return hub(env).fetch(new Request(`https://hub/quick?track=${track}`));
      }

      const m = p.match(/^\/api\/room\/([A-Z0-9]{4,8})\/ws$/);
      if (m) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
        if (!sameOrigin(request)) return json({ error: 'bad origin' }, 403);
        const user = await readSession(request, env);
        if (!user) return json({ error: 'sign in first' }, 401);
        if (user.guest && !allowGuests) return json({ error: 'Sign in with Google to fly' }, 403);
        const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
        const headers = new Headers(request.headers);
        headers.set('X-Pilot', encodeURIComponent(JSON.stringify(user)));
        headers.set('X-Room', m[1]);
        return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'server error' }, 500);
    }
  },
};
