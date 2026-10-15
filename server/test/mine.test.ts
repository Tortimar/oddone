import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINE, MINE_STARTS, PLACE_POINTS, makeMineTracks, raceDistance, raceSpan, raceTime, trackPieces, trackPoint, type MineSecret } from '@oddone/shared';
import { MineSim } from '../src/minigames/mine.ts';

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const entrants = (n: number, humans: string[] = [], imposter = '') =>
  [...Array(n).keys()].map((k) => {
    const id = humans[k] ?? `b${k}`;
    return { id, bot: !humans[k], imposter: id === imposter, start: [...MINE_STARTS[k]] as [number, number] };
  });

function until(sim: MineSim, ok: () => boolean, maxMs = 120_000): void {
  for (let t = 0; t < maxMs; t += 50) { if (ok()) return; sim.step(50); }
  assert.fail('délai dépassé');
}

test('voies : quatre départs en haut, sorties en bas, longueurs distinctes, croisements à angle droit', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const tracks = makeMineTracks(seeded(seed));
    assert.equal(tracks.length, MINE.wagons);
    const starts = tracks.map((t) => t.cells[0][0]);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'wagon 1 à gauche');
    assert.equal(new Set(starts).size, 4);
    assert.equal(new Set(tracks.map((t) => t.cells[t.cells.length - 1][0])).size, 4, 'sorties distinctes');
    const lens = tracks.map((t) => t.length).sort((a, b) => a - b);
    for (let i = 1; i < 4; i++) assert.ok(lens[i] - lens[i - 1] >= MINE.cell * 1.5, 'longueurs bien séparées');
    // chaque case : un seul morceau, ou deux lignes droites perpendiculaires
    const use = new Map<string, string[]>();
    for (const t of tracks) {
      assert.equal(t.cells[0][1], -1); assert.equal(t.cells[t.cells.length - 1][1], MINE.rows);
      for (const p of trackPieces(t.cells)) {
        if (p.row < 0 || p.row >= MINE.rows) continue;
        const k = `${p.col},${p.row}`;
        use.set(k, [...(use.get(k) ?? []), p.straight ? (p.a % 2 === 0 ? 'V' : 'H') : 'C']);
      }
      // cases voisines à chaque pas
      for (let i = 1; i < t.cells.length; i++) {
        const [c0, r0] = t.cells[i - 1], [c1, r1] = t.cells[i];
        assert.equal(Math.abs(c0 - c1) + Math.abs(r0 - r1), 1);
      }
    }
    for (const kinds of use.values()) {
      if (kinds.length === 1) continue;
      assert.deepEqual([...kinds].sort(), ['H', 'V']);
    }
  }
});

test('trajectoire : continue le long du rail, du quai à la sortie', () => {
  const [t] = makeMineTracks(seeded(7));
  const pieces = trackPieces(t.cells);
  let prev = trackPoint(pieces, 0);
  for (let d = 0.05; d <= t.length; d += 0.05) {
    const p = trackPoint(pieces, d);
    assert.ok(Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.06, `saut à d=${d.toFixed(2)}`);
    prev = p;
  }
  const [a, b] = raceSpan(t);
  assert.equal(raceDistance(t, 0, false), a);
  assert.equal(raceDistance(t, raceTime(t, false), false), b);
  assert.ok(raceTime(t, true) > raceTime(t, false) * 1.5, 'le maudit est bien plus lent');
});

