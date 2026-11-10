// Google sign-in check and our own session cookie.
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';

const COOKIE = 'rl_session';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const jwksCache = new Map();

function secretKey(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(env.SESSION_SECRET);
}

export function cleanName(s, fallback = 'Pilot') {
  const t = String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 18);
  return t || fallback;
}

// Checks a Google ID token: signature against Google's keys, issuer, audience and expiry.
export async function verifyGoogle(credential, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured');
  const url = env.GOOGLE_JWKS_URL || GOOGLE_JWKS; // override is for tests only
  if (!jwksCache.has(url)) jwksCache.set(url, createRemoteJWKSet(new URL(url)));
  const { payload } = await jwtVerify(credential, jwksCache.get(url), {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID,
  });
  if (!payload.sub) throw new Error('token has no subject');
  return {
    sub: `google:${payload.sub}`,
    name: cleanName(payload.given_name || payload.name, 'Pilot'),
    pic: typeof payload.picture === 'string' ? payload.picture : '',
    guest: false,
  };
}

export async function makeSession(user, env) {
  return new SignJWT({ name: user.name, pic: user.pic || '', guest: !!user.guest })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(user.guest ? '2d' : '30d')
    .sign(secretKey(env));
}

export async function readSession(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], secretKey(env), { algorithms: ['HS256'] });
    return { sub: payload.sub, name: payload.name, pic: payload.pic || '', guest: !!payload.guest };
  } catch (e) {
    return null;
  }
}

export function sessionCookie(token, request, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}
