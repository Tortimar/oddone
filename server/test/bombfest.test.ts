import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEST, FEST_STARTS, PLACE_POINTS, festBox, festBoxAt, festSortArg } from '@oddone/shared';
import { FestSim } from '../src/minigames/bombfest.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...FEST_STARTS[k]] as [number, number] };
  });

/** Trie à la place d'un humain toutes les bombes arrivées sur son plateau (dans la bonne boîte). */
function sortAll(sim: FestSim, id: string): void {
  for (const b of [...sim.state.boards[id].bombs]) if (sim.elapsed >= b.at) sim.action(id, 'sort', festSortArg(b.id, b.color));
}

test('les boîtes : une par couleur dans les coins de chaque plateau, retrouvées sous le curseur', () => {
  for (let slot = 0; slot < 4; slot++) for (let c = 0; c < 4; c++) {
    const [x, z] = festBox(slot, c);
    assert.equal(festBoxAt(slot, [0, 1, 2, 3], x, z), c);
    assert.equal(festBoxAt(slot, [0, 1, 2, 3], x + 0.5, z - 0.5), c);
  }
  assert.equal(festBoxAt(0, [0, 1, 2, 3], -9.6, -6.3), -1, 'le milieu du plateau n’est pas une boîte');
});

test('trier : la bonne boîte seulement, une bombe non triée en 3 s fait sauter le plateau', () => {
  const sim = new FestSim(entrants(2, ['a', 'b']), seeded(3));
  const s = sim.state;
  assert.deepEqual(s.colors, [0, 1]);
  for (let i = 0; i < 60 && !s.boards.a.bombs.some((b) => sim.elapsed >= b.at); i++) sim.step(50);
  const bomb = s.boards.a.bombs.find((b) => sim.elapsed >= b.at)!;
  const wrong = bomb.color === 0 ? 1 : 0;
  assert.equal(sim.action('a', 'sort', festSortArg(bomb.id, wrong)), false, 'mauvaise boîte');
  assert.equal(sim.action('a', 'sort', festSortArg(bomb.id, bomb.color)), true);
  assert.equal(s.boards.a.boxes[bomb.color], 1);
  assert.equal(s.boards.a.sorted, 1);
  assert.equal(sim.action('a', 'sort', festSortArg(bomb.id, bomb.color)), false, 'déjà triée');
  // a continue de trier, b ne fait rien : b saute, puis la partie s'arrête (2 s après)
  for (let i = 0; i < 200 && !s.out.length; i++) { sortAll(sim, 'a'); sim.step(50); }
  assert.deepEqual(s.out, ['b']);
  assert.equal(s.boards.b.bombs.length, 0);
  for (let i = 0; i < 60 && !sim.isFinished; i++) { sortAll(sim, 'a'); sim.step(50); }
  assert.ok(sim.isFinished);
  assert.deepEqual(sim.results().map((r) => [r.id, r.rank, r.points]), [['a', 1, PLACE_POINTS[0]], ['b', 2, PLACE_POINTS[1]]]);
});

test('une boîte pleine envoie ses bombes au joueur de sa couleur, une à une', () => {
  const sim = new FestSim(entrants(2, ['a', 'b']), seeded(5));
  const s = sim.state;
  // on remplit à la main la boîte de b sur le plateau de a
  s.boards.a.boxes[1] = FEST.capacity - 1;
  s.boards.a.bombs.push({ id: 999, color: 1, at: 0, x: -9.6, z: -6.3, from: -1 });
  const before = s.boards.b.bombs.length;
  assert.equal(sim.action('a', 'sort', festSortArg(999, 1)), true);
  assert.equal(s.boards.a.boxes[1], 0, 'la boîte se vide');
  const sent = s.boards.b.bombs.slice(before);
  assert.equal(sent.length, FEST.capacity);
  assert.ok(sent.every((b) => b.color === 1 && b.from === 0));
  const last = FEST.capacity - 1;
  assert.ok(sent[last].at - sent[0].at >= last * FEST.sendGapMs - 1, 'elles arrivent une à une');
  assert.equal(s.sends.at(-1)!.to, 'b');
});

test('ses propres couleurs partent chez les autres ; l’imposteur range les siennes n’importe où', () => {
  const sim = new FestSim(entrants(3, ['a', 'b', 'c'], 'a'), seeded(7));
  const s = sim.state;
  s.boards.a.boxes[0] = FEST.capacity - 1;
  s.boards.a.bombs.push({ id: 900, color: 0, at: 0, x: -9.6, z: -6.3, from: -1 });
  const nb = s.boards.b.bombs.length, nc = s.boards.c.bombs.length;
  assert.equal(sim.action('a', 'sort', festSortArg(900, 0)), true);
  assert.equal(s.boards.b.bombs.length - nb + s.boards.c.bombs.length - nc, FEST.capacity, 'chez les autres');
  // imposteur : une bombe de sa couleur (0) dans la boîte de b (1)
  s.boards.a.bombs.push({ id: 901, color: 0, at: 0, x: -9.6, z: -6.3, from: -1 });
  assert.equal(sim.action('a', 'sort', festSortArg(901, 1)), true);
  assert.equal(s.boards.a.boxes[1], 1, 'elle prend la couleur de la boîte');
  // un autre joueur ne peut pas le faire
  s.boards.b.bombs.push({ id: 902, color: 0, at: 0, x: 9.6, z: -6.3, from: -1 });
  assert.equal(sim.action('b', 'sort', festSortArg(902, 1)), false);
});

test('bots : ils trient, se renvoient des bombes, finissent par sauter ; la cadence monte', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const sim = new FestSim(entrants(4), seeded(seed));
    for (let i = 0; i < FEST.maxMs / 50 && !sim.isFinished; i++) sim.step(50);
    const s = sim.state;
    assert.ok(s.out.length >= 3, `trois bots sautent (graine ${seed}, ${Math.round(sim.elapsed / 1000)} s)`);
    assert.ok(s.sends.length > 0, 'des boîtes pleines partent');
    assert.ok(Object.values(s.boards).every((b) => b.sorted > 5));
    assert.deepEqual(sim.results().map((r) => r.rank), [1, 2, 3, 4]);
  }
});
