// The flying field: sky, ground, trees, gates and the colliders that go with them.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { resolveGates, gridSlot } from '../shared/tracks.js';

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function grassTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const r = rng(7);
  g.fillStyle = '#4c7a34'; g.fillRect(0, 0, 512, 512);
  // mowing stripes
  for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)'; g.fillRect(i * 128, 0, 128, 512); }
  for (let i = 0; i < 26000; i++) {
    const x = r() * 512, y = r() * 512, l = 2 + r() * 4;
    const v = r();
    g.strokeStyle = v < 0.5 ? `rgba(${30 + r() * 30},${70 + r() * 50},${20 + r() * 20},0.55)` : `rgba(${90 + r() * 60},${140 + r() * 60},${50 + r() * 30},0.4)`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 2, y - l); g.stroke();
  }
  for (let i = 0; i < 60; i++) { // worn patches
    const x = r() * 512, y = r() * 512, rad = 8 + r() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(120,105,60,0.22)'); gr.addColorStop(1, 'rgba(120,105,60,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(340, 340);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 32;
  const g = c.getContext('2d');
  for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#f4f4f4' : '#111'; g.fillRect(x * 16, y * 16, 16, 16); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function numberTexture(n) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#10141c'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#fff'; g.font = '700 84px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const GATE_COLORS = { idle: 0x2a6cff, next: 0x38ff7a, after: 0xffb020, done: 0x30384a };

export class World {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.colliders = [];
    this.gates = [];
    this.trackGroup = null;
    const high = quality !== 'low';

    // --- sky and light ---
    const sky = new Sky(); sky.scale.setScalar(9000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.0; u.rayleigh.value = 1.1; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.86;
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(140));
    u.sunPosition.value.copy(sun);
    scene.add(sky);
    this.sunDir = sun;

    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene(); const sky2 = sky.clone(); envScene.add(sky2);
    scene.environment = pm.fromScene(envScene, 0, 1, 10000).texture;
    scene.environmentIntensity = 0.55;
    pm.dispose();

    scene.fog = new THREE.Fog(0xc4d6e8, 420, 2600);
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x4a5a30, 0.9));
    const dl = new THREE.DirectionalLight(0xfff0d8, 3.0);
    dl.position.copy(sun).multiplyScalar(220).add(new THREE.Vector3(25, 0, -15));
    dl.target.position.set(25, 0, -15);
    if (high) {
      dl.castShadow = true;
      dl.shadow.mapSize.set(4096, 4096);
      const sc = dl.shadow.camera; sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 50; sc.far = 420;
      dl.shadow.bias = -0.0004; dl.shadow.normalBias = 0.04;
    }
    scene.add(dl, dl.target);

    // --- ground ---
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1600, 64), new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);

    // --- hills on the horizon ---
    const r = rng(42);
    const hillGeo = new THREE.CylinderGeometry(1250, 1250, 1, 96, 1, true);
    const pos = hillGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        pos.setY(i, 70 + 55 * Math.sin(a * 3 + 1) + 38 * Math.sin(a * 7 + 2) + 22 * Math.sin(a * 13) + r() * 12);
      } else pos.setY(i, -2);
    }
    hillGeo.computeVertexNormals();
    scene.add(new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({ color: 0x4d6b52, roughness: 1, side: THREE.BackSide, flatShading: true })));

    // --- trees around the field ---
    const n = high ? 520 : 200;
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 1, 6), new THREE.MeshStandardMaterial({ color: 0x5b4028, roughness: 1 }), n);
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), n * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 125 + Math.pow(r(), 1.6) * 420;
      const x = 25 + Math.cos(a) * d, z = -15 + Math.sin(a) * d;
      const h = 7 + r() * 9, w = 2.2 + r() * 1.8;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6);
      m.compose(new THREE.Vector3(x, h * 0.15, z), q, new THREE.Vector3(1, h * 0.3, 1)); trunk.setMatrixAt(i, m);
      col.setHSL(0.27 + r() * 0.08, 0.45 + r() * 0.2, 0.2 + r() * 0.12);
      m.compose(new THREE.Vector3(x, h * 0.52, z), q, new THREE.Vector3(w, h * 0.7, w)); crown.setMatrixAt(i * 2, m); crown.setColorAt(i * 2, col);
      m.compose(new THREE.Vector3(x, h * 0.8, z), q, new THREE.Vector3(w * 0.7, h * 0.5, w * 0.7)); crown.setMatrixAt(i * 2 + 1, m); crown.setColorAt(i * 2 + 1, col);
    }
    trunk.castShadow = crown.castShadow = high;
    scene.add(trunk, crown);

    // --- pilot area: canopy, table, chairs ---
    const pit = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.8, side: THREE.DoubleSide });
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.4, metalness: 0.8 });
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.2, 1.1, 4), cloth); roof.rotation.y = Math.PI / 4; roof.position.y = 3.0; pit.add(roof);
    for (const [x, z] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6), metal); leg.position.set(x, 1.25, z); pit.add(leg);
      this.addBox(new THREE.Vector3(-9 + x, 1.25, 12 + z), new THREE.Vector3(0.06, 1.25, 0.06), new THREE.Quaternion());
    }
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.9), new THREE.MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.6 })); table.position.set(0, 0.8, -1); pit.add(table);
    pit.position.set(-9, 0, 12);
    pit.traverse((o) => { if (o.isMesh) { o.castShadow = high; o.receiveShadow = true; } });
    scene.add(pit);

    this.mats = {
      truss: new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.55, metalness: 0.3 }),
      checker: new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.8 }),
      pad: new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.9 }),
      chev: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }),
    };
    this.high = high;
  }

  addBox(center, half, quat) {
    this.colliders.push({ center: center.clone(), half: half.clone(), quat: quat.clone(), inv: quat.clone().invert(), bound: half.length() + 0.3 });
  }

  // Builds the gates for one track. Replaces whatever track was there.
  setTrack(track) {
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      this.trackGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.colliders.length = this.fixedColliders;
    } else this.fixedColliders = this.colliders.length;
    const grp = this.trackGroup = new THREE.Group();
    this.track = track;
    this.gates = [];
    const T = 0.12; // bar thickness
    const frames = resolveGates(track);

    for (const f of frames) {
      const c = V(f.c), r = V(f.r), u = V(f.u), nrm = new THREE.Vector3().crossVectors(r, u);
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, nrm));
      const led = new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: GATE_COLORS.idle, emissiveIntensity: 2.2, roughness: 0.4 });
      const g = new THREE.Group();
      const bar = (lx, ly, sx, sy, mat = this.mats.truss, sz = T, collide = true) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
        mesh.position.copy(c).addScaledVector(r, lx).addScaledVector(u, ly);
        mesh.quaternion.copy(quat);
        mesh.castShadow = this.high; mesh.receiveShadow = true;
        g.add(mesh);
        if (collide) this.addBox(mesh.position, new THREE.Vector3(sx / 2, sy / 2, sz / 2), quat);
        return mesh;
      };
      const w = f.w, h = f.h;
      const vertical = f.type !== 'dive';
      const bottom = c.y - h / 2;
      const toGround = vertical && bottom < 1.0;
      // side bars (run to the ground on low gates), top bar, bottom bar when raised
      const sideLen = toGround ? h + T + bottom : h + 2 * T;
      const sideY = toGround ? (h / 2 + T) - sideLen / 2 : 0;
      for (const s of [-1, 1]) {
        bar(s * (w / 2 + T / 2), sideY, T, sideLen);
        bar(s * (w / 2 + T / 2), sideY, T * 0.5, sideLen - 0.02, led, T + 0.03, false);
      }
      bar(0, h / 2 + T / 2, w, T);
      bar(0, h / 2 + T / 2, w, T * 0.5, led, T + 0.03, false);
      if (!toGround) { bar(0, -h / 2 - T / 2, w, T); bar(0, -h / 2 - T / 2, w, T * 0.5, led, T + 0.03, false); }

      // legs for raised and dive gates
      if (!toGround) {
        const corners = vertical
          ? [[-(w / 2 + T / 2), -h / 2 - T], [w / 2 + T / 2, -h / 2 - T]]
          : [[-(w / 2 + T / 2), -(h / 2 + T / 2)], [w / 2 + T / 2, -(h / 2 + T / 2)], [-(w / 2 + T / 2), h / 2 + T / 2], [w / 2 + T / 2, h / 2 + T / 2]];
        for (const [lx, ly] of corners) {
          const top = c.clone().addScaledVector(r, lx).addScaledVector(u, ly);
          const len = top.y;
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, len, 0.08), this.mats.truss);
          leg.position.set(top.x, len / 2, top.z); leg.castShadow = this.high;
          g.add(leg);
          this.addBox(leg.position, new THREE.Vector3(0.04, len / 2, 0.04), new THREE.Quaternion());
        }
      }
      // banner: checkered on the start gate, a number on the rest
      if (vertical) {
        const bn = new THREE.Mesh(new THREE.BoxGeometry(f.type === 'start' ? w + 2 * T : 0.5, f.type === 'start' ? 0.4 : 0.5, 0.04),
          f.type === 'start' ? this.mats.checker : new THREE.MeshStandardMaterial({ map: numberTexture(f.i), roughness: 0.8 }));
        bn.position.copy(c).addScaledVector(u, h / 2 + T + (f.type === 'start' ? 0.2 : 0.25));
        bn.quaternion.copy(quat);
        g.add(bn);
      }
      grp.add(g);
      this.gates.push({ ...f, cV: c, nV: V(f.n), rV: r, uV: u, led, state: 'idle' });
    }

    // start pads
    for (let i = 0; i < 8; i++) {
      const s = gridSlot(i);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.7), this.mats.pad);
      pad.position.set(s[0], 0.015, s[2]); pad.receiveShadow = true; grp.add(pad);
    }

    // chevrons on the grass showing the line between gates
    const pts = [];
    frames.forEach((f) => {
      const c = V(f.c);
      if (f.type === 'dive') { pts.push(c.clone()); return; }
      const nn = V(f.n);
      pts.push(c.clone().addScaledVector(nn, -5), c.clone().addScaledVector(nn, 5));
    });
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const len = curve.getLength(), count = Math.floor(len / 5);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.55); shape.lineTo(0.5, -0.1); shape.lineTo(0.5, -0.4); shape.lineTo(0, 0.25); shape.lineTo(-0.5, -0.4); shape.lineTo(-0.5, -0.1); shape.closePath();
    const chev = new THREE.InstancedMesh(new THREE.ShapeGeometry(shape), this.mats.chev, count);
    const m4 = new THREE.Matrix4(), e = new THREE.Euler();
    for (let i = 0; i < count; i++) {
      const p = curve.getPointAt(i / count), t = curve.getTangentAt(i / count);
      e.set(-Math.PI / 2, Math.atan2(-t.x, -t.z), 0, 'YXZ');
      m4.makeRotationFromEuler(e); m4.setPosition(p.x, 0.03, p.z);
      chev.setMatrixAt(i, m4);
    }
    chev.renderOrder = 1;
    grp.add(chev);
    this.line = curve;

    this.scene.add(grp);
    this.highlight(0);
  }

  // Light the next gate green and the one after amber.
  highlight(next) {
    const N = this.gates.length;
    this.gates.forEach((g, i) => {
      const st = i === next ? 'next' : i === (next + 1) % N ? 'after' : 'idle';
      if (g.state !== st) {
        g.state = st;
        g.led.emissive.setHex(GATE_COLORS[st]);
        g.led.emissiveIntensity = st === 'next' ? 5.5 : st === 'after' ? 2.6 : 1.6;
      }
    });
  }

  // Did the move from a to b go through gate i the right way?
  passed(i, a, b) {
    const g = this.gates[i];
    const da = a.clone().sub(g.cV).dot(g.nV), db = b.clone().sub(g.cV).dot(g.nV);
    if (!(da < 0 && db >= 0)) return false;
    const t = da / (da - db);
    const hit = a.clone().lerp(b, t).sub(g.cV);
    return Math.abs(hit.dot(g.rV)) <= g.w / 2 + 0.05 && Math.abs(hit.dot(g.uV)) <= g.h / 2 + 0.05;
  }

  // Where to put a pilot who resets: a few metres before the gate they need next.
  respawnPoint(next) {
    const g = this.gates[next];
    if (g.type === 'dive') {
      const p = g.cV.clone().addScaledVector(g.uV, -6); p.y = g.cV.y + 3;
      return { pos: p, yaw: Math.atan2(-g.uV.x, -g.uV.z) };
    }
    const p = g.cV.clone().addScaledVector(g.nV, -7);
    p.y = Math.max(1.2, g.cV.y);
    return { pos: p, yaw: Math.atan2(-g.nV.x, -g.nV.z) };
  }
}
