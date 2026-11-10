// One Hub for the whole game: open room list for quick play, and best lap boards.
import { DurableObject } from 'cloudflare:workers';
import { TRACKS, MAX_PILOTS } from '../shared/tracks.js';

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(b, (v) => CODE[v % CODE.length]).join('');
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map(); // code -> { track, count, state, pub, at }
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS laps (track TEXT, sub TEXT, name TEXT, ms INTEGER, at INTEGER, PRIMARY KEY (track, sub))');
  }

  // called by rooms
  async report(code, info) {
    if (!info || info.count <= 0) this.rooms.delete(code);
    else this.rooms.set(code, { ...info, at: Date.now() });
  }

  async bestLap(track, sub, name, ms) {
    if (!TRACKS[track] || !Number.isFinite(ms)) return;
    this.ctx.storage.sql.exec(
      'INSERT INTO laps (track, sub, name, ms, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(track, sub) DO UPDATE SET ms = excluded.ms, name = excluded.name, at = excluded.at WHERE excluded.ms < laps.ms',
      track, sub, name, Math.round(ms), Date.now());
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/quick') {
      const track = url.searchParams.get('track');
      const now = Date.now();
      let pick = null;
      for (const [code, r] of this.rooms) {
        if (now - r.at > 6 * 3600e3) { this.rooms.delete(code); continue; }
        if (r.pub && r.state === 'lobby' && r.count < MAX_PILOTS && (!pick || r.count > pick.count) && r.track === track) pick = { code, count: r.count };
      }
      return json({ code: pick ? pick.code : roomCode(), fresh: !pick });
    }
    if (url.pathname === '/leaderboard') {
      const track = url.searchParams.get('track');
      const rows = this.ctx.storage.sql.exec('SELECT name, ms, at FROM laps WHERE track = ? ORDER BY ms ASC LIMIT 20', track).toArray();
      return json({ track, rows });
    }
    return json({ error: 'not found' }, 404);
  }
}
