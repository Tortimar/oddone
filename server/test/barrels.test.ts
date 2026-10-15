import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BARRELS, BARREL_STARTS, BarrelField, FINISH_S, PLACE_POINTS, RAMP, RAMP_LENGTH, barrelHits, locate, predictBarrel, rampFloor, rampPoint, respawnS,
  type Barrel,
} from '@oddone/shared';
import { BarrelSim } from '../src/minigames/barrels.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

test("la rampe : continue, et (s, u) se retrouve à partir d'un point du monde", () => {
  for (let s = 0; s < RAMP_LENGTH; s += 0.1) {
    for (const u of [-2.4, -1.2, 0, 1.2, 2.4]) {
      const a = rampPoint(s, u), b = rampPoint(s + 0.1, u);
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.25, `saut de position en s=${s.toFixed(1)}`);
      assert.ok(Math.abs(a.y - b.y) < 0.05);
      const l = locate(a.x, a.z, s - 0.4);
      assert.ok(Math.abs(l.s - s) < 1e-6 && Math.abs(l.u - u) < 1e-6, `locate(${s.toFixed(1)}, ${u})`);
    }
  }
  assert.equal(RAMP.filter((g) => g.kind === 'run').length, BARRELS.runs);
  assert.equal(rampFloor(1), 0);
  assert.equal(rampFloor(FINISH_S + 1), BARRELS.runs + 1);
  // de l'autre côté de la paroi, on reste dans sa montée (u hors des bornes) : pas de raccourci
  const p = rampPoint(14, 0);
  const across = locate(p.x, p.z - 5.4, 14);
  assert.ok(Math.abs(across.s - 14) < 0.5 && Math.abs(across.u) > BARRELS.width / 2);
});

test('les tonneaux : partent du haut, restent entre les parois, se cognent et sortent par le bas', () => {
  const field = new BarrelField(), rnd = seeded(9);
  let elapsed = 0, spawned = new Set<number>(), gone = 0;
  for (let i = 0; i < 1800; i++) {
    const before = new Set(field.barrels.map((b) => b.id));
    field.step(50, elapsed, rnd); elapsed += 50;
    for (const b of field.barrels) {
      spawned.add(b.id);
      if (b.s >= 0) assert.ok(Math.abs(b.u) <= BARRELS.width / 2 - BARRELS.radius + 1e-6, 'dans la rampe');
      assert.ok(Math.abs(b.vs) <= BARRELS.maxSpeed + 1e-6);
    }
    for (const id of before) if (!field.barrels.some((b) => b.id === id)) gone++;
  }
  assert.ok(spawned.size > 40, `${spawned.size} tonneaux lancés`);
  assert.ok(gone > 20, 'ils sortent par le bas');
  // prédiction : le tonneau descend
  const b: Barrel = { id: 1, s: 60, u: 0, vs: -3, vu: 2 };
  const path = predictBarrel(b, 1.5);
  assert.ok(path.length >= 8 && path[path.length - 1][0] < 60);
});

test('écrasé par un tonneau : on repart du début du tronçon ; en sautant par-dessus, non', () => {
  const sim = new BarrelSim([{ id: 'h', bot: false, imposter: false, start: BARREL_STARTS[0] }], seeded(2));
  const s = 12, p = rampPoint(s, 0);
  sim.setHumanPosition('h', p.x, p.z, p.y);
  sim.field.barrels = [{ id: 99, s: s + 0.3, u: 0, vs: -1, vu: 0 }];
  // en l'air : le tonneau passe dessous
  sim.setHumanPosition('h', p.x, p.z, p.y + 1.4);
  assert.ok(!barrelHits(sim.field.barrels[0], p.x, p.z, 1.4));
  sim.setHumanPosition('h', p.x, p.z, p.y);
  sim.step(50);
  const st = sim.ramp.h;
  assert.equal(st.crushes, 1);
  assert.equal(st.respawnS, respawnS(s));
  assert.ok(st.respawnS < s);
  // juste après, il est intouchable un moment
  sim.field.barrels = [{ id: 100, s: s + 0.2, u: 0, vs: -1, vu: 0 }];
  sim.step(50);
  assert.equal(st.crushes, 1);
});

test('quatre bots grimpent : la partie se termine, classement et points', () => {
  const sim = new BarrelSim(BARREL_STARTS.map((start, k) => ({ id: `b${k}`, bot: true, imposter: k === 0, start: [start[0], start[1]] as [number, number] })), seeded(11));
  let t = 0;
  while (!sim.step(50).done) { t += 50; assert.ok(t <= BARRELS.maxDurationMs, 'trop long'); }
  const res = sim.results();
  assert.equal(res.length, 4);
  assert.ok(Object.values(sim.ramp).filter((s) => s.finishedAt !== null).length >= 3, 'trois arrivés');
  assert.deepEqual(res.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(res.map((r) => r.points), [...PLACE_POINTS]);
  assert.ok(Object.values(sim.ramp).some((s) => s.crushes > 0), 'les tonneaux écrasent');
});
