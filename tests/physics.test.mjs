import * as THREE from 'three';
import { Quad, DT, QUAD, actualRate } from '../src/physics.js';
const cfg = { mode: 'acro', rates: { roll:{center:70,max:670,expo:0}, pitch:{center:70,max:670,expo:0}, yaw:{center:70,max:670,expo:0} } };
console.log('rates', actualRate(0.5,70,670,0).toFixed(0), actualRate(1,70,670,0).toFixed(0));
// hover check
let q = new Quad(); q.armed = true; q.reset(new THREE.Vector3(0,50,0)); q.grounded=false;
for (let i=0;i<2000;i++) q.step({throttle:q.hoverThrottle,roll:0,pitch:0,yaw:0},cfg);
console.log('hover thr', q.hoverThrottle.toFixed(3), 'vy after 4s', q.vel.y.toFixed(2));
// vertical punch
q = new Quad(); q.armed = true; q.reset(new THREE.Vector3(0,1,0)); q.grounded=false;
for (let i=0;i<500;i++) q.step({throttle:1,roll:0,pitch:0,yaw:0},cfg);
console.log('punch 1s: vy', q.vel.y.toFixed(1), 'alt', q.pos.y.toFixed(1), 'V', q.volts.toFixed(1), 'A', q.amps.toFixed(0));
// top speed at different tilt
for (const tilt of [50,60,70,80]) {
  q = new Quad(); q.armed = true; q.reset(new THREE.Vector3(0,200,0)); q.grounded=false;
  q.quat.setFromAxisAngle(new THREE.Vector3(1,0,0), -tilt*Math.PI/180);
  for (let i=0;i<500*8;i++) q.step({throttle:1,roll:0,pitch:0,yaw:0},cfg);
  console.log('tilt',tilt,'speed km/h', (Math.hypot(q.vel.x,q.vel.z)*3.6).toFixed(0), 'vy', q.vel.y.toFixed(1), 'mah', q.mah.toFixed(0));
}
// flip time
q = new Quad(); q.armed = true; q.reset(new THREE.Vector3(0,50,0)); q.grounded=false;
let ang=0,t=0; while(ang<2*Math.PI){ q.step({throttle:0.3,roll:1,pitch:0,yaw:0},cfg); ang+=Math.abs(q.omega.z)*DT; t+=DT;}
console.log('full roll time s', t.toFixed(2));
