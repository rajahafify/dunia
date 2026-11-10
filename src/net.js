// Talks to the server: session, quick play, and the room socket.
export const api = {
  async get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
};

export class RoomSocket {
  constructor(code, { priv = false } = {}) {
    this.code = code;
    this.handlers = {};
    this.offset = 0;      // server clock minus local clock, ms
    this.rtt = 0;
    this.bestRtt = Infinity;
    this.open = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/api/room/${code}/ws${priv ? '?private=1' : ''}`);
    this.ws.onopen = () => { this.open = true; this.sync(); this.syncTimer = setInterval(() => this.sync(), 4000); };
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'pong') {
        const now = Date.now(), rtt = now - m.c;
        this.rtt = rtt;
        if (rtt <= this.bestRtt + 5) { this.bestRtt = Math.min(rtt, this.bestRtt); this.offset = m.s + rtt / 2 - now; }
        return;
      }
      const h = this.handlers[m.t];
      if (h) h(m);
    };
    this.ws.onclose = (ev) => { this.open = false; clearInterval(this.syncTimer); if (this.handlers.close) this.handlers.close(ev); };
  }
  on(type, fn) { this.handlers[type] = fn; return this; }
  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sync() { this.send({ t: 'ping', c: Date.now() }); }
  serverNow() { return Date.now() + this.offset; }
  close() { this.handlers = {}; clearInterval(this.syncTimer); try { this.ws.close(); } catch (e) { /* already closed */ } }
}
