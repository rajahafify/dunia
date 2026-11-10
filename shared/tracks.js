// Track data. Shared by the client (to build the course) and the server (to check laps).
// Gate fields: p = centre of the opening [x, y, z] in metres, w/h = opening size,
// h(eading) in degrees is optional (0 = flying toward -Z, 90 = toward +X). When it is
// missing the heading is the direction from the previous gate to the next one.
// type: 'gate' (default), 'dive' (lies flat, fly down through it), 'start'.

export const TRACKS = {
  field: {
    id: 'field',
    name: 'Open Field',
    blurb: 'Eight gates, wide turns, one tower. Good for learning the line.',
    laps: 3,
    minLapMs: 9000,
    gates: [
      { p: [0, 1.5, 0], w: 3.0, h: 2.0, heading: 0, type: 'start' },
      { p: [0, 1.5, -42], w: 2.1, h: 2.1 },
      { p: [26, 1.8, -66], w: 2.1, h: 2.1 },
      { p: [56, 1.5, -44], w: 2.1, h: 2.1 },
      { p: [46, 4.5, -8], w: 2.4, h: 2.1 },
      { p: [60, 1.5, 26], w: 2.1, h: 2.1 },
      { p: [30, 1.5, 46], w: 2.1, h: 2.1 },
      { p: [4, 1.5, 32], w: 2.1, h: 2.1 },
    ],
  },
  technical: {
    id: 'technical',
    name: 'Technical',
    blurb: 'Slalom, a high tower into a dive gate, then a low hurdle. Throttle control matters.',
    laps: 3,
    minLapMs: 11000,
    gates: [
      { p: [0, 1.5, 0], w: 3.0, h: 2.0, heading: 0, type: 'start' },
      { p: [-7, 1.5, -22], w: 1.8, h: 1.8, heading: 0 },
      { p: [7, 1.5, -40], w: 1.8, h: 1.8, heading: 0 },
      { p: [-7, 1.5, -58], w: 1.8, h: 1.8, heading: 0 },
      { p: [8, 7.0, -80], w: 2.4, h: 2.1, heading: 70 },
      { p: [30, 5.5, -74], w: 2.6, h: 2.6, type: 'dive' },
      { p: [36, 1.2, -50], w: 2.4, h: 1.4, heading: 180 },
      { p: [50, 1.5, -22], w: 1.8, h: 1.8 },
      { p: [42, 1.5, 8], w: 1.8, h: 1.8 },
      { p: [20, 1.5, 26], w: 1.8, h: 1.8 },
      { p: [2, 1.5, 22], w: 1.8, h: 1.8, heading: 290 },
    ],
  },
};

export const TRACK_IDS = Object.keys(TRACKS);
export const MAX_PILOTS = 8;

// Start grid: two rows of four behind the start gate.
export function gridSlot(i) {
  const col = i % 4, row = Math.floor(i / 4);
  return [(col - 1.5) * 1.6, 0, 7 + row * 2.2];
}

// Resolved gate frames: centre c, travel normal n, right r, up u (plain arrays).
export function resolveGates(track) {
  const g = track.gates, N = g.length, out = [];
  for (let i = 0; i < N; i++) {
    const a = g[(i - 1 + N) % N].p, b = g[(i + 1) % N].p, cur = g[i];
    let n, r, u;
    if (cur.type === 'dive') {
      n = [0, -1, 0];
      // "up" of the opening points along the direction of travel after the dive
      let dx = b[0] - cur.p[0], dz = b[2] - cur.p[2];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      u = [dx, 0, dz];
      r = [-dz, 0, dx];
    } else {
      let hx, hz;
      if (cur.heading !== undefined) {
        const t = (cur.heading * Math.PI) / 180;
        hx = Math.sin(t); hz = -Math.cos(t);
      } else {
        hx = b[0] - a[0]; hz = b[2] - a[2];
        const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
      }
      n = [hx, 0, hz];
      r = [-hz, 0, hx];
      u = [0, 1, 0];
    }
    out.push({ i, c: cur.p.slice(), n, r, u, w: cur.w, h: cur.h, type: cur.type || 'gate' });
  }
  return out;
}
