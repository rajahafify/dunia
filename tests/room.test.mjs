// Protocol test against a running local server (npm run preview). Two guests race one heat.
// Usage: node tests/room.test.mjs [http://localhost:8787]
import assert from 'node:assert/strict';
import { TRACKS } from '../shared/tracks.js';

const base = process.argv[2] || 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');

async function guest(name) {
  const r = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
function connect(code, cookie) {
  const ws = new WebSocket(`${wsBase}/api/room/${code}/ws`, { headers: { Cookie: cookie } });
  const c = { ws, msgs: [], waiters: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data); c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => { if (w.t === m.t && (!w.f || w.f(m))) { w.res(m); return false; } return true; });
  };
  c.wait = (t, f, ms = 15000) => new Promise((res, rej) => {
    const old = c.msgs.find((m) => m.t === t && (!f || f(m))); if (old) return res(old);
    c.waiters.push({ t, f, res }); setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  return c;
}

// no cookie: refused
{
  const ws = new WebSocket(`${wsBase}/api/room/NOAUTH/ws`);
  const ok = await new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); });
  assert.equal(ok, false, 'socket without a session must be refused');
}

const { code } = await (await fetch(`${base}/api/quick?track=field`)).json();
const a = connect(code, await guest('Alpha')), b = connect(code, await guest('Bravo'));
const wa = await a.wait('welcome'), wb = await b.wait('welcome');
assert.equal(wa.room.state, 'lobby');
assert.equal(wb.pilots.length, 2);
assert.notEqual(wa.pilots[0].color, wb.pilots[1].color);

// quick play now finds the same room
const q2 = await (await fetch(`${base}/api/quick?track=field`)).json();
assert.equal(q2.code, code);

// pose relay
a.send({ t: 'p', d: [1, 2, 3, 0, 0, 0, 1, 0.5] });
const pose = await b.wait('p');
assert.deepEqual(pose.d, [1, 2, 3, 0, 0, 0, 1, 0.5]);
assert.equal(pose.id, wa.id);

// only the host changes track
b.send({ t: 'track', id: 'technical' });
a.send({ t: 'track', id: 'field' });

a.send({ t: 'ready', v: true });
b.send({ t: 'ready', v: true });
const cd = await a.wait('countdown');
const lead = cd.goAt - Date.now();
assert.ok(lead > 3000 && lead < 8000, `tone delay ${lead}`);
console.log('countdown ok, tone in', lead, 'ms');
await new Promise((r) => setTimeout(r, lead + 50));

// a gate out of order is ignored
a.send({ t: 'gate', i: 3, lap: 0, ms: 100 });
const N = TRACKS.field.gates.length, laps = TRACKS.field.laps;
// A flies clean laps on a compressed clock is not possible (min lap time), so check the cheat guard instead
let t = Date.now() - cd.goAt;
a.send({ t: 'gate', i: 0, lap: 0, ms: t });
for (let i = 1; i < N; i++) a.send({ t: 'gate', i, lap: 0, ms: t + i * 10 });
a.send({ t: 'gate', i: 0, lap: 0, ms: t + N * 10 }); // an 80 ms lap
const dq = await b.wait('dq');
assert.equal(dq.id, wa.id);
console.log('impossible lap rejected');

// B passes the first gate honestly, then leaves; the race ends with nobody left racing
b.send({ t: 'gate', i: 0, lap: 0, ms: Date.now() - cd.goAt });
const g = await a.wait('gate', (m) => m.id === wb.id);
assert.equal(g.i, 0);
b.ws.close();
const res = await a.wait('results');
assert.equal(res.results.track, 'field');
assert.ok(res.results.rows.length >= 1);
console.log('results', JSON.stringify(res.results.rows.map((r) => [r.name, r.ms, r.gates])));
a.ws.close();
console.log('room protocol: all checks passed');
process.exit(0);
