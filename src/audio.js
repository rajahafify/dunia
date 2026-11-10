// Motor sound and race tones, synthesised with WebAudio. No audio files.
export class Sound {
  constructor() { this.ctx = null; this.vol = 0.6; this.remotes = new Map(); }

  // Browsers only allow audio after a click or key press.
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.vol; this.master.connect(ctx.destination);
    this.own = this.voice(1);
  }

  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }

  voice(level) {
    const ctx = this.ctx;
    const out = ctx.createGain(); out.gain.value = 0;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1800; filter.Q.value = 0.8;
    const oscs = [0, 7, -9, 13].map((cents, i) => {
      const o = ctx.createOscillator(); o.type = i % 2 ? 'square' : 'sawtooth'; o.detune.value = cents;
      const g = ctx.createGain(); g.gain.value = i % 2 ? 0.1 : 0.2;
      o.connect(g); g.connect(filter); o.start();
      return o;
    });
    filter.connect(out); out.connect(this.master);
    return { out, filter, oscs, level };
  }

  drive(v, motor, gainScale = 1) {
    const t = this.ctx.currentTime;
    const f = 95 + Math.pow(motor, 0.8) * 520;
    v.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * (i >= 2 ? 2.01 : 1), t, 0.03));
    v.filter.frequency.setTargetAtTime(700 + motor * 3800, t, 0.05);
    v.out.gain.setTargetAtTime((motor > 0.005 ? 0.05 + motor * 0.22 : 0) * v.level * gainScale, t, 0.04);
  }

  motor(m) { if (this.ctx) this.drive(this.own, m); }

  // other pilots: quieter with distance
  remote(id, motor, dist) {
    if (!this.ctx) return;
    let v = this.remotes.get(id);
    if (!v) { v = this.voice(0.8); this.remotes.set(id, v); }
    this.drive(v, motor, 1 / (1 + (dist * dist) / 60));
  }
  dropRemote(id) {
    const v = this.remotes.get(id);
    if (v) { v.oscs.forEach((o) => o.stop()); v.out.disconnect(); this.remotes.delete(id); }
  }

  beep(freq = 880, dur = 0.12, gain = 0.25, type = 'sine', when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
  gate() { this.beep(1320, 0.09, 0.16); }
  lap() { this.beep(880, 0.12, 0.2); this.beep(1320, 0.2, 0.2, 'sine', 0.11); }
  tone() { this.beep(1000, 0.7, 0.3, 'square'); }
  finish() { [660, 880, 1100, 1320].forEach((f, i) => this.beep(f, 0.22, 0.2, 'sine', i * 0.12)); }
  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx, n = ctx.sampleRate * 0.35;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0.6;
    s.connect(f); f.connect(g); g.connect(this.master); s.start();
  }
}
