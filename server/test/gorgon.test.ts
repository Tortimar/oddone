import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GORGON, GORGON_STARTS, PLACE_POINTS, gorgonSees, makeGorgonField, type GorgonField, type GorgonSecret } from '@oddone/shared';
import { GorgonSim } from '../src/minigames/gorgon.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...GORGON_STARTS[k]] as [number, number] };
  });

const empty: GorgonField = { covers: [] };

function until(sim: GorgonSim, ok: () => boolean, maxMs = 120_000): void {
  for (let t = 0; t < maxMs; t += 50) { if (ok()) return; sim.step(50); }
  assert.fail('délai dépassé');
}

test('le cimetière : des tombes entre le départ et l’arrivée, larges côté Gorgone', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const f = makeGorgonField(seeded(seed));
    assert.ok(f.covers.length >= 6 && f.covers.length <= 16, 'de quoi se cacher, sans plus');
    for (const c of f.covers) {
      assert.ok(c.z > GORGON.graveZ[0] - 1 && c.z < GORGON.graveZ[1] + 1, 'ni sur le départ ni sur l’arrivée');
      if (c.kind !== 'statue') assert.ok(c.hx >= c.hz, 'côté large vers elle');
    }
  }
});

test('ligne de vue : une tombe ou un joueur entre elle et toi te cache', () => {
  const grave = { kind: 'grave_A' as const, x: 0, z: 0, rot: 0, hx: 1.25, hz: 0.6, seed: 1 };
  assert.equal(gorgonSees({ x: 0, z: 1.5 }, [grave], []), false, 'collé derrière la tombe');
  assert.equal(gorgonSees({ x: 0, z: 8 }, [grave], []), true, 'une tombe loin devant ne cache pas');
  assert.equal(gorgonSees({ x: 4, z: 3 }, [grave], []), true, 'à côté');
  assert.equal(gorgonSees({ x: 0, z: 3 }, [], [{ x: 0, z: 1.5 }]), false, 'juste derrière un joueur');
  assert.equal(gorgonSees({ x: 0, z: 9 }, [], [{ x: 0, z: 1 }]), true, 'un joueur loin devant ne cache pas');
  assert.equal(gorgonSees({ x: 0, z: 3 }, [], [{ x: 0, z: 6 }]), true, 'un joueur derrière soi ne cache rien');
});

test('qui bouge pendant qu’elle regarde est pétrifié ; immobile ou caché, on ne risque rien', () => {
  const sim = new GorgonSim(empty, entrants(3, ['a', 'b', 'c']), seeded(4));
  const s = sim.state;
  // (de dos : b se place devant c, entre elle et lui)
  sim.setHumanPosition('b', 0, 10); sim.setHumanPosition('c', 0, 11.2);
  until(sim, () => s.stage === 'watch');
  sim.step(GORGON.graceMs + 50); // le regard commence à compter
  sim.step(50);
  // a bouge en vue, b reste immobile, c bouge mais caché derrière b
  sim.setHumanPosition('a', GORGON_STARTS[0][0] + 1, GORGON.startZ);
  sim.step(50);
  sim.setHumanPosition('c', 0.2, 11.4); sim.step(50); sim.setHumanPosition('c', -0.2, 11.6); sim.step(50);
  assert.deepEqual(s.petrified, ['a']);
  assert.ok(s.stone.a);
  // une fois pétrifié, on ne bouge plus (les positions envoyées sont ignorées)
  sim.setHumanPosition('a', 0, 0);
  assert.notEqual(sim.position('a')!.z, 0);
});

test('de dos, on avance sans risque ; l’arrivée donne la place ; le premier pétrifié est dernier', () => {
  const sim = new GorgonSim(empty, entrants(3, ['a', 'b', 'c']), seeded(9));
  const s = sim.state;
  assert.equal(s.stage, 'back');
  sim.setHumanPosition('a', 0, GORGON.finishZ - 0.5);
  sim.step(50);
  assert.deepEqual(s.finished, ['a']);
  until(sim, () => s.stage === 'watch');
  sim.step(GORGON.graceMs + 100);
  sim.setHumanPosition('b', 3, 3); sim.step(50); sim.setHumanPosition('b', 3, 2); sim.step(50);
  assert.deepEqual(s.petrified, ['b']);
  sim.setHumanPosition('c', 0, GORGON.finishZ - 1); sim.step(50);
  assert.ok(!sim.isFinished, 'deux secondes pour voir la fin');
  sim.step(2000);
  assert.ok(sim.isFinished, 'plus personne ne court');
  assert.deepEqual(sim.results().map((r) => [r.id, r.rank, r.points]), [['a', 1, PLACE_POINTS[0]], ['c', 2, PLACE_POINTS[1]], ['b', 3, PLACE_POINTS[2]]]);
});

test('l’imposteur apprend quand elle va se retourner, à chaque fois', () => {
  const sim = new GorgonSim(empty, entrants(2, ['a', 'b'], 'b'), seeded(2));
  const got: GorgonSecret[] = [];
  for (let t = 0; t < 20_000; t += 50) { sim.step(50); for (const sec of sim.secrets()) { assert.equal(sec.to, 'b'); got.push(sec.data); } }
  assert.ok(got.length >= 3);
  // (le premier secret part dès le constructeur ; on vérifie les suivants : ils annoncent le futur)
  const sim2 = new GorgonSim(empty, entrants(2, ['a', 'b'], 'b'), seeded(2));
  const first = sim2.secrets()[0].data.turnAt;
  until(sim2, () => sim2.state.stage === 'turning');
  assert.ok(Math.abs(sim2.state.stageAt - first) <= 50, 'au bon moment');
});

test('bots : ils avancent, se font parfois prendre ; la partie se termine', () => {
  let arrived = 0, stones = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const sim = new GorgonSim(makeGorgonField(seeded(seed)), entrants(4, [], 'b1'), seeded(seed * 7));
    until(sim, () => sim.isFinished);
    arrived += sim.state.finished.length; stones += sim.state.petrified.length;
    assert.equal(sim.results().length, 4);
  }
  assert.ok(arrived >= 12, `des bots arrivent (${arrived})`);
  assert.ok(stones >= 2, `des bots sont pétrifiés (${stones})`);
});

test('pousser un bot pendant qu’elle regarde le fait bouger… et le pétrifie', () => {
  const sim = new GorgonSim(empty, entrants(2, ['a']), seeded(3));
  const s = sim.state;
  until(sim, () => s.stage === 'watch');
  sim.step(GORGON.graceMs + 300);
  assert.equal(s.petrified.length, 0, 'le bot s’est arrêté à temps… ou pas : on vérifie seulement la poussée');
  sim.knock('b1', [0, -1]);
  for (let i = 0; i < 10; i++) sim.step(50);
  assert.ok(s.petrified.includes('b1') || s.stage !== 'watch');
});
