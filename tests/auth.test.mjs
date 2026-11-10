// Checks the Google token verification against a throwaway key set served locally.
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyGoogle, makeSession, readSession, cleanName } from '../worker/auth.js';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const srv = http.createServer((q, s) => { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => srv.listen(0, r));
const env = { GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_JWKS_URL: `http://127.0.0.1:${srv.address().port}/certs`, SESSION_SECRET: 'test-secret' };

const token = (over = {}, key = privateKey) => new SignJWT({ name: 'Ada Lovelace', given_name: 'Ada', picture: 'https://example.com/a.png', ...over.claims })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('1234567890')
  .setIssuer(over.iss || 'https://accounts.google.com').setAudience(over.aud || env.GOOGLE_CLIENT_ID)
  .setIssuedAt().setExpirationTime(over.exp || '5m').sign(key);

const u = await verifyGoogle(await token(), env);
assert.deepEqual(u, { sub: 'google:1234567890', name: 'Ada', pic: 'https://example.com/a.png', guest: false });
await assert.rejects(verifyGoogle(await token({ aud: 'someone-else' }), env), 'wrong audience');
await assert.rejects(verifyGoogle(await token({ iss: 'https://evil.example' }), env), 'wrong issuer');
await assert.rejects(verifyGoogle(await token({ exp: Math.floor(Date.now() / 1000) - 60 }), env), 'expired');
await assert.rejects(verifyGoogle(await token({}, other.privateKey), env), 'wrong key');
await assert.rejects(verifyGoogle('not-a-token', env), 'garbage');
await assert.rejects(verifyGoogle(await token(), { ...env, GOOGLE_CLIENT_ID: '' }), 'not configured');

const cookie = await makeSession(u, env);
const req = (c) => new Request('https://x.test/', { headers: { Cookie: `a=b; rl_session=${c}` } });
assert.equal((await readSession(req(cookie), env)).sub, 'google:1234567890');
assert.equal(await readSession(req(cookie.slice(0, -3) + 'abc'), env), null, 'tampered cookie');
assert.equal(await readSession(req(cookie), { SESSION_SECRET: 'different' }), null, 'wrong secret');
assert.equal(cleanName('<script>Bob</script>'), 'scriptBobscript');
assert.equal(cleanName(''), 'Pilot');
srv.close();
console.log('auth: all checks passed');
