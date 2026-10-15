import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOMB, BOMB_STARTS, PLACE_POINTS, makeMaze, mazeBoxes, mazeCanGo, mazeDistances } from '@oddone/shared';
import { BombSim } from '../src/minigames/bomb.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...BOMB_STARTS[k]] as [number, number] };
  });

/** Avance jusqu'à ce que `ok` soit vrai (ou échoue). */
function until(sim: BombSim, ok: () => boolean, maxMs = 200_000): void {
  for (let t = 0; t < maxMs; t += 50) { if (ok()) return; sim.step(50); }
  assert.fail('délai dépassé');
}

test('labyrinthe : toutes les cases sont reliées, bords fermés, salle ouverte au centre, des boucles', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const m = makeMaze(seeded(seed));
    const d = mazeDistances(m, [0, 0]);
    assert.ok(d.every((k) => k >= 0), 'tout est accessible');
    for (let c = 0; c < m.cols; c++) { assert.equal(m.h[c], 1); assert.equal(m.h[m.rows * m.cols + c], 1); }
    for (let r = 0; r < m.rows; r++) { assert.equal(m.v[r * (m.cols + 1)], 1); assert.equal(m.v[r * (m.cols + 1) + m.cols], 1); }
    const c0 = m.cols / 2 - 1, r0 = m.rows / 2 - 1;
    assert.ok(mazeCanGo(m, c0, r0, 1, 0) && mazeCanGo(m, c0, r0, 0, 1) && mazeCanGo(m, c0 + 1, r0 + 1, -1, 0) && mazeCanGo(m, c0 + 1, r0 + 1, 0, -1), 'salle du centre');
    // un arbre aurait exactement cols × rows − 1 passages : les boucles en ajoutent
    const passages = m.h.filter((w) => !w).length + m.v.filter((w) => !w).length;
    assert.ok(passages > m.cols * m.rows - 1, 'des boucles pour fuir');
    assert.ok(mazeBoxes(m).length > 40, 'des murs');
  }
});

test('passer la bombe en touchant quelqu’un : il est étourdi et ne la renvoie pas tout de suite', () => {
  const sim = new BombSim(makeMaze(seeded(3)), entrants(2, ['a', 'b']), seeded(7));
  const s = sim.state;
  assert.equal(s.rounds, 1, 'à deux : une seule manche');
  assert.equal(s.stage, 'intro');
  const holder = s.holder!, other = holder === 'a' ? 'b' : 'a';
  // pendant l'intro, rien ne passe
  sim.setHumanPosition(holder, 0, 0); sim.setHumanPosition(other, 0.5, 0);
  sim.step(50);
  assert.equal(s.holder, holder);
  until(sim, () => s.stage === 'play');
  sim.step(50);
  assert.equal(s.holder, other, 'passée au contact');
  assert.ok(s.stunned[other] > sim.elapsed, 'étourdi');
  assert.deepEqual([s.pass!.from, s.pass!.to], [holder, other]);
  sim.step(50);
  assert.equal(s.holder, other, 'pas de renvoi immédiat');
  sim.step(BOMB.passCooldownMs);
  assert.equal(s.holder, holder, 'après le délai, elle peut revenir');
  // plus personne à portée : la mèche finit par brûler
  sim.setHumanPosition(holder, -12, -12); sim.setHumanPosition(other, 12, 12);
  until(sim, () => s.critical);
  until(sim, () => sim.isFinished);
  assert.deepEqual(s.out, [holder]);
  assert.deepEqual(s.alive, [other]);
  const res = sim.results();
  assert.deepEqual(res.map((r) => [r.id, r.rank, r.points]), [[other, 1, PLACE_POINTS[0]], [holder, 2, PLACE_POINTS[1]]]);
});

test('à quatre : trois manches, un éliminé par manche, chacun réapparaît dans un coin', () => {
  const sim = new BombSim(makeMaze(seeded(11)), entrants(4, [], 'b2'), seeded(5));
  const s = sim.state;
  assert.equal(s.rounds, 3);
  const seenRounds: number[] = [];
  until(sim, () => {
    if (!seenRounds.includes(s.round)) {
      seenRounds.push(s.round);
      assert.equal(Object.keys(s.spawns).length, s.alive.length, 'un coin par survivant');
      assert.ok(s.holder && s.alive.includes(s.holder));
    }
    return sim.isFinished;
  });
  assert.deepEqual(seenRounds, [1, 2, 3]);
  assert.equal(s.out.length, 3);
  assert.equal(s.alive.length, 1);
  assert.deepEqual(Object.values(s.outRound).sort(), [1, 2, 3]);
  const res = sim.results();
  assert.deepEqual(res.map((r) => r.rank), [1, 2, 3, 4]);
  assert.equal(res[0].id, s.alive[0]);
  assert.equal(res[3].id, s.out[0], 'le premier éliminé est dernier');
  assert.ok(sim.elapsed <= sim.maxMs);
});

test('les bots se passent la bombe en se poursuivant dans le labyrinthe', () => {
  let passes = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const sim = new BombSim(makeMaze(seeded(seed)), entrants(4), seeded(seed * 13));
    let last = sim.state.pass;
    until(sim, () => { if (sim.state.pass !== last) { passes++; last = sim.state.pass; } return sim.isFinished; });
  }
  assert.ok(passes >= 3, `la bombe circule (${passes} passes)`);
});

test('un joueur qui part : la bombe change de main, la partie se termine s’il ne reste qu’un joueur', () => {
  const sim = new BombSim(makeMaze(seeded(2)), entrants(3, ['a', 'b', 'c']), seeded(4));
  const s = sim.state, h = s.holder!;
  sim.remove(h);
  assert.ok(s.holder && s.holder !== h && s.alive.includes(s.holder));
  sim.remove(s.alive[0]);
  assert.ok(sim.isFinished);
});
