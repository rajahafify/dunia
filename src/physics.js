// Quadcopter flight model. Fixed 500 Hz step, no rendering code in here.
// Axes: +X right, +Y up, -Z forward (three.js convention).
import * as THREE from 'three';

export const DT = 1 / 500;
const G = 9.81, RHO = 1.225;
const DEG = Math.PI / 180;

// A 5 inch race quad on 6S.
export const QUAD = {
  mass: 0.62,            // kg, with battery
  twr: 7.8,              // static thrust to weight
  radius: 0.14,          // collision sphere, m
  cdaSide: 0.011,        // drag area per body axis, m^2
  cdaTop: 0.03,
  cdaFront: 0.0085,
  pitchSpeed: 58,        // m/s, prop stops making thrust at this inflow
  motorUp: 0.035,        // s, spool up time constant
  motorDown: 0.07,       // s, spool down
  rateTau: 0.022,        // s, how fast the rate loop reaches the setpoint
  maxAngAcc: 190,        // rad/s^2
  idle: 0.045,           // air mode idle, fraction of full command
  cells: 6,
  capacity: 1300,        // mAh
  maxAmps: 150,
};

// Betaflight "Actual" rates. rc in -1..1, returns deg/s.
export function actualRate(rc, center, max, expo) {
  const a = Math.abs(rc);
  const expof = a * (Math.pow(rc, 5) * expo + rc * (1 - expo));
  return rc * center + Math.max(0, max - center) * expof;
}

// Stick position (-1..1) to throttle command (0..1).
export function throttleCurve(stick, mode, hover) {
  if (mode === 'upper') return Math.max(0, stick);
  if (mode === 'hover') {
    // centre stick sits at hover throttle
    return stick < 0 ? hover * (1 + stick) : hover + (1 - hover) * stick;
  }
  return (stick + 1) / 2; // 'full': like a real radio
}

const _v = new THREE.Vector3(), _vb = new THREE.Vector3(), _f = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
const _n = new THREE.Vector3(), _l = new THREE.Vector3(), _cp = new THREE.Vector3();

