// One race room. Holds the lobby, runs the start, checks gate order and lap times,
// and relays poses between pilots.
import { DurableObject } from 'cloudflare:workers';
import { TRACKS, MAX_PILOTS } from '../shared/tracks.js';

const COLORS = ['#ff3b3b', '#2f9bff', '#ffd21f', '#35e06f', '#ff7a1a', '#c56bff', '#19e3d6', '#ff5fa8'];
const FINISH_GRACE_MS = 30000;   // time the rest of the field gets after the winner
const RACE_CAP_MS = 5 * 60000;
const RESULTS_MS = 12000;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pilots = new Map(); // ws -> pilot
    this.code = '';
    this.track = 'field';
    this.state = 'lobby';    // lobby | countdown | racing | results
    this.pub = true;
    this.host = null;
    this.goAt = 0;
    this.timers = [];
    this.nextId = 1;
    this.results = null;
  }

  async fetch(request) {
    const user = JSON.parse(decodeURIComponent(request.headers.get('X-Pilot')));
    this.code = request.headers.get('X-Room');
    const url = new URL(request.url);
    if (this.pilots.size === 0) this.pub = url.searchParams.get('private') !== '1';
    if (this.pilots.size >= MAX_PILOTS) return new Response('room full', { status: 409 });

    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();

    // one seat per account: a second tab takes over the first
    for (const [ows, op] of this.pilots) if (op.sub === user.sub) { try { ows.close(4000, 'joined from another tab'); } catch (e) {} this.drop(ows); }

    const used = new Set([...this.pilots.values()].map((p) => p.color));
    const pilot = {
      id: this.nextId++, sub: user.sub, name: user.name, pic: user.pic, guest: user.guest,
      color: COLORS.find((c) => !used.has(c)) || COLORS[0],
      ready: false, racing: false, slot: 0,
      next: 0, lap: 0, lastMs: 0, lapStart: 0, laps: [], finishMs: null, gates: 0, msgs: 0, msgWindow: Date.now(),
    };
    this.pilots.set(ws, pilot);
    if (!this.host || ![...this.pilots.values()].some((p) => p.id === this.host)) this.host = pilot.id;

    ws.addEventListener('message', (ev) => { try { this.onMessage(ws, pilot, ev.data); } catch (e) { /* bad message */ } });
    const bye = () => this.drop(ws);
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);

    this.send(ws, { t: 'welcome', id: pilot.id, now: Date.now(), room: this.roomInfo(), pilots: [...this.pilots.values()].map(pub), results: this.results });
    this.broadcast({ t: 'join', pilot: pub(pilot) }, ws);
    this.report();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  roomInfo() {
    return { code: this.code, track: this.track, state: this.state, host: this.host, pub: this.pub, goAt: this.goAt, laps: TRACKS[this.track].laps };
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) { /* closed */ } }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.pilots.keys()) if (ws !== except) { try { ws.send(s); } catch (e) { /* closed */ } }
  }

  report() {
    const hub = this.env.HUB.get(this.env.HUB.idFromName('hub'));
    this.ctx.waitUntil(hub.report(this.code, { track: this.track, count: this.pilots.size, state: this.state, pub: this.pub }).catch(() => {}));
  }

  drop(ws) {
    const p = this.pilots.get(ws);
    if (!p) return;
    this.pilots.delete(ws);
    this.broadcast({ t: 'leave', id: p.id });
    if (this.host === p.id) {
      const first = this.pilots.values().next().value;
      this.host = first ? first.id : null;
      this.broadcast({ t: 'room', room: this.roomInfo() });
    }
    if (this.pilots.size === 0) this.toLobby();
    else if (this.state === 'racing') this.checkRaceOver();
    else if (this.state === 'lobby') this.maybeStart();
    this.report();
  }

  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }

  toLobby() {
    this.clearTimers();
    this.state = 'lobby';
    for (const p of this.pilots.values()) { p.ready = false; p.racing = false; }
    this.broadcast({ t: 'room', room: this.roomInfo() });
    this.broadcast({ t: 'pilots', pilots: [...this.pilots.values()].map(pub) });
    this.report();
  }

  maybeStart(force) {
    if (this.state !== 'lobby' || this.pilots.size === 0) return;
    const all = [...this.pilots.values()];
    if (!force && !all.every((p) => p.ready)) return;
    this.clearTimers();
    this.state = 'countdown';
    this.results = null;
    // "Arm your quads. Going live on the tone in less than five."
    this.goAt = Date.now() + 4000 + Math.floor(Math.random() * 3500);
    all.forEach((p, i) => {
      Object.assign(p, { slot: i, racing: true, next: 0, lap: 0, lastMs: 0, lapStart: 0, laps: [], finishMs: null, gates: 0 });
    });
    this.broadcast({ t: 'countdown', goAt: this.goAt, room: this.roomInfo(), slots: all.map((p) => [p.id, p.slot]) });
    this.later(this.goAt - Date.now(), () => { this.state = 'racing'; this.report(); });
    this.later(this.goAt - Date.now() + RACE_CAP_MS, () => this.endRace());
    this.report();
  }

  onMessage(ws, p, raw) {
    if (typeof raw !== 'string' || raw.length > 600) return;
    // flood guard: 80 messages a second is far above normal play
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 80) return;
    const m = JSON.parse(raw);
    switch (m.t) {
      case 'p': {
        const d = m.d;
        if (!Array.isArray(d) || d.length !== 8 || !d.every(Number.isFinite)) return;
        this.broadcast({ t: 'p', id: p.id, d }, ws);
        break;
      }
      case 'ping': this.send(ws, { t: 'pong', c: m.c, s: Date.now() }); break;
      case 'ready':
        if (this.state !== 'lobby') return;
        p.ready = !!m.v;
        this.broadcast({ t: 'pilot', pilot: pub(p) });
        this.maybeStart();
        break;
      case 'track':
        if (this.state !== 'lobby' || p.id !== this.host || !TRACKS[m.id]) return;
        this.track = m.id;
        this.broadcast({ t: 'room', room: this.roomInfo() });
        this.report();
        break;
      case 'start':
        if (p.id === this.host) this.maybeStart(true);
        break;
      case 'gate': this.onGate(p, m); break;
      case 'crash': this.broadcast({ t: 'crash', id: p.id }, ws); break;
    }
  }

  onGate(p, m) {
    if ((this.state !== 'racing' && this.state !== 'countdown') || !p.racing || p.finishMs !== null) return;
    const track = TRACKS[this.track];
    const N = track.gates.length;
    const ms = Number(m.ms), elapsed = Date.now() - this.goAt;
    // gates in order, clock moving forward, and close to the server's own clock
    if (m.i !== p.next || !Number.isFinite(ms) || ms <= p.lastMs || ms < 0) return;
    if (ms > elapsed + 1500 || ms < elapsed - 8000) return;
    p.lastMs = ms; p.gates++;
    p.next = (p.next + 1) % N;
    let lapMs = null;
    if (m.i === 0 && p.gates > 1) {
      lapMs = ms - p.lapStart;
      if (lapMs < track.minLapMs) { p.racing = false; this.broadcast({ t: 'dq', id: p.id }); this.checkRaceOver(); return; }
      p.laps.push(lapMs); p.lap++; p.lapStart = ms;
      if (!p.guest) {
        const hub = this.env.HUB.get(this.env.HUB.idFromName('hub'));
        this.ctx.waitUntil(hub.bestLap(this.track, p.sub, p.name, lapMs).catch(() => {}));
      }
    } else if (m.i === 0) {
      p.lapStart = 0; // lap one runs from the tone
    }
    this.broadcast({ t: 'gate', id: p.id, i: m.i, lap: p.lap, ms, lapMs });
    if (p.lap >= track.laps) {
      p.finishMs = ms;
      const first = ![...this.pilots.values()].some((o) => o !== p && o.finishMs !== null);
      this.broadcast({ t: 'finish', id: p.id, ms });
      if (first) this.later(FINISH_GRACE_MS, () => this.endRace());
      this.checkRaceOver();
    }
  }

  checkRaceOver() {
    if (this.state !== 'racing' && this.state !== 'countdown') return;
    const racing = [...this.pilots.values()].filter((p) => p.racing);
    if (racing.length === 0 || racing.every((p) => p.finishMs !== null)) this.endRace();
  }

  endRace() {
    if (this.state === 'results' || this.state === 'lobby') return;
    this.clearTimers();
    this.state = 'results';
    const rows = [...this.pilots.values()].filter((p) => p.gates > 0 || p.racing).map((p) => ({
      id: p.id, name: p.name, color: p.color, ms: p.finishMs, laps: p.laps, lap: p.lap, gates: p.gates,
      best: p.laps.length ? Math.min(...p.laps) : null,
    }));
    rows.sort((a, b) => (a.ms === null) - (b.ms === null) || (a.ms ?? 0) - (b.ms ?? 0) || b.gates - a.gates);
    this.results = { track: this.track, rows };
    this.broadcast({ t: 'results', results: this.results, room: this.roomInfo() });
    this.later(RESULTS_MS, () => this.toLobby());
    this.report();
  }
}

function pub(p) {
  return { id: p.id, name: p.name, pic: p.pic, color: p.color, ready: p.ready, guest: p.guest, slot: p.slot, racing: p.racing };
}
