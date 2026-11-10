// Settings screen: binds the form to the settings object and draws the rate curve.
import { actualRate } from './physics.js';

const $ = (id) => document.getElementById(id);

export function initSettingsUI({ get, set, defaults, input, onDone }) {
  const simple = ['flightMode', 'throttleMode', 'stickMode', 'deadband', 'camTilt', 'fov', 'lens', 'ghost', 'quality', 'volume'];
  const axes = ['roll', 'pitch', 'yaw'], parts = ['center', 'max', 'expo'];

  function fill() {
    const s = get();
    for (const k of simple) {
      const el = $(`s-${k}`);
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = k === 'volume' ? `${Math.round(s[k] * 100)}%` : k === 'deadband' ? `${Math.round(s[k] * 100)}%` : `${s[k]}°`;
    }
    for (const a of axes) for (const p of parts) $(`r-${a}-${p}`).value = s.rates[a][p];
    draw();
  }

  function read() {
    const s = structuredClone(get());
    for (const k of simple) {
      const el = $(`s-${k}`);
      s[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : k === 'stickMode' ? Number(el.value) : el.value;
    }
    for (const a of axes) for (const p of parts) {
      const el = $(`r-${a}-${p}`), v = Number(el.value);
      if (Number.isFinite(v)) s.rates[a][p] = Math.min(Number(el.max), Math.max(Number(el.min), v));
    }
    set(s);
    fill();
  }

  function draw() {
    const c = $('rate-curve'), g = c.getContext('2d'), s = get();
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.15)'; g.beginPath(); g.moveTo(0, H - 0.5); g.lineTo(W, H - 0.5); g.stroke();
    const top = Math.max(...axes.map((a) => s.rates[a].max), 200);
    const colors = { roll: '#ff6b6b', pitch: '#38ff7a', yaw: '#62a8ff' };
    g.font = '11px system-ui'; let lx = 8;
    for (const a of axes) {
      const r = s.rates[a];
      g.strokeStyle = colors[a]; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i <= 60; i++) { const x = i / 60, y = actualRate(x, r.center, r.max, r.expo) / top; g[i ? 'lineTo' : 'moveTo'](x * W, H - y * (H - 14)); }
      g.stroke();
      g.fillStyle = colors[a]; g.fillText(`${a} ${Math.round(r.max)}°/s`, lx, 12); lx += 96;
    }
  }

  $('settings').addEventListener('change', read);
  $('settings').addEventListener('input', (e) => { if (e.target.type === 'range') read(); });
  $('s-done').onclick = onDone;
  $('s-reset').onclick = () => { const keep = get().name; set({ ...structuredClone(defaults), name: keep }); fill(); };

  // live axis bars so pilots can see what the pad or radio is sending
  const bars = $('axes');
  setInterval(() => {
    if (!$('settings').classList.contains('active')) return;
    const ax = input.rawAxes || [];
    while (bars.children.length < Math.min(ax.length, 8)) bars.insertAdjacentHTML('beforeend', '<div><i></i></div>');
    for (let i = 0; i < bars.children.length; i++) bars.children[i].firstChild.style.left = `${50 + (ax[i] || 0) * 50}%`;
  }, 50);

  // radio mapping: ask for one stick at a time and see which axis moves
  let cal = null;
  $('radio-cal').onclick = () => {
    const order = [['throttle', 'Push THROTTLE all the way up'], ['yaw', 'Push YAW (rudder) right'], ['pitch', 'Push PITCH (elevator) forward'], ['roll', 'Push ROLL (aileron) right']];
    const map = {}; let step = 0, base = null, wait = 0;
    clearInterval(cal);
    const msg = $('radio-msg');
    msg.textContent = 'Centre the sticks, throttle down.';
    cal = setInterval(() => {
      const ax = input.rawAxes || [];
      if (!ax.length) { msg.textContent = 'No radio found. Plug it in and move a stick.'; return; }
      if (wait++ < 25) return;
      if (!base) { base = ax.slice(); msg.textContent = order[step][1]; return; }
      const used = new Set(Object.values(map).map((m) => m.axis));
      let best = -1, bd = 0;
      ax.forEach((v, i) => { const d = v - base[i]; if (!used.has(i) && Math.abs(d) > Math.abs(bd)) { bd = d; best = i; } });
      if (best >= 0 && Math.abs(bd) > 0.55) {
        map[order[step][0]] = { axis: best, inv: bd < 0 };
        step++; base = null; wait = 0;
        if (step >= order.length) {
          clearInterval(cal);
          const s = structuredClone(get()); s.radioMap = map; set(s);
          msg.textContent = 'Radio mapped. Check the bars, then fly.';
        } else msg.textContent = 'Got it. Let go of the stick.';
      }
    }, 40);
  };

  fill();
  return { fill };
}
