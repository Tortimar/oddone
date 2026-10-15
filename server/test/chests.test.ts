import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHESTS, CHEST_HOMES, PLACE_POINTS, chestFront } from '@oddone/shared';
import { ChestsSim } from '../src/minigames/chests.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...CHEST_HOMES[k]] as [number, number] };
  });

/** Avance jusqu'à ce que `ok` soit vrai (ou échoue). */
function until(sim: ChestsSim, ok: () => boolean, maxMs = 60_000): void {
  for (let t = 0; t < maxMs; t += 50) { if (ok()) return; sim.step(50); }
  assert.fail('délai dépassé');
}

test('quatre bots : 5 coffres, puis 4, puis 3 ; un éliminé par manche ; classement', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new ChestsSim(entrants(4, [], 'b2'), seeded(seed));
    const counts: number[] = [];
    let t = 0;
    for (;;) {
      if (counts[sim.state.round] === undefined) counts[sim.state.round] = sim.state.count;
      const r = sim.step(50); t += 50;
      if (r.done) break;
      assert.ok(t < 10 * 60_000, 'la partie se termine');
    }
    assert.deepEqual(counts, [5, 4, 3]);
    assert.equal(sim.state.alive.length, 1);
    assert.equal(sim.state.out.length, 3);
    const res = sim.results();
    assert.deepEqual(res.map((r) => r.rank), [1, 2, 3, 4]);
    assert.equal(res[0].id, sim.state.alive[0]);
    assert.equal(res[1].id, sim.state.out[2], 'le dernier éliminé est 2e');
    for (const r of res) assert.equal(r.points, PLACE_POINTS[r.rank - 1]);
  }
});

test("à son tour seulement, devant un coffre ; l'inspection de l'imposteur ne sert qu'une fois", () => {
  const sim = new ChestsSim(entrants(2, ['imp', 'h']), seeded(3));
  // (l'imposteur est désigné à la main ici)
  (sim.seats.get('imp')!).imposter = true;
  until(sim, () => sim.state.stage === 'turn');
  const me = sim.state.turn!, other = me === 'imp' ? 'h' : 'imp';
  const [fx, fz] = chestFront(0, sim.state.count);
  sim.setHumanPosition(other, fx, fz);
  assert.equal(sim.action(other, 'open'), false, 'pas son tour');
  sim.setHumanPosition(me, 0, 9); // loin de tout
  assert.equal(sim.action(me, 'open'), false, 'trop loin');
  sim.setHumanPosition(me, fx, fz);
  assert.equal(sim.action(me, 'inspect'), true);
  assert.equal(sim.state.inspecting?.chest, 0);
  assert.equal(sim.action(me, 'open'), false, 'pas pendant une inspection');
  until(sim, () => !sim.state.inspecting);
  const secrets = sim.secrets();
  assert.equal(secrets.length, me === 'imp' ? 1 : 0, "seul l'imposteur apprend quelque chose");
  if (secrets.length) { assert.equal(secrets[0].to, 'imp'); assert.equal(secrets[0].data.chest, 0); }
  assert.equal(sim.action(me, 'inspect'), false, 'une inspection par tour');
  assert.equal(sim.action(me, 'open'), true);
  assert.equal(sim.state.stage, 'opening');
});

test('trop long : le donjon ouvre un coffre au hasard', () => {
  const sim = new ChestsSim(entrants(2, ['a', 'h']), seeded(5));
  until(sim, () => sim.state.stage === 'turn');
  until(sim, () => sim.state.stage !== 'turn', CHESTS.turnMs + 500);
  assert.equal(sim.state.stage, 'opening');
  assert.ok(sim.state.opening);
});

test("l'imposteur bot se sert de ce qu'il a vu, une fois ; personne d'autre ne reçoit de secret", () => {
  let real = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const sim = new ChestsSim(entrants(4, ['h'], 'b1'), seeded(seed));
    for (let t = 0; t < 10 * 60_000; t += 50) {
      if (sim.state.turn === 'h' && sim.state.stage === 'turn') {
        const [fx, fz] = chestFront(sim.state.count - 1, sim.state.count);
        sim.setHumanPosition('h', fx, fz);
        sim.action('h', 'open');
      }
      if (sim.step(50).done) break;
      real += sim.secrets().length;
    }
    assert.ok(sim.isFinished);
  }
  assert.equal(real, 0, "l'imposteur est un bot : rien à envoyer");
});
