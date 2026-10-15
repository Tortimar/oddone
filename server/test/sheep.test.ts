import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOCK_Z, PLACE_POINTS, SHEEP, SHEEP_STARTS } from '@oddone/shared';
import { SheepSim } from '../src/minigames/sheep.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...SHEEP_STARTS[k]] as [number, number] };
  });

test('le troupeau erre sur le chemin, sans sortir ni se chevaucher', () => {
  const sim = new SheepSim(entrants(1, ['a']), seeded(3));
  const before = sim.flock.map((s) => [s.x, s.z]);
  for (let i = 0; i < 200; i++) sim.step(50);
  let moved = 0;
  sim.flock.forEach((s, i) => {
    assert.ok(Math.abs(s.x) <= SHEEP.halfX - SHEEP.radius + 1e-6, 'entre les murets');
    assert.ok(s.z >= FLOCK_Z[0] - 3 && s.z <= FLOCK_Z[1] + 2);
    if (Math.hypot(s.x - before[i][0], s.z - before[i][1]) > 0.5) moved++;
  });
  assert.ok(moved > SHEEP.count / 2, 'ils bougent au hasard');
  for (const a of sim.flock) for (const b of sim.flock) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > SHEEP.radius * 1.6);
  const t = sim.tick();
  assert.equal(t.sh!.length, SHEEP.count);
});

test('les moutons s’écartent de l’imposteur', () => {
  const near = (imposter: string) => {
    let total = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const sim = new SheepSim(entrants(1, ['a'], imposter), seeded(seed));
      for (let i = 0; i < 160; i++) {
        sim.setHumanPosition('a', 0, 0); // planté au milieu du troupeau
        sim.step(50);
      }
      total += sim.flock.filter((s) => Math.hypot(s.x, s.z) < SHEEP.shyRadius - 1).length;
    }
    return total;
  };
  assert.ok(near('a') < near(''), 'moins de moutons autour de lui');
  assert.equal(near('a'), 0);
});

test('arrivée : l’ordre d’arrivée fait le classement ; les autres selon leur avance', () => {
  const sim = new SheepSim(entrants(3, ['a', 'b', 'c']), seeded(2));
  sim.setHumanPosition('b', 0, SHEEP.finishZ + 0.5); sim.step(50);
  sim.setHumanPosition('a', 1, SHEEP.finishZ + 0.2); sim.step(50);
  sim.setHumanPosition('c', 0, 10); sim.step(50);
  assert.deepEqual(sim.state.finished, ['b', 'a']);
  assert.ok(!sim.isFinished);
  sim.setHumanPosition('a', 0, 0); // une fois arrivé, on ne repart pas
  assert.equal(sim.position('a')!.z, SHEEP.finishZ + 0.2);
  for (let i = 0; i < SHEEP.maxMs / 50; i++) { if (sim.isFinished) break; sim.step(50); }
  assert.deepEqual(sim.results().map((r) => [r.id, r.rank, r.points]), [['b', 1, PLACE_POINTS[0]], ['a', 2, PLACE_POINTS[1]], ['c', 3, PLACE_POINTS[2]]]);
});

test('les bots traversent le troupeau sans le pousser, et finissent par arriver', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const sim = new SheepSim(entrants(4), seeded(seed));
    for (let i = 0; i < SHEEP.maxMs / 50 && !sim.isFinished; i++) {
      sim.step(50);
      for (const r of sim.runners.values()) if (!r.done) for (const s of sim.flock) assert.ok(Math.hypot(r.x - s.x, r.z - s.z) > SHEEP.radius, 'pas dans un mouton');
    }
    assert.equal(sim.state.finished.length, 4, `tous arrivés (graine ${seed})`);
    assert.ok(sim.elapsed > 15_000, 'les moutons ralentissent la course');
  }
});
