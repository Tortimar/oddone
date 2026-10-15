import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACE_POINTS, SKELETON_BALL as SB, skeletonCount, skeletonSpeed, makeSkeletonArena, arenaBoxes } from '@oddone/shared';
import { SkeletonBallSim } from '../src/minigames/skeletonBall.ts';

/** Générateur pseudo-aléatoire reproductible. */
function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const empty = { graves: [] };

test('les squelettes arrivent 1, puis 2, puis 3… et restent plus lents que les joueurs', () => {
  assert.equal(skeletonCount(0), 0);
  assert.equal(skeletonCount(SB.firstSpawnMs), 1);
  assert.equal(skeletonCount(SB.firstSpawnMs + SB.spawnEveryMs), 2);
  assert.equal(skeletonCount(SB.firstSpawnMs + 2 * SB.spawnEveryMs), 3);
  assert.equal(skeletonCount(10 * 60_000), SB.maxSkeletons);
  assert.ok(skeletonSpeed(10 * 60_000) < SB.playerSpeed);
  assert.ok(skeletonSpeed(10 * 60_000) < SB.playerSpeed * SB.cursedSpeedMul + 1); // un maudit reste dans la course
});

test('le cimetière : des tombes réparties, le centre de départ dégagé', () => {
  for (let s = 1; s < 30; s++) {
    const arena = makeSkeletonArena(seeded(s));
    assert.ok(arena.graves.length >= 10);
    for (const b of arenaBoxes(arena)) {
      assert.ok(b.x0 > -SB.bounds.halfX && b.x1 < SB.bounds.halfX && b.z0 > -SB.bounds.halfZ && b.z1 < SB.bounds.halfZ);
      for (const [x, z] of [[-1.8, -1.2], [1.8, -1.2], [-1.8, 1.6], [1.8, 1.6]]) {
        assert.ok(x < b.x0 - 0.6 || x > b.x1 + 0.6 || z < b.z0 - 0.6 || z > b.z1 + 0.6, 'départ libre');
      }
    }
  }
});

test('un joueur touché devient maudit et touche à son tour', () => {
  const sim = new SkeletonBallSim(empty, [
    { id: 'a', bot: false, imposter: false, start: [0, 0] },
    { id: 'b', bot: false, imposter: false, start: [6, 0] },
    { id: 'c', bot: false, imposter: false, start: [-8, -6] },
  ], seeded(1));
  // a reste immobile : le premier squelette finit par le toucher
  let caughtA = false;
  for (let i = 0; i < 400 && !caughtA; i++) caughtA = sim.step(50).caught.some((c) => c.id === 'a' && c.by === null);
  assert.ok(caughtA);
  // on éloigne les squelettes pour ne tester que le contact entre joueurs
  const away = () => { for (const s of sim.skeletons) { s.x = -11; s.z = 8; } };
  const a = sim.players.get('a')!;
  away();
  sim.setHumanPosition('b', a.x + 0.4, a.z);
  // pendant qu'il est sonné, a ne touche personne
  assert.deepEqual(sim.step(50).caught, []);
  sim.elapsed += SB.curseStunMs;
  away();
  const res = sim.step(50);
  assert.ok(res.caught.some((c) => c.id === 'b' && c.by === 'a'), 'b touché par a, maudit');
});

test('classement : le dernier libre gagne, places et points', () => {
  const sim = new SkeletonBallSim(empty, [
    { id: 'a', bot: false, imposter: false, start: [0, 0] },
    { id: 'b', bot: false, imposter: false, start: [5, 5] },
  ], seeded(2));
  let done = false;
  for (let i = 0; i < 4000 && !done; i++) done = sim.step(50).done;
  assert.ok(done, 'la partie se termine quand il ne reste qu’un joueur libre');
  const res = sim.results();
  assert.equal(res[0].rank, 1);
  assert.equal(res[1].rank, 2);
  assert.deepEqual(res.map((r) => r.points), [PLACE_POINTS[0], PLACE_POINTS[1]]);
  assert.ok(res[0].survivedMs >= res[1].survivedMs);
});

test("avantage de l'imposteur : les squelettes préfèrent une autre proie", () => {
  const sim = new SkeletonBallSim(empty, [
    { id: 'imp', bot: false, imposter: true, start: [0, 3] },
    { id: 'hero', bot: false, imposter: false, start: [0, -5] },
  ], seeded(3));
  sim.skeletons.push({ x: 0, z: 0, yaw: 0, spawnedAt: -10_000 });
  sim.step(200);
  assert.ok(sim.skeletons[0].z < -0.5, "il part vers le héros, plus loin que l'imposteur");
  // mais un imposteur vraiment tout près reste une proie
  sim.players.get('imp')!.z = sim.skeletons[0].z + 1.2; sim.players.get('imp')!.x = 0;
  const before = sim.skeletons[0].z;
  sim.step(100);
  assert.ok(sim.skeletons[0].z > before);
});

test('les bots fuient et survivent un moment ; une partie de bots se termine', () => {
  const rnd = seeded(7);
  const sim = new SkeletonBallSim(makeSkeletonArena(rnd), [0, 1, 2, 3].map((i) => ({
    id: `bot${i}`, bot: true, imposter: i === 0, start: [[-1.8, -1.2], [1.8, -1.2], [-1.8, 1.6], [1.8, 1.6]][i] as [number, number],
  })), rnd);
  let done = false;
  for (let i = 0; i < SB.maxDurationMs / 50 + 10 && !done; i++) done = sim.step(50).done;
  assert.ok(done);
  const res = sim.results();
  assert.ok(res[0].survivedMs > 8000, `le meilleur bot tient plus de 8 s (${res[0].survivedMs} ms)`);
  for (const p of sim.players.values()) {
    assert.ok(Math.abs(p.x) <= SB.bounds.halfX && Math.abs(p.z) <= SB.bounds.halfZ);
  }
});