export class Quad {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3(); // body rates, rad/s
    this.motor = 0;                   // 0..1 filtered thrust command
    this.throttle = 0;
    this.armed = false;
    this.crashed = false;
    this.grounded = true;
    this.mah = 0;
    this.volts = QUAD.cells * 4.2;
    this.amps = 0;
    this.gforce = 1;
    this.colliders = [];
    this.onCrash = null;
    this.hoverThrottle = Math.pow(1 / QUAD.twr, 1 / 1.7);
  }

  reset(pos, yaw = 0) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.quat.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    this.motor = 0; this.throttle = 0;
    this.crashed = false; this.grounded = true;
  }

  resetBattery() { this.mah = 0; this.volts = QUAD.cells * 4.2; }

  // ctl: { throttle 0..1, roll, pitch, yaw -1..1 }, cfg: rates and mode
  step(ctl, cfg) {
    const dt = DT;
    if (this.crashed) {
      // tumble on the ground until respawn
      this.vel.y -= G * dt;
      this.vel.multiplyScalar(1 - 1.5 * dt);
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y < QUAD.radius) { this.pos.y = QUAD.radius; this.vel.y = Math.abs(this.vel.y) * 0.2; this.vel.x *= 0.96; this.vel.z *= 0.96; }
      this.motor = 0; this.amps = 0;
      return;
    }

    const armed = this.armed;
    const thr = armed ? ctl.throttle : 0;
    this.throttle = thr;

    // --- rate setpoints (deg/s -> rad/s) ---
    let rollSp, pitchSp, yawSp;
    const r = cfg.rates;
    yawSp = actualRate(ctl.yaw, r.yaw.center, r.yaw.max, r.yaw.expo) * DEG;
    if (cfg.mode === 'angle') {
      // self level: sticks set a lean angle, a P loop turns the error into a rate
      const maxA = 55 * DEG;
      _fw.set(0, 0, -1).applyQuaternion(this.quat);
      _rt.set(1, 0, 0).applyQuaternion(this.quat);
      const curPitch = Math.asin(THREE.MathUtils.clamp(-_fw.y, -1, 1)); // nose down positive
      const curRoll = Math.asin(THREE.MathUtils.clamp(-_rt.y, -1, 1));  // right side down positive
      pitchSp = THREE.MathUtils.clamp((ctl.pitch * maxA - curPitch) * 9, -8, 8);
      rollSp = THREE.MathUtils.clamp((ctl.roll * maxA - curRoll) * 9, -8, 8);
      _up.set(0, 1, 0).applyQuaternion(this.quat);
      if (_up.y < 0) { rollSp = 8; } // upside down: roll back over
    } else {
      rollSp = actualRate(ctl.roll, r.roll.center, r.roll.max, r.roll.expo) * DEG;
      pitchSp = actualRate(ctl.pitch, r.pitch.center, r.pitch.max, r.pitch.expo) * DEG;
    }
    if (!armed) { rollSp = pitchSp = yawSp = 0; }

    // --- motors ---
    const cmd = armed ? Math.max(QUAD.idle, thr) : 0;
    const tau = cmd > this.motor ? QUAD.motorUp : QUAD.motorDown;
    this.motor += (cmd - this.motor) * (1 - Math.exp(-dt / tau));

    // battery: sag under load and as the pack drains
    const used = this.mah / QUAD.capacity;
    const rest = QUAD.cells * (4.2 - 0.55 * Math.min(1, used) - (used > 0.85 ? (used - 0.85) * 4 : 0));
    this.amps = QUAD.maxAmps * Math.pow(this.motor, 2.2);
    this.volts += ((rest - this.amps * 0.011) - this.volts) * (1 - Math.exp(-dt / 0.15));
    this.mah += (this.amps * dt) / 3.6;
    const sag = THREE.MathUtils.clamp(this.volts / (QUAD.cells * 4.2), 0.6, 1);

    // --- body rates ---
    // body axis rotation signs: pitch forward = -X, yaw right = -Y, roll right = -Z
    // on the ground with no thrust the props have nothing to push against
    const auth = this.grounded ? THREE.MathUtils.clamp(this.motor * 6, 0, 1) : 1;
    const k = 1 - Math.exp(-dt / QUAD.rateTau);
    const maxD = QUAD.maxAngAcc * dt;
    const tx = -pitchSp * auth, ty = -yawSp * auth, tz = -rollSp * auth;
    this.omega.x += THREE.MathUtils.clamp((tx - this.omega.x) * k, -maxD, maxD);
    this.omega.y += THREE.MathUtils.clamp((ty - this.omega.y) * k, -maxD * 0.5, maxD * 0.5);
    this.omega.z += THREE.MathUtils.clamp((tz - this.omega.z) * k, -maxD, maxD);

    // --- forces ---
    _qi.copy(this.quat).invert();
    _vb.copy(this.vel).applyQuaternion(_qi);            // velocity in body frame
    const sp = _vb.length();
    // prop inflow: thrust falls off as air moves up through the disc, rises a little in a descent
    const inflow = THREE.MathUtils.clamp(1 - _vb.y / QUAD.pitchSpeed, 0, 1.15);
    const thrust = QUAD.mass * G * QUAD.twr * Math.pow(this.motor, 1.7) * inflow * sag * sag;

    // propwash: dropping into your own dirty air shakes the quad
    if (_vb.y < -4 && this.motor > 0.15 && !this.grounded) {
      const w = Math.min(1, (-_vb.y - 4) / 10) * this.motor * 0.9;
      this.omega.x += (Math.random() - 0.5) * w;
      this.omega.z += (Math.random() - 0.5) * w;
    }

    _f.set(
      -0.5 * RHO * QUAD.cdaSide * sp * _vb.x,
      -0.5 * RHO * QUAD.cdaTop * sp * _vb.y + thrust,
      -0.5 * RHO * QUAD.cdaFront * sp * _vb.z,
    ).applyQuaternion(this.quat);
    _f.y -= QUAD.mass * G;
    this.gforce = Math.hypot(_f.x, _f.y + QUAD.mass * G, _f.z) / (QUAD.mass * G);

    this.vel.addScaledVector(_f, dt / QUAD.mass);
    this.pos.addScaledVector(this.vel, dt);

    // integrate attitude
    const wl = this.omega.length();
    if (wl > 1e-6) {
      _q.setFromAxisAngle(_v.copy(this.omega).divideScalar(wl), wl * dt);
      this.quat.multiply(_q).normalize();
    }

    this.collide();
  }

  crash(speed) {
    if (this.crashed) return;
    this.crashed = true;
    if (this.onCrash) this.onCrash(speed);
  }

  collide() {
    const R = QUAD.radius;
    // ground
    if (this.pos.y < R) {
      const vy = -this.vel.y;
      const horiz = Math.hypot(this.vel.x, this.vel.z);
      this.pos.y = R;
      _up.set(0, 1, 0).applyQuaternion(this.quat);
      if (vy > 7 || horiz > 14 || (_up.y < 0.2 && (vy > 1.5 || horiz > 3))) { this.vel.y = vy * 0.25; this.crash(Math.hypot(vy, horiz)); return; }
      this.vel.y = vy > 1.2 ? vy * 0.25 : 0;
      const fr = Math.exp(-6 * DT);
      this.vel.x *= fr; this.vel.z *= fr;
      if (this.motor < 0.12) {
        // settle flat on the skids
        this.omega.multiplyScalar(0.9);
        _fw.set(0, 0, -1).applyQuaternion(this.quat);
        const yaw = Math.atan2(-_fw.x, -_fw.z);
        _q.setFromAxisAngle(_v.set(0, 1, 0), yaw);
        this.quat.slerp(_q, 0.02);
      }
      this.grounded = true;
    } else if (this.pos.y > R + 0.03) this.grounded = false;

    // gate frames and other boxes
    const cs = this.colliders;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      _l.copy(this.pos).sub(c.center);
      if (_l.lengthSq() > c.bound * c.bound) continue;
      _l.applyQuaternion(c.inv);
      _cp.set(
        THREE.MathUtils.clamp(_l.x, -c.half.x, c.half.x),
        THREE.MathUtils.clamp(_l.y, -c.half.y, c.half.y),
        THREE.MathUtils.clamp(_l.z, -c.half.z, c.half.z),
      );
      _n.copy(_l).sub(_cp);
      const d = _n.length();
      if (d >= R) continue;
      if (d < 1e-5) _n.set(0, 1, 0); else _n.divideScalar(d);
      _n.applyQuaternion(c.quat);
      this.pos.addScaledVector(_n, R - d);
      const vn = this.vel.dot(_n);
      if (vn < 0) {
        const total = this.vel.length();
        this.vel.addScaledVector(_n, -vn * 1.3);
        this.vel.multiplyScalar(0.8);
        if (-vn > 3.5 || total > 11) { this.crash(total); return; }
        // a light clip knocks the quad around
        this.omega.x += (Math.random() - 0.5) * 6;
        this.omega.z += (Math.random() - 0.5) * 6;
      }
    }
  }
}
