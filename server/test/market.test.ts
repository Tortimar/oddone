import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INGREDIENTS, MARKET, MARKET_STARTS, PLACE_POINTS, STALLS, stallFront, stallInReach } from '@oddone/shared';
import { MarketSim } from '../src/minigames/market.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}
const humans = (n: number, imposter = -1) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, bot: false, imposter: i === imposter, start: MARKET_STARTS[i] }));

/** Va chercher les ingrédients de la recette puis livre. */
function cook(sim: MarketSim, id: string, recipe = sim.currentRecipe) {
  for (const item of recipe) {
    const i = sim.state.stalls.indexOf(item);
    sim.setHumanPosition(id, ...stallFront(i));
    assert.ok(sim.action(id, 'pick'));
  }
  sim.setHumanPosition(id, 0.5, 2);
  return sim.action(id, 'deliver');
}

test('les échoppes : une par ingrédient, autour de la marmite, à portée depuis leur devant', () => {
  assert.equal(STALLS.length, INGREDIENTS.length);
  STALLS.forEach((_, i) => assert.equal(stallInReach(...stallFront(i)), i));
  assert.equal(stallInReach(0, 0), -1);
});

test('une manche : recette montrée puis cachée, livraisons 5-3-2-1, mauvaise recette = panier perdu', () => {
  const sim = new MarketSim(humans(4), seeded(1));
  const s = sim.state;
  assert.equal(s.round, 1);
  assert.equal(s.stage, 'show');
  assert.deepEqual(s.recipe, sim.currentRecipe);
  assert.equal(new Set(s.stalls).size, INGREDIENTS.length, 'chaque ingrédient sur une échoppe');
  assert.equal(sim.action('p0', 'pick'), false, 'pas avant la fin de la recette');
  sim.step(MARKET.showMs + 10);
  assert.equal(s.stage, 'hunt');
  assert.equal(s.recipe, null, 'la recette est cachée');
  // p3 se trompe d'ingrédient
  const wrong = INGREDIENTS.map((i) => i.id).filter((x) => !sim.currentRecipe.includes(x));
  assert.ok(cook(sim, 'p3', [sim.currentRecipe[0], sim.currentRecipe[1], wrong[0]]));
  assert.deepEqual(s.carry.p3, []);
  assert.equal(s.delivered.includes('p3'), false);
  for (const id of ['p1', 'p0', 'p2', 'p3']) assert.ok(cook(sim, id));
  assert.deepEqual(s.delivered, ['p1', 'p0', 'p2', 'p3']);
  assert.deepEqual([s.points.p1, s.points.p0, s.points.p2, s.points.p3], [5, 3, 2, 1]);
  sim.step(50);
  assert.equal(s.stage, 'pause', 'tout le monde a livré : fin de manche');
  sim.step(MARKET.pauseMs + 10);
  assert.equal(s.round, 2);
  assert.equal(s.stage, 'show');
});

test("l'imposteur transforme un produit en ingrédient de la recette, une fois par manche", () => {
  const sim = new MarketSim(humans(2, 0), seeded(2));
  sim.step(MARKET.showMs + 10);
  const decoy = sim.state.stalls.findIndex((x) => !sim.currentRecipe.includes(x));
  sim.setHumanPosition('p1', ...stallFront(decoy));
  assert.equal(sim.action('p1', 'transform'), false, 'réservé à l’imposteur');
  sim.setHumanPosition('p0', ...stallFront(decoy));
  assert.ok(sim.action('p0', 'transform'));
  assert.ok(sim.currentRecipe.includes(sim.state.carry.p0[0]));
  assert.equal(sim.action('p0', 'transform'), false, 'une seule fois par manche');
});

test('cinq manches avec des bots, classement final 4-3-2-1', () => {
  const rnd = seeded(5);
  const sim = new MarketSim([0, 1, 2, 3].map((i) => ({ id: `b${i}`, bot: true, imposter: i === 0, start: MARKET_STARTS[i] })), rnd);
  let done = false, rounds = new Set<number>();
  for (let i = 0; i < sim.maxMs / 50 && !done; i++) { done = sim.step(50).done; rounds.add(sim.state.round); }
  assert.ok(done);
  assert.deepEqual([...rounds], [1, 2, 3, 4, 5]);
  const total = Object.values(sim.state.points).reduce((a, b) => a + b, 0);
  assert.ok(total >= 5 * 5, `les bots livrent (${total} points de manche)`);
  const res = sim.results();
  assert.equal(res[0].rank, 1);
  assert.equal(res[0].points, PLACE_POINTS[0]);
});
