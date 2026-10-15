import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseMap, GORGE, GORGE_STARTS, NORMAL_CONTROLS, PLACE_POINTS, makeGorgeCourse, scrambledControls } from '@oddone/shared';
import { GorgeRaceSim } from '../src/minigames/gorge.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

/** Chemin le plus court case par case depuis (i, j) jusqu'à l'arrivée. */
function route(map: CourseMap, i: number, j: number): [number, number][] {
  const out: [number, number][] = [[i, j]];
  while (map.distAt(i, j) > 0) {
    const next = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([a, b]) => [i + a, j + b] as [number, number])
      .filter(([a, b]) => map.distAt(a, b) < map.distAt(i, j))[0];
    [i, j] = next; out.push([i, j]);
  }
  return out;
}

test("le parcours : d'un seul tenant, 3 ponts, chemins d'une case, arrivée accessible de chaque départ", () => {
  for (let s = 1; s < 40; s++) {
    const course = makeGorgeCourse(seeded(s));
    const map = new CourseMap(course);
    assert.equal(course.bridges.length, GORGE.sections - 1);
    for (const [i, j] of course.cells) assert.ok(Number.isFinite(map.distAt(i, j)), `case (${i},${j}) isolée`);
    for (const [x, z] of GORGE_STARTS) { const [i, j] = CourseMap.cellOf(x, z); assert.ok(Number.isFinite(map.distAt(i, j))); }
    // les ponts n'ont qu'une case de large
    for (const b of course.bridges) for (let j = b.j0; j <= b.j1; j++) { assert.ok(!map.has(b.i - 1, j) && !map.has(b.i + 1, j)); }
    for (const [, , k] of course.cells) assert.ok(['start', 'path', 'landing', 'bridge', 'finish'].includes(k));
  }
});

test('commandes mélangées : une direction de chaque, jamais les normales', () => {
  const rnd = seeded(5);
  for (let k = 0; k < 50; k++) {
    const c = scrambledControls(rnd);
    assert.deepEqual([...c].sort(), [...NORMAL_CONTROLS].sort());
    assert.notDeepEqual(c, NORMAL_CONTROLS);
  }
});

test("un pont = checkpoint + tornade ; l'imposteur garde ses commandes ; l'arrivée exige tous les ponts", () => {
  const course = makeGorgeCourse(seeded(3));
  const map = new CourseMap(course);
  const sim = new GorgeRaceSim(course, [
    { id: 'hero', bot: false, imposter: false, start: GORGE_STARTS[0] },
    { id: 'imp', bot: false, imposter: true, start: GORGE_STARTS[1] },
  ], seeded(4));
  const [fx, fz] = course.finishCenter;
  sim.setHumanPosition('hero', fx, fz); // téléporté à l'arrivée : ne compte pas
  assert.equal(sim.race.hero.finishedAt, null);
  for (const id of ['hero', 'imp']) {
    for (const [x, z] of route(map, ...CourseMap.cellOf(...GORGE_STARTS[0])).map(([i, j]) => CourseMap.center(i, j))) {
      sim.step(20);
      sim.setHumanPosition(id, x, z);
    }
  }
  assert.equal(sim.race.hero.cp, course.bridges.length);
  assert.notDeepEqual(sim.race.hero.controls, NORMAL_CONTROLS);
  assert.deepEqual(sim.race.imp.controls, NORMAL_CONTROLS);
  assert.ok(sim.race.hero.tornadoAt !== null && sim.race.imp.tornadoAt !== null, "l'imposteur tourne aussi (pour ne pas se trahir)");
  assert.ok(sim.race.hero.finishedAt !== null && sim.race.imp.finishedAt !== null);
  assert.ok(sim.race.hero.finishedAt! < sim.race.imp.finishedAt!);
  const done = sim.step(20).done;
  assert.ok(done, 'tout le monde est arrivé');
  const res = sim.results();
  assert.deepEqual(res.map((r) => [r.id, r.rank, r.points]), [['hero', 1, PLACE_POINTS[0]], ['imp', 2, PLACE_POINTS[1]]]);
});

test('les bots font la course (chutes comprises) et finissent par arriver', () => {
  for (const seed of [1, 2, 3]) {
    const rnd = seeded(seed);
    const course = makeGorgeCourse(rnd);
    const sim = new GorgeRaceSim(course, [0, 1, 2, 3].map((i) => ({ id: `b${i}`, bot: true, imposter: i === 0, start: GORGE_STARTS[i] })), rnd);
    let done = false;
    for (let i = 0; i < GORGE.maxDurationMs / 50 + 5 && !done; i++) done = sim.step(50).done;
    assert.ok(done);
    const res = sim.results();
    assert.ok(Object.values(sim.race).some((r) => r.finishedAt !== null), `au moins un bot arrive (graine ${seed})`);
    assert.equal(res[0].rank, 1);
    assert.ok(res.every((r, i) => i === 0 || r.rank >= res[i - 1].rank));
  }
});

test('un bot poussé hors du chemin tombe puis repart du dernier pont', () => {
  const course = makeGorgeCourse(seeded(9));
  const sim = new GorgeRaceSim(course, [{ id: 'b', bot: true, imposter: false, start: GORGE_STARTS[0] }], seeded(1));
  sim.step(50);
  sim.knock('b', [-1, 0]); // vers le vide, à gauche du départ
  for (let i = 0; i < 20; i++) sim.step(50);
  const r = sim.racers.get('b')!;
  assert.ok(r.y < -1, 'il tombe');
  for (let i = 0; i < 40; i++) sim.step(50);
  assert.equal(r.y, 0);
  assert.ok(new CourseMap(course).walkable(r.x, r.z), 'de retour sur le parcours');
});

test('la course ne s’arrête que quand les 3 premiers sont arrivés', () => {
  const course = makeGorgeCourse(seeded(11));
  const map = new CourseMap(course);
  const ids = ['a', 'b', 'c', 'd'];
  const sim = new GorgeRaceSim(course, ids.map((id, i) => ({ id, bot: false, imposter: false, start: GORGE_STARTS[i] })), seeded(2));
  const path = route(map, ...CourseMap.cellOf(...GORGE_STARTS[0])).map(([i, j]) => CourseMap.center(i, j));
  for (const id of ['a', 'b']) for (const [x, z] of path) { sim.setHumanPosition(id, x, z); sim.step(10); }
  assert.equal(sim.step(10).done, false, 'deux arrivés : on continue');
  sim.elapsed += 120_000;
  assert.equal(sim.step(10).done, false, 'même longtemps après');
  for (const [x, z] of path) { sim.setHumanPosition('c', x, z); }
  assert.equal(sim.step(10).done, true, 'le troisième arrive : fin');
  assert.deepEqual(sim.results().map((r) => r.rank), [1, 2, 3, 4]);
});

test('un pont traversé entre deux positions reçues compte quand même', () => {
  const course = makeGorgeCourse(seeded(8));
  const map = new CourseMap(course);
  const sim = new GorgeRaceSim(course, [{ id: 'h', bot: false, imposter: false, start: GORGE_STARTS[0] }], seeded(1));
  const b = course.bridges[0];
  // juste avant le pont, puis juste après (deux positions perdues en route)
  sim.setHumanPosition('h', ...CourseMap.center(b.i, b.j0 - 1));
  sim.setHumanPosition('h', ...CourseMap.center(b.i, b.j1 + 1));
  assert.equal(sim.race.h.cp, 1);
  assert.ok(map.walkable(...CourseMap.center(b.i, b.j1 + 1)));
});
