// Loads the quad model once and hands out copies, one per pilot.
// Model: "Fpv Racing Drone Quadcopter" by eagleanurag, CC BY 4.0. See CREDITS.md.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const WHEELBASE = 0.225; // metres, motor to motor across the diagonal (5 inch frame)
let template = null;

export async function loadDroneModel() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync('/models/fpv-drone.glb');
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // find the four props: they are the nodes the model's own animation spins
  const propNames = new Set(gltf.animations.flatMap((a) => a.tracks).filter((t) => t.name.endsWith('.quaternion')).map((t) => t.name.split('.')[0]));
  const props = [];
  root.traverse((o) => { if (propNames.has(o.name) && o.name.startsWith('polySurface')) props.push(o); });
  const centres = props.map((p) => new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()));
  const mid = centres.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, centres.length));
  let diag = 0;
  for (const a of centres) for (const b of centres) diag = Math.max(diag, a.distanceTo(b));
  const scale = diag > 0 ? WHEELBASE / diag : 0.42;

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (o.material && o.material.name === 'mycheckered') { o.material.color.setScalar(0.32); o.material.roughness = 0.45; o.material.metalness = 0.2; }
  });

  // centre on the props, shrink to real size, and turn the nose to -Z (the model faces +Z)
  const inner = new THREE.Group();
  root.position.copy(mid).multiplyScalar(-1);
  inner.add(root);
  inner.scale.setScalar(scale);
  inner.rotation.y = Math.PI;
  const holder = new THREE.Group();
  holder.add(inner);
  holder.userData.propNames = props.map((p) => p.name);
  template = holder;
  return holder;
}

export function makeDrone(color) {
  const g = template.clone(true);
  const props = [];
  const propMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const names = new Set(template.userData.propNames);
  g.traverse((o) => {
    if (names.has(o.name)) {
      props.push(o);
      o.traverse((c) => { if (c.isMesh) c.material = propMat; });
    }
  });
  // tail light in the pilot's colour so you can tell quads apart at a distance
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), new THREE.MeshBasicMaterial({ color }));
  led.position.set(0, 0.012, 0.085);
  g.add(led);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(0.07); glow.material.opacity = 0.7; glow.position.copy(led.position);
  g.add(glow);
  // prop discs: what a spinning prop looks like to the eye
  const discMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false });
  const discs = [];
  g.userData = { props, discs, discMat, spin: 0 };
  return g;
}

let _glow = null;
function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}

// Spin the props. motor is 0..1.
export function spinProps(drone, motor, dt) {
  const rate = motor > 0.01 ? 40 + motor * 260 : 0; // rad/s, slowed so it reads on screen
  const props = drone.userData.props;
  for (let i = 0; i < props.length; i++) props[i].rotateY((i % 2 ? 1 : -1) * rate * dt);
}

export function nameTag(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.font = '600 30px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const w = Math.min(240, x.measureText(name).width + 28);
  x.fillStyle = 'rgba(10,13,18,0.7)'; x.beginPath(); x.roundRect(128 - w / 2, 10, w, 44, 10); x.fill();
  x.fillStyle = color; x.fillRect(128 - w / 2, 50, w, 4);
  x.fillStyle = '#fff'; x.fillText(name, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, sizeAttenuation: false }));
  s.scale.set(0.17, 0.0425, 1); s.renderOrder = 10;
  return s;
}
