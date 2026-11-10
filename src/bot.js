// A simple autopilot for testing (open the game with ?bot=1). It flies angle mode
// toward each gate in turn. It is not fast, it is there to prove a lap can be flown.
import * as THREE from 'three';

export function makeBot(game) {
  const f = new THREE.Vector3(), r = new THREE.Vector3(), aim = new THREE.Vector3(), d = new THREE.Vector3();
  let stage = 0, lastNext = -1;
  return (ctl) => {
    const { quad, world, race } = game;
    if (!race) return;
    game.input.settings.flightMode = 'angle';
    const g = world.gates[race.next];
    if (race.next !== lastNext) { lastNext = race.next; stage = 0; }
    const along = d.copy(quad.pos).sub(g.cV).dot(g.nV);
    const lateral = d.copy(quad.pos).sub(g.cV).addScaledVector(g.nV, -along).length();
    // line up on the approach point first, then drive through
    if (stage === 0 && along > -9 && along < -1.5 && lateral < 0.7) stage = 1;
    if (stage === 1 && (lateral > 2.2 || along > 0.5)) stage = 0;
    aim.copy(g.cV).addScaledVector(g.nV, stage === 0 ? -6 : 4);
    f.set(0, 0, -1).applyQuaternion(quad.quat); f.y = 0; f.normalize();
    r.set(1, 0, 0).applyQuaternion(quad.quat); r.y = 0; r.normalize();
    d.copy(aim).sub(quad.pos);
    const dy = d.y; d.y = 0;
    const dist = d.length(); d.normalize();
    const yawErr = Math.atan2(d.dot(r), d.dot(f));
    const vf = quad.vel.dot(f), vr = quad.vel.dot(r);
    const want = stage === 1 ? 7 : Math.min(9, 1.5 + dist * 0.8) * Math.max(0, Math.cos(yawErr));
    ctl.yaw = THREE.MathUtils.clamp(yawErr * 1.6, -1, 1);
    ctl.pitch = THREE.MathUtils.clamp((want - vf) * 0.12, -0.6, 0.6);
    ctl.roll = THREE.MathUtils.clamp(-vr * 0.18 + (stage === 1 ? d.dot(r) * dist * 0.25 : 0), -0.5, 0.5);
    const climb = THREE.MathUtils.clamp(dy * 1.4, -3, 3.5) - quad.vel.y;
    ctl.throttle = THREE.MathUtils.clamp(quad.hoverThrottle * 1.08 + climb * 0.09, 0, 1);
  };
}
