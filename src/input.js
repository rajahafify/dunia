// Reads keyboard, gamepads and USB radios and turns them into four stick channels.
// Glyphs follow whichever device was touched last. Keyboard is the default.
import { paintGlyphs } from './glyphs.js';

export function padKind(pad) {
  const id = (pad.id || '').toLowerCase();
  if (pad.mapping !== 'standard') return 'radio';
  if (/dualsense|dualshock|playstation|054c|ps3|ps4|ps5|wireless controller/.test(id)) return 'playstation';
  if (/xbox|xinput|045e|microsoft/.test(id)) return 'xbox';
  return 'generic';
}

// Standard mapping button numbers
const BTN = { confirm: 0, back: 1, x: 2, y: 3, camera: 4, reset: 5, lt: 6, rt: 7, restart: 8, pause: 9, tiltUp: 12, tiltDown: 13, left: 14, right: 15 };
const KEYS = { Enter: 'confirm', Escape: 'pause', KeyR: 'reset', KeyC: 'camera', Backspace: 'restart', BracketRight: 'tiltUp', BracketLeft: 'tiltDown', KeyM: 'mode' };

// which stick axis feeds which channel, per radio stick mode: [throttle, yaw, pitch, roll] as [stick, axis]
// axes: 0 LX, 1 LY, 2 RX, 3 RY
const MODES = {
  1: { throttle: 3, yaw: 0, pitch: 1, roll: 2 },
  2: { throttle: 1, yaw: 0, pitch: 3, roll: 2 },
  3: { throttle: 1, yaw: 2, pitch: 3, roll: 0 },
  4: { throttle: 3, yaw: 2, pitch: 1, roll: 0 },
};

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.device = 'keyboard';
    this.padIndex = -1;
    this.padName = '';
    this.keys = new Set();
    this.kb = { throttle: -1, yaw: 0, pitch: 0, roll: 0 };
    this.ch = { throttle: -1, yaw: 0, pitch: 0, roll: 0 }; // sticks, -1..1
    this.trigger = 0;
    this.prev = {};
    this.pressed = new Set();   // actions that fired this frame
    this.listeners = [];
    this.rawAxes = [];
    this.lastPadActivity = 0;

    addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (!this.keys.has(e.code)) {
        this.keys.add(e.code);
        const a = KEYS[e.code];
        if (a) this.pressed.add(a);
        if (/^(Arrow|Space|Backspace)/.test(e.code)) e.preventDefault();
        this.setDevice('keyboard');
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; this.usePad(e.gamepad); this.emit('connect', e.gamepad); });
    addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.padIndex) { this.padIndex = -1; this.padName = ''; this.setDevice('keyboard'); this.emit('disconnect'); }
    });
  }

  on(fn) { this.listeners.push(fn); }
  emit(type, data) { this.listeners.forEach((f) => f(type, data)); }

  usePad(pad) {
    this.padName = pad.id;
    this.setDevice(padKind(pad));
  }

  setDevice(d) {
    if (d === this.device) return;
    this.device = d;
    paintGlyphs(d);
    this.emit('device', d);
  }

  pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.padIndex >= 0 && pads[this.padIndex]) return pads[this.padIndex];
    for (const p of pads) if (p && p.connected) { this.padIndex = p.index; return p; }
    return null;
  }

  dead(v) {
    const d = this.settings.deadband;
    const a = Math.abs(v);
    return a < d ? 0 : Math.sign(v) * (a - d) / (1 - d);
  }

  // call once per frame
  poll(dt) {
    const s = this.settings;
    const pad = this.pad();
    let padActive = false;
    if (pad) {
      this.rawAxes = Array.from(pad.axes);
      const kind = padKind(pad);
      const ch = { throttle: -1, yaw: 0, pitch: 0, roll: 0 };
      if (kind === 'radio') {
        const map = s.radioMap;
        if (map) {
          for (const k of ['throttle', 'yaw', 'pitch', 'roll']) {
            const m = map[k];
            if (m) ch[k] = Math.max(-1, Math.min(1, (pad.axes[m.axis] || 0) * (m.inv ? -1 : 1)));
          }
        }
      } else {
        const m = MODES[s.stickMode] || MODES[2];
        ch.throttle = -this.dead(pad.axes[m.throttle] || 0);
        ch.yaw = this.dead(pad.axes[m.yaw] || 0);
        ch.pitch = -this.dead(pad.axes[m.pitch] || 0);
        ch.roll = this.dead(pad.axes[m.roll] || 0);
        this.trigger = pad.buttons[BTN.rt] ? pad.buttons[BTN.rt].value : 0;
        for (const name in BTN) {
          const b = pad.buttons[BTN[name]];
          const down = !!(b && b.pressed);
          if (down && !this.prev[name]) { this.pressed.add(name); padActive = true; }
          this.prev[name] = down;
        }
      }
      const moved = Math.abs(ch.yaw) + Math.abs(ch.pitch) + Math.abs(ch.roll) > 0.25 || this.trigger > 0.2 ||
        (kind !== 'radio' && Math.abs(ch.throttle) > 0.3) ||
        (kind === 'radio' && this.lastAxes && pad.axes.some((v, i) => Math.abs(v - (this.lastAxes[i] || 0)) > 0.05));
      this.lastAxes = Array.from(pad.axes);
      if (moved || padActive) { this.lastPadActivity = performance.now(); if (this.device !== kind) this.usePad(pad); }
      if (this.device !== 'keyboard') { this.ch = ch; return; }
    }

    // keyboard: keys push a virtual stick that springs back to centre
    const k = this.keys, kb = this.kb;
    const ramp = (cur, target, up, down) => {
      const rate = target !== 0 ? up : down;
      const d = target - cur, st = rate * dt;
      return Math.abs(d) <= st ? target : cur + Math.sign(d) * st;
    };
    const ax = (pos, neg) => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    const slow = k.has('ShiftLeft') || k.has('ShiftRight') ? 0.45 : 1;
    kb.throttle = ramp(kb.throttle, ax('KeyW', 'KeyS'), 4, 5);
    kb.yaw = ramp(kb.yaw, ax('KeyD', 'KeyA') * slow, 5, 8);
    kb.pitch = ramp(kb.pitch, ax('ArrowUp', 'ArrowDown') * slow, 5, 8);
    kb.roll = ramp(kb.roll, ax('ArrowRight', 'ArrowLeft') * slow, 5, 8);
    this.ch = { ...kb };
  }

  // true once per press
  take(action) {
    if (this.pressed.has(action)) { this.pressed.delete(action); return true; }
    return false;
  }
  endFrame() { this.pressed.clear(); }
}
