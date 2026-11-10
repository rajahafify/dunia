// Ripline FPV: game loop, race logic and screens.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TRACKS, TRACK_IDS, gridSlot } from '../shared/tracks.js';
import { Quad, DT, QUAD, throttleCurve } from './physics.js';
import { World } from './world.js';
import { Input } from './input.js';
import { paintGlyphs } from './glyphs.js';
import { loadSettings, saveSettings, store, DEFAULTS } from './settings.js';
import { loadDroneModel, makeDrone, spinProps, nameTag } from './drone.js';
import { Sound } from './audio.js';
import { api, RoomSocket } from './net.js';
import { initSettingsUI } from './settings-ui.js';

const $ = (id) => document.getElementById(id);
const fmt = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '--';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);

// ---------- renderer ----------
let settings = loadSettings();
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'low', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'low' ? 1 : 2));
renderer.shadowMap.enabled = settings.quality !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov, 16 / 9, 0.03, 4000);
scene.add(camera);
const world = new World(scene, renderer, settings.quality);

const LensShader = {
  uniforms: { tDiffuse: { value: null }, k: { value: 0.16 }, vig: { value: 0.55 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float k; uniform float vig; varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5; float r2 = dot(c, c);
      vec2 uv = 0.5 + c * (1.0 + k * r2) / (1.0 + k * 0.3);
      float ca = 0.006 * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, 0.5 + (uv - 0.5) * (1.0 + ca)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, 0.5 + (uv - 0.5) * (1.0 - ca)).b;
      col *= 1.0 - vig * smoothstep(0.18, 0.62, r2);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
let composer = null, lensPass = null, bloom = null;
if (settings.quality !== 'low') {
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.28, 0.5, 1.0);
  composer.addPass(bloom);
  lensPass = new ShaderPass(LensShader);
  composer.addPass(lensPass);
  composer.addPass(new OutputPass());
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- game state ----------
const input = new Input(settings);
const sound = new Sound();
const quad = new Quad();
quad.colliders = world.colliders;
const game = {
  screen: 'home',          // home | fly
  mode: null,              // solo | room
  overlay: null,           // pause | settings | results | null
  trackId: store('ripline.track') || 'field',
  camMode: 'fpv',
  user: null, config: { googleClientId: '', allowGuests: true }, online: false,
  room: null, sock: null, myId: 0,
  pilots: new Map(),       // id -> { info, drone, tag, buf: [], prog }
  race: null,
  paused: false,
  bot: params.get('bot') === '1',
};
window.__game = game; // handy in the browser console
game.quad = quad; game.world = world; game.input = input;

let myDrone = null, ghostDrone = null;
let crashAt = 0;
quad.onCrash = () => {
  crashAt = performance.now();
  sound.crash();
  if (game.sock) game.sock.send({ t: 'crash' });
  banner('CRASHED', 'Resetting to the gate', 1300);
};

function newRace(official, laps) {
  return { official, phase: 'grid', next: 0, lap: 0, laps: [], gates: 0, t0: 0, lapStart: 0, last: null, best: null, totalLaps: laps, goAt: 0, slot: 0, rec: [], recT: 0, finished: null };
}

function setTrack(id) {
  if (!TRACKS[id]) id = 'field';
  game.trackId = id; store('ripline.track', id);
  if (world.track !== TRACKS[id]) world.setTrack(TRACKS[id]);
}

function toGrid(slot = 0) {
  const s = gridSlot(slot);
  quad.reset(new THREE.Vector3(s[0], QUAD.radius, s[2]), 0);
  quad.resetBattery();
  world.highlight(0);
}

function respawn() {
  const r = game.race;
  if (!r || r.phase === 'grid' || (r.gates === 0)) { toGrid(r ? r.slot : 0); if (r && !r.official) { r.phase = 'grid'; r.next = 0; r.lap = 0; r.gates = 0; r.rec = []; } return; }
  const p = world.respawnPoint(r.next);
  quad.reset(p.pos, p.yaw);
  quad.grounded = false;
  quad.motor = quad.hoverThrottle;
  quad.vel.set(0, 0, 0);
}

// ---------- banner ----------
let bannerTimer = 0;
function banner(text, sub = '', ms = 1800) {
  const b = $('banner');
  b.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
  b.classList.add('show');
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

// ---------- gates and laps ----------
const prevPos = new THREE.Vector3();
function checkGates() {
  const r = game.race;
  if (!r || r.phase !== 'live' || quad.crashed) return;
  if (!world.passed(r.next, prevPos, quad.pos)) return;
  const ms = performance.now() - r.t0;
  const i = r.next, N = world.gates.length;
  r.gates++;
  r.next = (r.next + 1) % N;
  let lapMs = null;
  if (i === 0 && r.gates > 1) {
    lapMs = ms - r.lapStart;
    r.laps.push(lapMs); r.lap++; r.lapStart = ms; r.last = lapMs;
    const isBest = r.best == null || lapMs < r.best;
    if (isBest) r.best = lapMs;
    sound.lap();
    banner(fmt(lapMs), isBest ? 'Best lap' : `Lap ${r.lap}`, 1800);
    if (!r.official) saveGhost(lapMs);
    r.rec = []; r.recT = 0;
  } else {
    if (i === 0) { r.lapStart = r.official ? 0 : ms; if (!r.official) { r.t0 += ms; r.lapStart = 0; r.rec = []; r.recT = 0; } }
    sound.gate();
  }
  if (r.official && game.sock) game.sock.send({ t: 'gate', i, lap: r.lap, ms: Math.round(r.official ? ms : 0) });
  if (r.official && r.lap >= r.totalLaps) {
    r.phase = 'done'; r.finished = ms;
    sound.finish();
    banner('FINISHED', fmt(ms), 4000);
  }
  world.highlight(r.phase === 'done' ? -1 : r.next);
  const me = game.pilots.get(game.myId);
  if (me) me.prog = { gates: r.gates, ms, lap: r.lap, finish: r.finished };
}

// ---------- ghost (time trial) ----------
function ghostKey() { return `ripline.ghost.${game.trackId}`; }
let ghost = null;
function loadGhost() { ghost = store(ghostKey()); if (ghostDrone) ghostDrone.visible = false; }
function saveGhost(lapMs) {
  const r = game.race;
  if (r.rec.length < 20) return;
  if (ghost && ghost.ms <= lapMs) return;
  ghost = { ms: Math.round(lapMs), f: r.rec };
  store(ghostKey(), ghost);
}
function recordGhost(dt) {
  const r = game.race;
  if (!r || r.official || r.phase !== 'live' || r.gates === 0) return;
  r.recT += dt;
  if (r.recT < 1 / 20) return;
  r.recT = 0;
  const t = Math.round(performance.now() - r.t0 - r.lapStart);
  const p = quad.pos, q = quad.quat, f = (v) => Math.round(v * 1000) / 1000;
  r.rec.push([t, f(p.x), f(p.y), f(p.z), f(q.x), f(q.y), f(q.z), f(q.w)]);
}
const _ga = new THREE.Quaternion(), _gb = new THREE.Quaternion();
function playGhost() {
  const r = game.race;
  if (!ghostDrone) return;
  const on = settings.ghost && ghost && r && !r.official && r.phase === 'live' && r.gates > 0;
  ghostDrone.visible = !!on;
  if (!on) return;
  const t = performance.now() - r.t0 - r.lapStart, f = ghost.f;
  let i = 0; while (i < f.length - 2 && f[i + 1][0] < t) i++;
  const a = f[i], b = f[i + 1] || a, k = THREE.MathUtils.clamp((t - a[0]) / Math.max(1, b[0] - a[0]), 0, 1);
  ghostDrone.position.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
  ghostDrone.quaternion.copy(_ga.set(a[4], a[5], a[6], a[7])).slerp(_gb.set(b[4], b[5], b[6], b[7]), k);
  spinProps(ghostDrone, 0.6, 1 / 60);
}

// ---------- multiplayer ----------
function addPilot(info) {
  let p = game.pilots.get(info.id);
  if (p) { p.info = info; return p; }
  p = { info, drone: null, tag: null, buf: [], prog: { gates: 0, ms: 0, lap: 0, finish: null }, motor: 0 };
  if (info.id !== game.myId) {
    p.drone = makeDrone(info.color); p.drone.visible = false; scene.add(p.drone);
    p.tag = nameTag(info.name, info.color); p.tag.position.y = 0.28; p.drone.add(p.tag);
  }
  game.pilots.set(info.id, p);
  return p;
}
function removePilot(id) {
  const p = game.pilots.get(id);
  if (!p) return;
  if (p.drone) scene.remove(p.drone);
  sound.dropRemote(id);
  game.pilots.delete(id);
}
function clearPilots() { [...game.pilots.keys()].forEach(removePilot); }

function renderRoomPanel() {
  const room = game.room; if (!room) return;
  $('rp-track').textContent = TRACKS[room.track].name;
  $('rp-code').textContent = room.code;
  const iAmHost = room.host === game.myId;
  $('rp-host').classList.toggle('hidden', !(iAmHost && room.state === 'lobby'));
  $('rp-trackpick').value = room.track;
  $('rp-pilots').innerHTML = [...game.pilots.values()].map((p) =>
    `<li><i style="background:${p.info.color}"></i><span>${esc(p.info.name)}${p.info.id === room.host ? ' ★' : ''}</span><b class="${p.info.ready ? 'ok' : ''}">${room.state === 'lobby' ? (p.info.ready ? 'READY' : 'warming up') : (p.info.racing ? 'racing' : 'watching')}</b></li>`).join('');
  const me = game.pilots.get(game.myId);
  const ready = me && me.info.ready;
  $('rp-status').textContent = room.state === 'lobby'
    ? (game.pilots.size === 1 ? 'Fly around while you wait. Share the code to bring pilots in. Ready up to start alone.' : 'The heat starts when every pilot is ready.')
    : room.state === 'racing' || room.state === 'countdown' ? (game.race && game.race.official ? '' : 'Heat in progress. You are in the next one.') : '';
  $('hint-ready').classList.toggle('hidden', !(room.state === 'lobby'));
  $('hint-ready-text').textContent = ready ? 'Not ready' : 'Ready up';
}

function applyRoom(room) {
  const before = game.room;
  game.room = room;
  if (!before || before.track !== room.track) { setTrack(room.track); if (!game.race || !game.race.official) startFree(); }
  if (room.state === 'lobby' && game.race && game.race.official) { startFree(); hideOverlay('results'); }
  renderRoomPanel();
}

// warm-up flying in a room, same as a time trial but nothing is sent
function startFree() {
  game.race = newRace(false, 0);
  const me = game.pilots.get(game.myId);
  game.race.slot = me ? [...game.pilots.keys()].indexOf(game.myId) : 0;
  toGrid(game.race.slot);
  quad.armed = true;
  document.body.classList.remove('racing');
  for (const p of game.pilots.values()) p.prog = { gates: 0, ms: 0, lap: 0, finish: null };
}

function joinRoom(code, priv) {
  leaveRoom();
  $('home-msg').textContent = '';
  const sock = game.sock = new RoomSocket(code, { priv });
  let welcomed = false;
  sock.on('welcome', (m) => {
    welcomed = true;
    game.myId = m.id; game.mode = 'room';
    clearPilots();
    m.pilots.forEach(addPilot);
    game.room = null;
    applyRoom(m.room);
    if (!game.race) startFree();
    if (pendingTrack && m.room.host === m.id && m.room.state === 'lobby' && pendingTrack !== m.room.track) sock.send({ t: 'track', id: pendingTrack });
    pendingTrack = null;
    enterFlight();
    history.replaceState(null, '', `?room=${m.room.code}`);
    if (m.room.state !== 'lobby') banner('HEAT IN PROGRESS', 'Warm up. You join the next one.', 3500);
  })
    .on('join', (m) => { addPilot(m.pilot); renderRoomPanel(); })
    .on('leave', (m) => { removePilot(m.id); renderRoomPanel(); })
    .on('pilot', (m) => { addPilot(m.pilot); renderRoomPanel(); })
    .on('pilots', (m) => { m.pilots.forEach(addPilot); renderRoomPanel(); })
    .on('room', (m) => applyRoom(m.room))
    .on('p', (m) => {
      const p = game.pilots.get(m.id); if (!p) return;
      p.buf.push({ t: performance.now(), d: m.d });
      if (p.buf.length > 12) p.buf.shift();
    })
    .on('countdown', (m) => {
      game.room = m.room; setTrack(m.room.track);
      const slot = (m.slots.find((s) => s[0] === game.myId) || [0, 0])[1];
      game.race = newRace(true, m.room.laps);
      game.race.slot = slot; game.race.goAt = m.goAt;
      toGrid(slot);
      quad.armed = false;
      hideOverlay(); game.paused = false;
      document.body.classList.add('racing');
      for (const p of game.pilots.values()) { p.prog = { gates: 0, ms: 0, lap: 0, finish: null }; p.info.racing = true; }
      banner('ARM YOUR QUADS', 'Going live on the tone in less than five', 0);
      sound.beep(520, 0.25, 0.2);
      renderRoomPanel();
    })
    .on('gate', (m) => {
      const p = game.pilots.get(m.id); if (!p || m.id === game.myId) return;
      p.prog.gates++; p.prog.ms = m.ms; p.prog.lap = m.lap;
    })
    .on('finish', (m) => {
      const p = game.pilots.get(m.id); if (!p) return;
      p.prog.finish = m.ms;
      if (m.id !== game.myId) banner(`${p.info.name} finished`, fmt(m.ms), 2200);
    })
    .on('dq', (m) => { if (m.id === game.myId) { banner('LAP NOT COUNTED', 'That lap was too fast to be real', 3000); startFree(); } })
    .on('results', (m) => { game.room = m.room; showResults(m.results); renderRoomPanel(); })
    .on('close', (ev) => {
      game.sock = null;
      if (game.mode === 'room' || !welcomed) {
        goHome();
        $('home-msg').textContent = ev.code === 4000 ? 'This account joined from another tab.' : welcomed ? 'Lost the connection to the room.' : 'Could not join that room. It may be full.';
      }
    });
}

function leaveRoom() {
  if (game.sock) { game.sock.close(); game.sock = null; }
  clearPilots();
  game.room = null; game.myId = 0;
  document.body.classList.remove('racing');
}

function showResults(res) {
  $('res-track').textContent = TRACKS[res.track].name;
  $('res-table').innerHTML = '<tr><th>#</th><th>Pilot</th><th>Time</th><th>Best lap</th></tr>' + res.rows.map((r, i) =>
    `<tr><td>${i + 1}</td><td><i style="background:${r.color}"></i>${esc(r.name)}</td><td>${r.ms != null ? fmt(r.ms) : `DNF (lap ${r.lap + 1})`}</td><td>${fmt(r.best)}</td></tr>`).join('');
  showOverlay('results');
  loadLeaderboard();
}

let sendT = 0;
function netSend(dt) {
  if (!game.sock || !game.sock.open) return;
  sendT += dt;
  if (sendT < 1 / 15) return;
  sendT = 0;
  const p = quad.pos, q = quad.quat, f = (v) => Math.round(v * 1000) / 1000;
  game.sock.send({ t: 'p', d: [f(p.x), f(p.y), f(p.z), f(q.x), f(q.y), f(q.z), f(q.w), Math.round(quad.motor * 100) / 100] });
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function updateRemotes(dt) {
  const now = performance.now() - 110; // render a little in the past and blend between updates
  for (const [id, p] of game.pilots) {
    if (!p.drone) continue;
    const b = p.buf;
    if (b.length === 0) { p.drone.visible = false; continue; }
    let i = b.length - 1;
    while (i > 0 && b[i].t > now) i--;
    const a = b[i], c = b[Math.min(i + 1, b.length - 1)];
    const k = c === a ? 0 : THREE.MathUtils.clamp((now - a.t) / (c.t - a.t), 0, 1.25);
    const A = a.d, C = c.d;
    p.drone.visible = performance.now() - b[b.length - 1].t < 3000;
    p.drone.position.set(A[0] + (C[0] - A[0]) * k, A[1] + (C[1] - A[1]) * k, A[2] + (C[2] - A[2]) * k);
    p.drone.quaternion.copy(_qa.set(A[3], A[4], A[5], A[6])).slerp(_qb.set(C[3], C[4], C[5], C[6]), Math.min(1, k));
    p.motor = A[7] + (C[7] - A[7]) * Math.min(1, k);
    spinProps(p.drone, p.motor, dt);
    if (p.drone.visible) sound.remote(id, p.motor, p.drone.position.distanceTo(quad.pos));
    else sound.remote(id, 0, 999);
  }
}

// ---------- screens ----------
function showOverlay(name) {
  game.overlay = name;
  for (const s of ['pause', 'settings', 'results']) $(s).classList.toggle('active', s === name);
  if (name) { const f = $(name).querySelector('button.primary'); if (f && name !== 'results') f.focus(); }
}
function hideOverlay(only) {
  if (only && game.overlay !== only) return;
  showOverlay(null);
  if (game.screen === 'home') $('home').classList.add('active');
}
function enterFlight() {
  game.screen = 'fly';
  $('home').classList.remove('active');
  $('osd').classList.remove('hidden');
  $('roompanel').classList.toggle('hidden', game.mode !== 'room');
  $('hint-ready').classList.toggle('hidden', game.mode !== 'room');
  document.body.classList.add('flying');
  document.body.classList.toggle('inroom', game.mode === 'room');
  if (myDrone) myDrone.visible = true;
  game.paused = false;
  sound.unlock();
  canvas.focus();
  loadGhost();
}
function goHome() {
  leaveRoom();
  game.screen = 'home'; game.mode = null; game.race = null; game.paused = false;
  showOverlay(null);
  $('home').classList.add('active');
  $('osd').classList.add('hidden');
  $('roompanel').classList.add('hidden');
  document.body.classList.remove('flying', 'racing', 'inroom');
  history.replaceState(null, '', location.pathname);
  setTrack($('track-pick').value);
  toGrid(0); quad.armed = false;
  sound.motor(0);
  loadLeaderboard();
}
function startSolo() {
  leaveRoom();
  game.mode = 'solo';
  setTrack($('track-pick').value);
  game.race = newRace(false, 0);
  toGrid(0); quad.armed = true;
  enterFlight();
  banner('TIME TRIAL', 'The clock starts at the first gate', 2600);
}

async function ensureSession() {
  if (game.user) return true;
  if (!game.online) { $('home-msg').textContent = 'The race server is not reachable. Time trial still works.'; return false; }
  if (!game.config.allowGuests) { $('home-msg').textContent = 'Sign in with Google to race online.'; return false; }
  try {
    const name = $('guest-name').value.trim() || `Pilot${Math.floor(100 + Math.random() * 900)}`;
    const r = await api.post('/api/auth/guest', { name });
    setUser(r.user);
    return true;
  } catch (e) { $('home-msg').textContent = e.message; return false; }
}
function setUser(user) {
  game.user = user;
  $('signed-out').classList.toggle('hidden', !!user);
  $('signed-in').classList.toggle('hidden', !user);
  if (user) { $('me-name').textContent = user.name + (user.guest ? ' (guest)' : ''); $('me-pic').src = user.pic || ''; }
}

async function loadLeaderboard() {
  const id = $('track-pick').value;
  $('lb-track').textContent = TRACKS[id].name;
  const local = store(`ripline.ghost.${id}`);
  let rows = [];
  if (game.online) { try { rows = (await api.get(`/api/leaderboard?track=${id}`)).rows; } catch (e) { /* offline */ } }
  const el = $('leaderboard');
  el.innerHTML = rows.length ? rows.slice(0, 8).map((r) => `<li>${esc(r.name)} <span>${fmt(r.ms)}</span></li>`).join('') : '<li class="note">No online laps yet. Signed-in pilots post laps from races.</li>';
  if (local) el.insertAdjacentHTML('beforeend', `<li class="note">Your time trial best: ${fmt(local.ms)}</li>`);
}

function initHome() {
  const pick = $('track-pick'), rp = $('rp-trackpick');
  for (const id of TRACK_IDS) { pick.add(new Option(TRACKS[id].name, id)); rp.add(new Option(TRACKS[id].name, id)); }
  pick.value = game.trackId;
  const onTrack = () => { $('track-blurb').textContent = TRACKS[pick.value].blurb; setTrack(pick.value); toGrid(0); loadLeaderboard(); };
  pick.onchange = onTrack; onTrack();
  rp.onchange = () => game.sock && game.sock.send({ t: 'track', id: rp.value });
  $('rp-start').onclick = () => game.sock && game.sock.send({ t: 'start' });
  $('rp-code').onclick = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/?room=${game.room.code}`); $('rp-code').textContent = 'COPIED'; setTimeout(renderRoomPanel, 1200); } catch (e) { /* clipboard blocked */ }
  };
  $('btn-solo').onclick = () => { sound.unlock(); startSolo(); };
  $('btn-quick').onclick = async () => {
    sound.unlock();
    if (!(await ensureSession())) return;
    try { const q = await api.get(`/api/quick?track=${pick.value}`); joinRoom(q.code, false); if (q.fresh) pendingTrack = pick.value; }
    catch (e) { $('home-msg').textContent = e.message; }
  };
  $('btn-private').onclick = async () => {
    sound.unlock();
    if (!(await ensureSession())) return;
    const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), (v) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v % 32]).join('');
    pendingTrack = pick.value;
    joinRoom(code, true);
  };
  const join = async () => {
    sound.unlock();
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) { $('home-msg').textContent = 'Room codes are 4 to 8 letters and numbers.'; return; }
    if (await ensureSession()) joinRoom(code, false);
  };
  $('btn-join').onclick = join;
  $('join-code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
  $('guest-go').onclick = async () => { await ensureSession(); };
  $('guest-name').onkeydown = (e) => { if (e.key === 'Enter') ensureSession(); };
  $('signout').onclick = async () => { try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ } setUser(null); };
  $('btn-settings').onclick = () => { $('home').classList.remove('active'); showOverlay('settings'); };
  $('p-settings').onclick = () => showOverlay('settings');
  $('p-resume').onclick = () => { hideOverlay(); game.paused = false; };
  $('p-restart').onclick = () => { hideOverlay(); game.paused = false; restart(); };
  $('p-leave').onclick = () => goHome();
}
let pendingTrack = null;

function restart() {
  if (game.race && game.race.official) { respawn(); return; }
  if (game.mode === 'solo') { game.race = newRace(false, 0); toGrid(0); quad.armed = true; }
  else if (game.mode === 'room') startFree();
}

async function initAuth() {
  try {
    const cfg = await api.get('/api/config');
    game.config = cfg; game.online = true;
    if (cfg.user) setUser(cfg.user);
    $('guest-row').classList.toggle('hidden', !cfg.allowGuests);
    if (cfg.googleClientId) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => {
        google.accounts.id.initialize({
          client_id: cfg.googleClientId,
          callback: async (resp) => {
            try { const r = await api.post('/api/auth/google', { credential: resp.credential }); setUser(r.user); $('home-msg').textContent = ''; }
            catch (e) { $('home-msg').textContent = e.message; }
          },
        });
        google.accounts.id.renderButton($('gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
      };
      s.onerror = () => { $('auth-note').textContent = 'Google sign-in could not load.'; };
      document.head.appendChild(s);
      $('auth-note').textContent = cfg.allowGuests ? 'Sign in to post laps on the board. Guests can race too.' : '';
    } else {
      $('auth-note').textContent = 'Google sign-in is not set up on this server yet. Guests can race.';
    }
  } catch (e) {
    game.online = false;
    $('signed-out').classList.add('hidden');
    $('home-msg').textContent = 'Race server not reachable. Time trial works offline.';
    $('btn-quick').disabled = $('btn-private').disabled = $('btn-join').disabled = true;
  }
}

// ---------- controls text ----------
function describeControls() {
  const m = { 1: ['Pitch and yaw', 'Throttle and roll'], 2: ['Throttle and yaw', 'Pitch and roll'], 3: ['Throttle and roll', 'Pitch and yaw'], 4: ['Pitch and roll', 'Throttle and yaw'] }[settings.stickMode] || [];
  const kb = input.device === 'keyboard';
  $('ctl-left').textContent = kb ? 'Throttle (W/S) and yaw (A/D)' : m[0];
  $('ctl-right').textContent = kb ? 'Pitch and roll' : m[1];
  $('device-detail').textContent = input.device === 'keyboard' ? '(plug in a controller and press a button to switch)' : '';
  $('pad-id').textContent = input.padName || '';
  $('radio-setup').classList.toggle('hidden', input.device !== 'radio');
}
input.on((type) => {
  describeControls();
  if (type === 'connect' && game.screen === 'fly') banner('CONTROLLER CONNECTED', '', 1500);
  if (type === 'disconnect' && game.screen === 'fly') { banner('CONTROLLER LOST', 'Keyboard is active', 2500); if (game.mode === 'solo') { game.paused = true; showOverlay('pause'); } }
});

// ---------- menu navigation with a pad ----------
function focusables() {
  const root = game.overlay ? $(game.overlay) : game.screen === 'home' ? $('home') : null;
  return root ? [...root.querySelectorAll('button, select, input')].filter((e) => !e.disabled && e.offsetParent !== null) : [];
}
function menuNav() {
  const list = focusables(); if (!list.length) return;
  let i = list.indexOf(document.activeElement);
  const mv = (d) => { i = i < 0 ? 0 : (i + d + list.length) % list.length; list[i].focus(); };
  if (input.device === 'keyboard') return; // the browser already handles Tab and Enter
  if (input.take('tiltDown')) mv(1);
  if (input.take('tiltUp')) mv(-1);
  const el = document.activeElement;
  const lr = (input.take('right') ? 1 : 0) - (input.take('left') ? 1 : 0);
  if (lr && el) {
    if (el.tagName === 'SELECT') { el.selectedIndex = THREE.MathUtils.clamp(el.selectedIndex + lr, 0, el.options.length - 1); el.dispatchEvent(new Event('change')); }
    else if (el.type === 'range' || el.type === 'number') { el.value = Number(el.value) + lr * Number(el.step || 1); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }
  }
  if (input.take('confirm')) { if (i < 0) mv(1); else if (el.type === 'checkbox' || el.tagName === 'BUTTON') el.click(); }
}

// ---------- frame ----------
const clock = new THREE.Clock();
let acc = 0, osdT = 0, orbit = 0;
const ctl = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
const _camQ = new THREE.Quaternion(), _tilt = new THREE.Quaternion(), _x = new THREE.Vector3(1, 0, 0), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const chase = new THREE.Vector3();

function readControls() {
  const ch = input.ch;
  let mode = settings.throttleMode;
  if (input.device === 'keyboard') mode = 'hover';
  else if (input.device === 'radio') mode = 'full';
  ctl.throttle = mode === 'trigger' ? input.trigger : throttleCurve(ch.throttle, mode, quad.hoverThrottle);
  ctl.yaw = ch.yaw; ctl.pitch = ch.pitch; ctl.roll = ch.roll;
  if (game.bot && game.botFn) game.botFn(ctl);
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  input.poll(dt);
  const flying = game.screen === 'fly';
  const r = game.race;

  if (game.overlay || !flying) menuNav();

  if (flying) {
    if (input.take('pause')) {
      if (game.overlay === 'settings') { showOverlay('pause'); }
      else if (game.overlay === 'pause') { hideOverlay(); game.paused = false; }
      else if (!game.overlay) { showOverlay('pause'); game.paused = game.mode === 'solo'; }
    }
    if (game.overlay && input.take('back')) { if (game.overlay === 'settings') showOverlay('pause'); else if (game.overlay === 'pause') { hideOverlay(); game.paused = false; } }
    if (!game.overlay) {
      if (input.take('reset')) { crashAt = 0; respawn(); }
      if (input.take('restart')) restart();
      if (input.take('camera')) game.camMode = game.camMode === 'fpv' ? 'chase' : 'fpv';
      if (input.take('tiltUp')) { settings.camTilt = Math.min(60, settings.camTilt + 5); saveSettings(settings); }
      if (input.take('tiltDown')) { settings.camTilt = Math.max(0, settings.camTilt - 5); saveSettings(settings); }
      if (input.take('mode')) { settings.flightMode = settings.flightMode === 'acro' ? 'angle' : 'acro'; saveSettings(settings); banner(settings.flightMode === 'acro' ? 'ACRO' : 'ANGLE', '', 900); }
      if (input.take('confirm') && game.sock && game.room && game.room.state === 'lobby') {
        const me = game.pilots.get(game.myId);
        if (me) { me.info.ready = !me.info.ready; game.sock.send({ t: 'ready', v: me.info.ready }); renderRoomPanel(); sound.beep(me.info.ready ? 880 : 440, 0.1, 0.15); }
      }
    }

    // official start: the server picks the moment, we go on the tone
    if (r && r.official && r.phase === 'grid' && game.sock && game.sock.serverNow() >= r.goAt) {
      r.phase = 'live'; r.t0 = performance.now() - (game.sock.serverNow() - r.goAt);
      quad.armed = true;
      sound.tone(); banner('GO', '', 900);
    }
    readControls();
    // time trial and warm-up: the clock starts when the quad lifts
    if (r && !r.official && r.phase === 'grid' && ctl.throttle > quad.hoverThrottle * 0.6) { r.phase = 'live'; r.t0 = performance.now(); }

    if (!game.paused) {
      acc += dt;
      const cfg = { mode: settings.flightMode, rates: settings.rates };
      while (acc >= DT) {
        prevPos.copy(quad.pos);
        quad.step(ctl, cfg);
        checkGates();
        acc -= DT;
      }
      if (quad.crashed && crashAt && performance.now() - crashAt > 1500) { crashAt = 0; respawn(); }
      recordGhost(dt);
      netSend(dt);
    }
    sound.motor(game.paused ? 0 : quad.motor);
  } else {
    acc = 0;
  }

  updateRemotes(dt);
  playGhost();

  // own drone and camera
  if (myDrone) {
    myDrone.position.copy(quad.pos); myDrone.quaternion.copy(quad.quat);
    spinProps(myDrone, flying ? quad.motor : 0, dt);
  }
  if (!flying) {
    // slow orbit around the quad on the start pad
    orbit += dt * 0.12;
    camera.fov = 38;
    camera.position.set(quad.pos.x + Math.sin(orbit) * 0.75, 0.36 + Math.sin(orbit * 0.7) * 0.1, quad.pos.z + Math.cos(orbit) * 0.75);
    camera.lookAt(quad.pos.x, quad.pos.y + 0.02, quad.pos.z);
    // keep the quad clear of the menu cards: shift the picture to the right on wide screens
    if (innerWidth > 1000) camera.setViewOffset(innerWidth, innerHeight, -innerWidth * 0.3, innerHeight * 0.05, innerWidth, innerHeight); else camera.clearViewOffset();
    if (myDrone) myDrone.visible = true;
  } else if (game.camMode === 'fpv' && !quad.crashed) {
    camera.clearViewOffset();
    camera.fov = settings.fov;
    _tilt.setFromAxisAngle(_x, THREE.MathUtils.degToRad(settings.camTilt));
    camera.quaternion.copy(quad.quat).multiply(_tilt);
    camera.position.copy(quad.pos).add(_v.set(0, 0.035, -0.07).applyQuaternion(quad.quat));
    if (myDrone) myDrone.visible = false;
  } else {
    camera.clearViewOffset();
    camera.fov = 60;
    _v.set(0, 0, 1).applyQuaternion(quad.quat); _v.y = 0;
    if (_v.lengthSq() < 0.01) _v.set(0, 0, 1);
    _v.normalize().multiplyScalar(1.25); _v.y = 0.42;
    _v2.copy(quad.pos).add(_v);
    chase.lerp(_v2, 1 - Math.exp(-dt * 6));
    if (chase.distanceTo(quad.pos) > 12) chase.copy(_v2);
    camera.position.copy(chase); camera.lookAt(quad.pos);
    if (myDrone) myDrone.visible = true;
  }
  camera.updateProjectionMatrix();

  if (flying) { osdT += dt; if (osdT > 1 / 20) { osdT = 0; updateOSD(); } updateArrow(); updateSticks(); }

  if (composer) {
    lensPass.enabled = settings.lens && flying && game.camMode === 'fpv';
    composer.render(dt);
  } else renderer.render(scene, camera);
  input.endFrame();
}

function updateSticks() {
  // always drawn as mode 2 would look on the pilot's own radio layout
  const ch = input.ch, m = settings.stickMode;
  const L = m === 1 ? [ch.yaw, ch.pitch] : m === 2 ? [ch.yaw, ch.throttle] : m === 3 ? [ch.roll, ch.throttle] : [ch.roll, ch.pitch];
  const R = m === 1 ? [ch.roll, ch.throttle] : m === 2 ? [ch.roll, ch.pitch] : m === 3 ? [ch.yaw, ch.pitch] : [ch.yaw, ch.throttle];
  const set = (el, v) => { el.style.left = `${50 + v[0] * 42}%`; el.style.top = `${50 - v[1] * 42}%`; };
  set($('st-l'), L); set($('st-r'), R);
}

function updateOSD() {
  const r = game.race;
  const cell = quad.volts / QUAD.cells;
  $('o-volt').textContent = `${quad.volts.toFixed(1)}V ${cell.toFixed(2)}`;
  $('o-volt').style.color = cell < 3.5 ? '#ff6b6b' : '';
  $('o-mah').textContent = `${Math.round(quad.mah)} mAh`;
  $('o-speed').textContent = Math.round(quad.vel.length() * 3.6);
  $('o-alt').textContent = Math.max(0, quad.pos.y - QUAD.radius).toFixed(1);
  $('o-thr').textContent = `THR ${Math.round(quad.throttle * 100)}%`;
  $('o-mode').textContent = settings.flightMode === 'acro' ? 'ACRO' : 'ANGLE';
  $('o-tilt').textContent = `CAM ${settings.camTilt}°`;
  if (r) {
    const live = r.phase === 'live';
    const t = r.phase === 'done' ? r.finished : live ? performance.now() - r.t0 - (r.official ? 0 : r.lapStart) : 0;
    $('o-timer').textContent = fmt(t);
    $('o-lap').textContent = r.official ? `LAP ${Math.min(r.lap + 1, r.totalLaps)}/${r.totalLaps}` : game.mode === 'room' ? 'WARM-UP' : `LAP ${r.lap + 1}`;
    $('o-last').textContent = r.last != null ? `LAST ${fmt(r.last)}` : '';
    const best = r.official ? r.best : (ghost ? Math.min(ghost.ms, r.best ?? Infinity) : r.best);
    $('o-best').textContent = best != null ? `BEST ${fmt(best)}` : '';
  }
  // standings
  const el = $('standings');
  if (game.mode === 'room' && r && r.official) {
    const rows = [...game.pilots.values()].filter((p) => p.info.racing).sort((a, b) =>
      (b.prog.finish != null) - (a.prog.finish != null) || (a.prog.finish ?? 0) - (b.prog.finish ?? 0) || b.prog.gates - a.prog.gates || a.prog.ms - b.prog.ms);
    el.innerHTML = rows.map((p, i) => `<li class="${p.info.id === game.myId ? 'me' : ''}">${i + 1} ${esc(p.info.name)} ${p.prog.finish != null ? fmt(p.prog.finish) : `L${Math.min(p.prog.lap + 1, r.totalLaps)}`}<i style="background:${p.info.color}"></i></li>`).join('');
  } else if (el.innerHTML) el.innerHTML = '';
}

function updateArrow() {
  const r = game.race, el = $('gate-arrow');
  if (!r || r.phase === 'done' || game.camMode !== 'fpv') { el.style.opacity = 0; return; }
  const g = world.gates[r.next];
  _v.copy(g.cV).project(camera);
  const behind = _v2.copy(g.cV).sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) < 0;
  let x = _v.x, y = _v.y;
  if (behind) { x = -x; y = -y; }
  const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
  if (!off) { el.style.opacity = 0; return; }
  if (behind) { const l = Math.hypot(x, y) || 1; x = (x / l) * 2; y = (y / l) * 2; }
  const s = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.84, 1);
  x /= s; y /= s;
  const ang = Math.atan2(x, y);
  el.style.opacity = 1;
  el.style.transform = `translate(${(x * 0.5 + 0.5) * innerWidth - 17}px, ${(-y * 0.5 + 0.5) * innerHeight - 17}px)`;
  el.firstElementChild.style.transform = `rotate(${ang}rad)`;
  $('gate-dist').textContent = `${Math.round(g.cV.distanceTo(quad.pos))}m`;
}

// ---------- boot ----------
async function boot() {
  initHome();
  initSettingsUI({
    get: () => settings,
    set: (s) => { settings = s; input.settings = s; saveSettings(s); sound.setVolume(s.volume); describeControls(); },
    defaults: DEFAULTS, input,
    onDone: () => { if (game.screen === 'home') { showOverlay(null); $('home').classList.add('active'); } else showOverlay('pause'); },
  });
  sound.setVolume(settings.volume);
  paintGlyphs(input.device);
  describeControls();
  await loadDroneModel();
  myDrone = makeDrone('#ff3b3b'); scene.add(myDrone);
  ghostDrone = makeDrone('#ffffff'); ghostDrone.visible = false;
  ghostDrone.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; o.castShadow = false; } });
  scene.add(ghostDrone);
  toGrid(0);
  chase.copy(quad.pos);
  await initAuth();
  loadLeaderboard();
  $('loading').remove();
  if (game.bot) { const { makeBot } = await import('./bot.js'); game.botFn = makeBot(game); }
  const code = (params.get('room') || '').toUpperCase();
  if (/^[A-Z0-9]{4,8}$/.test(code)) { $('join-code').value = code; if (game.user) joinRoom(code, false); }
  if (params.get('solo') === '1') startSolo();
  frame();
}
boot().catch((e) => { $('loading').textContent = `Could not start: ${e.message}`; console.error(e); });
