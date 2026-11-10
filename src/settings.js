// Pilot settings, kept in localStorage.
const KEY = 'ripline.settings.v1';

export const DEFAULTS = {
  name: '',
  flightMode: 'acro',        // acro | angle
  stickMode: 2,              // radio stick mode 1-4
  throttleMode: 'hover',     // hover | full | upper | trigger
  deadband: 0.05,
  camTilt: 30,               // degrees of camera uptilt
  fov: 95,                   // vertical field of view
  rates: {
    roll: { center: 70, max: 670, expo: 0 },
    pitch: { center: 70, max: 670, expo: 0 },
    yaw: { center: 70, max: 500, expo: 0 },
  },
  lens: true,                // lens distortion and vignette
  volume: 0.6,
  quality: 'high',           // high | low
  ghost: true,
  radioMap: null,            // custom axis map for a USB radio
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k in over) {
    if (over[k] && typeof over[k] === 'object' && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(DEFAULTS, JSON.parse(raw));
  } catch (e) { /* private window or blocked storage: fall through */ }
  return merge(DEFAULTS, {});
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

export function store(key, value) {
  try {
    if (value === undefined) { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { return null; }
}