test('quatre bots : trois manches, chacun dans un wagon, arrivées et classement', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sim = new MineSim(entrants(4, [], 'b1'), seeded(seed));
    const stages: string[] = [];
    let t = 0;
    for (;;) {
      const st = `${sim.state.round}:${sim.state.stage}`;
      if (stages[stages.length - 1] !== st) stages.push(st);
      if (sim.state.stage === 'race') {
        assert.equal(Object.keys(sim.state.picks).length, 4, 'tout le monde à bord');
        assert.equal(new Set(Object.values(sim.state.picks)).size, 4, 'un joueur par wagon');
        assert.ok(sim.state.cursed !== null);
      }
      if (sim.state.stage === 'curse' || sim.state.stage === 'pick') assert.equal(sim.state.cursed, null, 'malédiction secrète');
      const r = sim.step(50); t += 50;
      if (r.done) break;
      assert.ok(t < sim.maxMs, 'la partie se termine');
    }
    assert.deepEqual(stages.filter((s) => s.endsWith(':race')), ['0:race', '1:race', '2:race']);
    assert.equal(sim.state.history.length, 3);
    // points de manche : 4-3-2-1 selon la place (ex aequo possibles : même place, mêmes points)
    const expect: Record<string, number> = {};
    for (const places of sim.state.history) {
      assert.equal(Object.keys(places).length, 4);
      for (const [id, pl] of Object.entries(places)) expect[id] = (expect[id] ?? 0) + MINE.roundPoints[pl - 1];
    }
    assert.deepEqual(sim.state.points, expect);
    const res = sim.results();
    for (const r of res) assert.equal(r.points, PLACE_POINTS[r.rank - 1]);
    // le classement suit les points de manche
    for (let i = 1; i < res.length; i++) assert.ok(sim.state.points[res[i - 1].id] >= sim.state.points[res[i].id]);
  }
});

test('humain imposteur : malédiction secrète, confirmée à lui seul ; wagons exclusifs ; retardataire placé', () => {
  const sim = new MineSim(entrants(3, ['h', 'g'], 'h'), seeded(3));
  until(sim, () => sim.state.stage === 'curse');
  assert.equal(sim.action('g', 'curse', 2), false);
  assert.deepEqual(sim.secrets(), [], 'un héros ne maudit rien');
  assert.equal(sim.action('h', 'curse', 1), false, 'rien de public ne change');
  assert.deepEqual(sim.secrets(), [{ to: 'h', data: { round: 0, cursed: 1 } satisfies MineSecret }]);
  assert.equal(sim.action('h', 'board', 0), false, 'pas encore le moment de monter');
  until(sim, () => sim.state.stage === 'pick');
  assert.equal(sim.state.cursed, null);
  assert.equal(sim.action('h', 'board', 3), true);
  assert.equal(sim.action('h', 'board', 2), false, 'on ne change pas de wagon');
  assert.equal(sim.action('g', 'board', 3), false, 'wagon déjà pris');
  assert.equal(sim.action('g', 'board', 9), false);
  // g ne choisit pas : la mine le place
  until(sim, () => sim.state.stage === 'race');
  assert.equal(sim.state.cursed, 1);
  assert.ok('g' in sim.state.picks && sim.state.picks.g !== 3);
  assert.equal(Object.keys(sim.state.arrivals).length, 3);
  for (const [id, w] of Object.entries(sim.state.picks)) {
    assert.equal(sim.state.arrivals[id], Math.round(raceTime(sim.state.tracks[w], w === 1)));
  }
});

test("imposteur qui ne choisit pas : la mine maudit un wagon et le lui dit ; tout le monde à bord : départ anticipé", () => {
  const sim = new MineSim(entrants(2, ['h', 'g'], 'h'), seeded(9));
  until(sim, () => sim.state.stage === 'pick');
  const sec = sim.secrets();
  assert.equal(sec.length, 1);
  assert.equal(sec[0].to, 'h');
  const endsAt = sim.state.stageEndsAt;
  sim.action('h', 'board', 0);
  sim.action('g', 'board', 1);
  assert.ok(sim.state.stageEndsAt <= sim.elapsed + MINE.pickEarlyCloseMs && sim.state.stageEndsAt < endsAt);
  until(sim, () => sim.state.stage === 'race');
  assert.equal(sim.state.cursed, sec[0].data.cursed);
});
