import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HORDE, HORDE_STARTS, PLACE_POINTS, slashHits } from '@oddone/shared';
import { HordeSim } from '../src/minigames/horde.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

test("coup d'épée : devant et à portée seulement, 1 point (3 pour un doré), recharge", () => {
  assert.ok(slashHits(0, 0, 0, 0, 1.5), 'devant');
  assert.ok(!slashHits(0, 0, 0, 0, -1.5), 'derrière');
  assert.ok(!slashHits(0, 0, 0, 0, HORDE.slash.reach + 0.2), 'trop loin');
  assert.ok(slashHits(0, 0, Math.PI, 0.2, -0.3), 'collé : touché');
  const sim = new HordeSim([{ id: 'h', bot: false, imposter: false, start: [0, 0] }], seeded(1));
  sim.setHumanPosition('h', 0, 0, 0, 0);
  sim.goblins.push({ id: 900, gold: false, x: 0, z: 1.4, yaw: 0, anim: 'Idle', hitReadyAt: 0, busyUntil: 0 });
  sim.goblins.push({ id: 901, gold: true, x: 0.6, z: 1.6, yaw: 0, anim: 'Idle', hitReadyAt: 0, busyUntil: 0 });
  assert.equal(sim.action('h', 'slash'), true);
  assert.equal(sim.state.points.h, 4, 'deux gobelins d’un coup : 1 + 3');
  assert.deepEqual(sim.state.kills.h, [1, 1]);
  assert.equal(sim.state.events.length, 2);
  sim.goblins.push({ id: 902, gold: false, x: 0, z: 1, yaw: 0, anim: 'Idle', hitReadyAt: 0, busyUntil: 0 });
  assert.equal(sim.action('h', 'slash'), false, 'recharge');
  sim.step(HORDE.slash.cooldownMs + 10);
  assert.equal(sim.action('h', 'slash'), true);
});

test("les gobelins dorés sortent surtout du côté de l'imposteur", () => {
  let near = 0, far = 0;
  for (let s = 1; s <= 12; s++) {
    const sim = new HordeSim([
      { id: 'imp', bot: false, imposter: true, start: [0, 0] },
      { id: 'h', bot: false, imposter: false, start: [0, 0] },
    ], seeded(s));
    sim.setHumanPosition('imp', 10, 0); // à l'est
    sim.setHumanPosition('h', -10, 0);
    const seen = new Set<number>();
    for (let t = 0; t < 60_000; t += 50) {
      sim.step(50);
      for (const g of sim.goblins) {
        if (seen.has(g.id) || !g.gold) continue;
        seen.add(g.id);
        if (Math.hypot(g.x, g.z) > HORDE.spawnRadius - 0.5) (g.x > 0 ? near++ : far++);
      }
      sim.goblins.length = 0; // personne ne bouge : on vide pour compter les apparitions
    }
  }
  assert.ok(near > far * 2.5, `côté imposteur ${near}, ailleurs ${far}`);
});

test('quatre bots : la partie dure le temps prévu, classement et points', () => {
  const sim = new HordeSim(HORDE_STARTS.map((start, k) => ({ id: `b${k}`, bot: true, imposter: k === 0, start: [start[0], start[1]] as [number, number] })), seeded(4));
  let t = 0, hits = 0;
  for (;;) { const r = sim.step(50); hits += r.hits.length; t += 50; if (r.done) break; }
  assert.ok(Math.abs(t - HORDE.durationMs) <= 50);
  const res = sim.results();
  assert.equal(res.length, 4);
  assert.ok(Object.values(sim.state.points).reduce((a, b) => a + b, 0) > 20, 'les bots tuent des gobelins');
  assert.ok(hits > 0, 'les gobelins frappent');
  for (const r of res) assert.equal(r.points, PLACE_POINTS[r.rank - 1]);
  assert.ok(res[0].survivedMs >= res[res.length - 1].survivedMs);
});

test("un coup d'épée étourdit un autre joueur ; étourdi, on ne frappe plus ; les gobelins étourdissent aussi", () => {
  const sim = new HordeSim([
    { id: 'a', bot: false, imposter: false, start: [0, 0] },
    { id: 'b', bot: false, imposter: false, start: [0, 2] },
  ], seeded(2));
  sim.setHumanPosition('a', 0, 0, 0, 0); // tourné vers b
  sim.setHumanPosition('b', 0, 2, 0, 0);
  assert.equal(sim.action('a', 'slash'), false, 'pas de gobelin tué');
  const r = sim.step(10);
  assert.equal(r.hits.length, 1, 'le coup part au pas suivant');
  assert.equal(r.hits[0].from, 'a'); assert.equal(r.hits[0].to, 'b');
  assert.deepEqual(sim.state.points, { a: 0, b: 0 }, 'pas de point pour un joueur');
  sim.goblins.push({ id: 7, gold: false, x: 0, z: 3, yaw: 0, anim: 'Idle', hitReadyAt: 0, busyUntil: 0 });
  assert.equal(sim.action('b', 'slash'), false, 'étourdi : pas de coup');
  assert.equal(sim.goblins.length, 1);
  // pendant l'étourdissement (et le répit), un gobelin collé ne le frappe pas
  sim.goblins[0].z = 2.6;
  let hitsOnB = 0;
  for (let t = 0; t < HORDE.stunMs + HORDE.stunGraceMs - 100; t += 50) hitsOnB += sim.step(50).hits.filter((h) => h.to === 'b').length;
  assert.equal(hitsOnB, 0);
  for (let t = 0; t < 400; t += 50) hitsOnB += sim.step(50).hits.filter((h) => h.to === 'b' && h.from.startsWith('gob-')).length;
  assert.equal(hitsOnB, 1, 'puis le gobelin le frappe et l’étourdit');
  assert.equal(sim.action('b', 'slash'), false);
});
