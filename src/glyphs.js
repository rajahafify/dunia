// Button glyphs for keyboard, Xbox and PlayStation pads. All drawn here as SVG.
const S = 26;

function wrap(inner, w = S) {
  return `<svg class="glyph" viewBox="0 0 ${w} ${S}" width="${w}" height="${S}" aria-hidden="true">${inner}</svg>`;
}
const disc = (fill = '#1d2330', stroke = '#5b6680') => `<circle cx="13" cy="13" r="11.5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
const letter = (t, color) => wrap(`${disc()}<text x="13" y="18" text-anchor="middle" font-size="14" font-weight="700" font-family="system-ui,sans-serif" fill="${color}">${t}</text>`);
const pill = (t, w = 40) => wrap(`<rect x="1" y="4" width="${w - 2}" height="18" rx="6" fill="#1d2330" stroke="#5b6680" stroke-width="1.5"/><text x="${w / 2}" y="17.5" text-anchor="middle" font-size="11" font-weight="700" font-family="system-ui,sans-serif" fill="#e8ecf4">${t}</text>`, w);
const key = (t) => {
  const w = Math.max(26, 14 + t.length * 8);
  return wrap(`<rect x="1" y="2" width="${w - 2}" height="22" rx="5" fill="#e8ecf4" stroke="#8791a8" stroke-width="1.5"/><rect x="1" y="2" width="${w - 2}" height="19" rx="5" fill="#fff"/><text x="${w / 2}" y="16.5" text-anchor="middle" font-size="11.5" font-weight="700" font-family="system-ui,sans-serif" fill="#1d2330">${t}</text>`, w);
};
const dpad = (dir) => {
  const on = '#e8ecf4', off = '#3a4358';
  return wrap(`${disc()}
    <rect x="10.5" y="4" width="5" height="7" rx="1" fill="${dir === 'up' ? on : off}"/>
    <rect x="10.5" y="15" width="5" height="7" rx="1" fill="${dir === 'down' ? on : off}"/>
    <rect x="4" y="10.5" width="7" height="5" rx="1" fill="${dir === 'left' ? on : off}"/>
    <rect x="15" y="10.5" width="7" height="5" rx="1" fill="${dir === 'right' ? on : off}"/>`);
};
const stick = (t) => wrap(`${disc('#11151e')}<circle cx="13" cy="13" r="7" fill="#2a3245" stroke="#8791a8" stroke-width="1.2"/><text x="13" y="17" text-anchor="middle" font-size="10" font-weight="700" font-family="system-ui,sans-serif" fill="#e8ecf4">${t}</text>`);

// PlayStation face buttons are shapes
const psCross = wrap(`${disc()}<path d="M8.5 8.5l9 9M17.5 8.5l-9 9" stroke="#7cb2e8" stroke-width="2.2" stroke-linecap="round"/>`);
const psCircle = wrap(`${disc()}<circle cx="13" cy="13" r="5.5" fill="none" stroke="#ff6b6b" stroke-width="2.2"/>`);
const psSquare = wrap(`${disc()}<rect x="8" y="8" width="10" height="10" fill="none" stroke="#f08ad8" stroke-width="2.2"/>`);
const psTriangle = wrap(`${disc()}<path d="M13 7l6 10.5H7z" fill="none" stroke="#40e2a0" stroke-width="2.2" stroke-linejoin="round"/>`);
const xbMenu = wrap(`${disc()}<path d="M8 9.5h10M8 13h10M8 16.5h10" stroke="#e8ecf4" stroke-width="1.8" stroke-linecap="round"/>`);
const xbView = wrap(`${disc()}<rect x="7.5" y="8" width="8" height="6.5" fill="none" stroke="#e8ecf4" stroke-width="1.5"/><rect x="10.5" y="11.5" width="8" height="6.5" fill="#1d2330" stroke="#e8ecf4" stroke-width="1.5"/>`);

const SETS = {
  xbox: {
    confirm: letter('A', '#6ad36a'), back: letter('B', '#ff6b6b'), x: letter('X', '#62a8ff'), y: letter('Y', '#ffd24a'),
    reset: pill('RB', 34), camera: pill('LB', 34), throttleTrigger: pill('RT', 34),
    pause: xbMenu, restart: xbView,
    tiltUp: dpad('up'), tiltDown: dpad('down'),
    stickL: stick('L'), stickR: stick('R'),
  },
  playstation: {
    confirm: psCross, back: psCircle, x: psSquare, y: psTriangle,
    reset: pill('R1', 34), camera: pill('L1', 34), throttleTrigger: pill('R2', 34),
    pause: pill('OPTIONS', 62), restart: pill('CREATE', 56),
    tiltUp: dpad('up'), tiltDown: dpad('down'),
    stickL: stick('L'), stickR: stick('R'),
  },
  keyboard: {
    confirm: key('Enter'), back: key('Esc'), x: key('X'), y: key('Y'),
    reset: key('R'), camera: key('C'), throttleTrigger: key('W'),
    pause: key('Esc'), restart: key('Backspace'),
    tiltUp: key(']'), tiltDown: key('['),
    stickL: `${key('W')}${key('A')}${key('S')}${key('D')}`,
    stickR: `${key('↑')}${key('←')}${key('↓')}${key('→')}`,
  },
};
SETS.generic = SETS.xbox;
SETS.radio = { ...SETS.keyboard, stickL: pill('LEFT STICK', 84), stickR: pill('RIGHT STICK', 90) };

export function glyph(action, device) {
  return (SETS[device] || SETS.keyboard)[action] || '';
}

export const DEVICE_NAMES = {
  keyboard: 'Keyboard', xbox: 'Xbox controller', playstation: 'PlayStation controller',
  generic: 'Controller', radio: 'Radio transmitter',
};

// Fill every element that carries data-glyph="action" for the active device.
export function paintGlyphs(device, root = document) {
  root.querySelectorAll('[data-glyph]').forEach((el) => { el.innerHTML = glyph(el.dataset.glyph, device); });
  root.querySelectorAll('[data-device-name]').forEach((el) => { el.textContent = DEVICE_NAMES[device] || 'Keyboard'; });
  document.body.dataset.device = device;
}
