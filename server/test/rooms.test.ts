import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { FINALE, finaleMs, finaleRevealAt, finalRanking, BARREL_PODIUM, CHESTS, DEFAULT_CONFIG, HORDE, chestFront, MINE, type MinigameSecret, MAX_PLAYERS, PHASE_MS, PLACE_POINTS, PODIUM_TELEPORT_MS, QUEST_BY_ID, STEAL_POINTS, VOTE_EARLY_CLOSE_MS, isPlayable, type Hit, type MinigameTick } from '@oddone/shared';
import { RoomManager, SIM_STEP_MS, type Room } from '../src/rooms.ts';

const profile = (name: string) => ({ name, cfg: { ...DEFAULT_CONFIG } });

/** Horloge simulée : Date.now et setTimeout avancent ensemble. */
let now = 0;
beforeEach(() => { now = 1_000_000; mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => mock.timers.reset());
const tick = (...steps: number[]) => { for (const ms of steps) { now += ms; mock.timers.tick(ms); } };

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const manager = (random: () => number = Math.random) => new RoomManager({ changed: () => {} }, () => now, random);

test('créer puis rejoindre avec le code', () => {
  const m = manager();
  const room = m.create('a', profile('Alice'));
  assert.equal(room.code.length, 4);
  const joined = m.join('b', room.code.toLowerCase(), profile('Bob'));
  assert.notEqual(typeof joined, 'string');
  assert.deepEqual(m.snapshot(room).players.map((p) => p.slot), [0, 1]);
});

test('code inconnu, mal formé, taverne pleine', () => {
  const m = manager();
  assert.equal(m.join('x', 'ZZZZ', profile('X')), 'room_not_found');
  assert.equal(m.join('x', 'AB', profile('X')), 'bad_code');
  const room = m.create('p0', profile('P0'));
  for (let i = 1; i < MAX_PLAYERS; i++) m.join('p' + i, room.code, profile('P' + i));
  assert.equal(m.join('late', room.code, profile('Late')), 'room_full');
});

test("un tabouret ne peut avoir qu'un occupant", () => {
  const m = manager();
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  assert.equal(m.takeSeat('a', room, 2), true);
  assert.equal(m.takeSeat('b', room, 2), false);
  assert.equal(m.takeSeat('b', room, 7), false);
});

test("tout le monde assis → compte à rebours ; quelqu'un se lève → annulé", () => {
  const m = manager();
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  m.takeSeat('a', room, 0);
  assert.equal(room.phase, 'lobby');
  m.takeSeat('b', room, 1);
  assert.equal(room.phase, 'countdown');
  m.leaveSeat('b', room);
  assert.equal(room.phase, 'lobby');
  m.leave('a', room); m.leave('b', room);
  assert.equal(m.rooms.size, 0);
});

test('les noms et tenues reçus sont nettoyés', () => {
  const m = manager();
  const room = m.create('a', { name: '  <b>Un pseudo bien trop long</b>  ', cfg: { body: 'dragon', hue: 999 } as never });
  const p = m.snapshot(room).players[0];
  assert.equal(p.name.length <= 12, true);
  assert.equal(p.cfg.body, DEFAULT_CONFIG.body);
  assert.equal(p.cfg.hue, null);
});

test("seul l'hôte ajoute des bots ; ils s'assoient tout seuls", () => {
  const m = manager();
  const room = m.create('host', profile('Hôte'));
  m.join('b', room.code, profile('B'));
  assert.equal(m.addBot('b', room), false);
  assert.equal(m.addBot('host', room), true);
  const bot = [...room.players.values()].find((p) => p.bot)!;
  assert.equal(bot.seat, -1);
  tick(1300);
  assert.notEqual(bot.seat, -1);
  assert.equal(m.removeBot('host', room, bot.id), true);
  assert.equal(room.players.size, 2);
});

test('une soirée complète : vote du nombre de quêtes, quêtes, retour au lobby', () => {
  const m = manager();
  const room = m.create('a', profile('A'));
  m.takeSeat('a', room, 0);
  assert.equal(room.phase, 'countdown');
  tick(PHASE_MS.countdown);
  assert.equal(room.phase, 'intro');
  assert.equal(m.leaveSeat('a', room), undefined);
  assert.equal(room.players.get('a')!.seat, 0, 'on reste assis pendant la soirée');
  tick(PHASE_MS.intro);
  assert.equal(room.phase, 'roundsVote');
  assert.deepEqual(room.game.options.map((o) => o.id), ['3', '5', '7']);
  assert.equal(m.vote('a', room, '3'), true);
  // seul votant : clôture anticipée
  tick(VOTE_EARLY_CLOSE_MS);
  assert.equal(room.phase, 'roundsReveal');
  assert.equal(room.game.totalRounds, 3);
  assert.equal(room.game.tie, false);
  tick(PHASE_MS.roundsReveal);
  const seen = new Set<string>();
  for (let r = 1; r <= 3; r++) {
    assert.equal(room.phase, 'questVote');
    assert.equal(room.game.round, r);
    assert.equal(room.game.options.length, 3);
    for (const o of room.game.options) { assert.ok(QUEST_BY_ID.has(o.id)); assert.ok(!seen.has(o.id) || seen.size > 7); }
    assert.ok(room.game.options.some((o) => isPlayable(o.id)), 'au moins une quête jouable proposée');
    // une quête sans mini-jeu (une simple pause ; les mini-jeux ont leur propre test) glissée dans le tirage
    room.game.options[0] = { id: `pause-${r}`, label: 'Pause' };
    const pick = `pause-${r}`;
    m.vote('a', room, pick);
    tick(VOTE_EARLY_CLOSE_MS);
    assert.equal(room.phase, 'questReveal');
    assert.equal(room.game.chosen!.id, pick);
    seen.add(pick);
    tick(PHASE_MS.questReveal);
    assert.equal(room.phase, 'quest');
    tick(PHASE_MS.quest);
  }
  assert.equal(room.phase, 'finale');
  assert.deepEqual(room.game.played, [...seen]);
  assert.deepEqual(room.game.final, [{ id: 'a', rank: 1, coins: 0 }]);
  tick(finaleMs(1) - 1);
  assert.equal(room.phase, 'finale');
  tick(1);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.game.final, null);
  assert.equal(room.players.get('a')!.seat, -1);
});

test('égalité : tirage au sort entre les ex aequo', () => {
  const m = manager(() => 0.99); // le tirage prend toujours le dernier ex aequo
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  m.takeSeat('a', room, 0); m.takeSeat('b', room, 1);
  tick(PHASE_MS.countdown, PHASE_MS.intro);
  m.vote('a', room, '3');
  m.vote('b', room, '7');
  tick(VOTE_EARLY_CLOSE_MS);
  assert.equal(room.game.tie, true);
  assert.equal(room.game.totalRounds, 7);
});

test('personne ne vote : choix au hasard à la fin du minuteur', () => {
  const m = manager(() => 0);
  const room = m.create('a', profile('A'));
  m.takeSeat('a', room, 0);
  tick(PHASE_MS.countdown, PHASE_MS.intro, PHASE_MS.roundsVote);
  assert.equal(room.phase, 'roundsReveal');
  assert.equal(room.game.totalRounds, 3);
});

test('les bots votent pendant la soirée', () => {
  const m = manager();
  const room = m.create('a', profile('A'));
  m.addBot('a', room); m.addBot('a', room);
  tick(1300);
  m.takeSeat('a', room, 3);
  assert.equal(room.phase, 'countdown');
  tick(PHASE_MS.countdown, PHASE_MS.intro);
  tick(6100);
  const bots = [...room.players.values()].filter((p) => p.bot);
  for (const b of bots) assert.ok(room.game.votes[b.id], `${b.name} a voté`);
});

test("rejoindre pendant la soirée est refusé ; la taverne ferme quand il ne reste que des bots", () => {
  const m = manager();
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  m.takeSeat('a', room, 1);
  tick(PHASE_MS.countdown);
  assert.equal(m.join('late', room.code, profile('Late')), 'game_in_progress');
  m.leave('a', room);
  assert.equal(m.rooms.size, 0);
});

/** Avance la partie jusqu'au premier vote de quête, avec 3 quêtes. */
function toQuestVote(m: RoomManager, room: Room, humans: string[]) {
  humans.forEach((id, i) => assert.ok(m.takeSeat(id, room, 3 - i))); // les bots prennent les premiers tabourets
  tick(PHASE_MS.countdown, PHASE_MS.intro);
  for (const id of humans) m.vote(id, room, '3');
  for (let i = 0; i < 300 && room.phase !== 'questVote'; i++) tick(100); // les bots votent aussi
  assert.equal(room.phase, 'questVote');
}

/** Lance le Bal des Squelettes (premier vote de quête) et passe l'écran des règles. */
function toMinigame(m: RoomManager, room: Room, humans: string[], quest = 'bal-squelettes') {
  toQuestVote(m, room, humans);
  room.game.options = [{ id: quest, label: quest }]; // le tirage des 3 quêtes est aléatoire : on impose celle du test
  for (const id of humans) m.vote(id, room, quest);
  for (let i = 0; i < 200 && room.phase === 'questVote'; i++) tick(100); // les bots votent aussi
  assert.equal(room.game.chosen!.id, quest);
  tick(PHASE_MS.questReveal);
  assert.equal(room.phase, 'rules');
}

test("un imposteur par quête, tiré après les règles et prévenu en secret", () => {
  const secrets: [string, boolean, string][] = [];
  const m = new RoomManager({ changed: () => {}, secret: (_r, id, role) => secrets.push([id, role.imposter, role.quest]) }, () => now);
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a', 'b']);
  assert.equal(secrets.length, 0, 'pas encore pendant les règles');
  m.minigameReady('a', room); m.minigameReady('b', room);
  tick(4100, 700); // le bot est prêt au plus tard après 4 s, puis 0,7 s pour voir « Prêt ! »
  assert.equal(room.phase, 'roleReveal');
  assert.equal(secrets.length, 3);
  assert.equal(secrets.filter(([, imp]) => imp).length, 1);
  assert.ok(secrets.every(([, , q]) => q === 'bal-squelettes'));
  assert.ok(!JSON.stringify(m.snapshot(room)).includes('imposterId'), "l'état public ne dit rien");
});

test('Bal des Squelettes : règles, rôle, partie, podium, débrief, vote, révélation', () => {
  const ticks: number[] = [];
  const hits: Hit[] = [];
  const m = new RoomManager({ changed: () => {}, tick: (_r, t) => ticks.push(t.t), hit: (_r, h) => hits.push(h) }, () => now);
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a']);
  const mg = room.mg!;
  assert.ok(mg.arena!.graves.length >= 8, 'des tombes un peu partout');
  assert.deepEqual(Object.keys(mg.starts).sort(), [...room.players.keys()].sort());
  tick(4100); // le bot appuie sur « Commencer »
  assert.equal(mg.ready.length, 1);
  assert.equal(room.phase, 'rules');
  assert.equal(m.minigameReady('a', room), true);
  assert.equal(m.minigameReady('a', room), false);
  tick(700);
  assert.equal(room.phase, 'roleReveal');
  assert.ok(room.imposterId);
  tick(PHASE_MS.roleReveal);
  assert.equal(room.phase, 'mgCountdown');
  tick(PHASE_MS.mgCountdown);
  assert.equal(room.phase, 'mgPlay');
  // le joueur humain reste planté là : il finit forcément touché (même imposteur : il ne bouge pas)
  for (let i = 0; i < 2400 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.ok(ticks.length > 20);
  assert.ok(Object.keys(mg.caught).length >= 1, "quelqu'un a été touché (pas forcément l'humain : il peut être l'imposteur)");
  const res = mg.results!;
  assert.equal(res.length, 2);
  assert.equal(res[0].rank, 1);
  assert.deepEqual(res.map((r) => r.points), [PLACE_POINTS[0], PLACE_POINTS[1]]);
  for (const r of res) assert.equal(room.game.scores[r.id], r.points);

  // podium : pas de coup avant la téléportation, puis un coup au bot
  const bot = [...room.players.values()].find((p) => p.bot)!;
  m.playerMoved('a', room, 0.5, 1, 0);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), false, 'trop tôt');
  tick(PODIUM_TELEPORT_MS);
  const before = { ...room.brawl!.position(bot.id)! };
  assert.equal(m.hit('a', room, bot.id, true, [3, 0]), true);
  assert.equal(m.hit('a', room, bot.id, true, [1, 0]), false, 'cadence limitée');
  assert.deepEqual(hits.at(-1)!.dir, [1, 0]);
  for (let i = 0; i < 6; i++) tick(SIM_STEP_MS);
  assert.ok(room.brawl!.position(bot.id)!.x > before.x, 'le bot recule');
  tick(PHASE_MS.mgResults);
  assert.equal(room.phase, 'debrief');
  tick(PHASE_MS.debrief);
  assert.equal(room.phase, 'scoreReveal');
  assert.deepEqual(room.game.award, Object.fromEntries(res.map((r) => [r.id, r.points])), 'les pièces du mini-jeu, à faire tomber');
  tick(PHASE_MS.scoreReveal);
  assert.equal(room.phase, 'imposterVote');
  assert.equal(m.vote('a', room, 'a'), false, 'pas contre soi');
  m.vote('a', room, bot.id);
  const scores = { ...room.game.scores };
  for (let i = 0; i < 100 && room.phase === 'imposterVote'; i++) tick(100); // le bot vote aussi
  assert.equal(room.phase, 'imposterReveal');
  const rv = room.game.reveal!;
  assert.equal(rv.imposterId, room.imposterId);
  // un seul autre joueur a voté contre l'imposteur… ou s'est trompé
  const voter = rv.imposterId === 'a' ? bot.id : 'a';
  const found = room.game.votes[voter] === rv.imposterId;
  assert.equal(rv.found, found ? 1 : 0);
  assert.equal(room.game.scores[voter], scores[voter] + (found ? STEAL_POINTS : -STEAL_POINTS));
  assert.equal(room.game.scores[rv.imposterId], scores[rv.imposterId] + (found ? -STEAL_POINTS : STEAL_POINTS));
  assert.deepEqual(rv.transfers, [found ? { from: rv.imposterId, to: voter, stage: 2 } : { from: voter, to: rv.imposterId, stage: 1 }]);
  tick(PHASE_MS.imposterReveal);
  assert.equal(room.phase, 'questVote');
  assert.equal(room.game.round, 2);
  assert.equal(room.mg, null);
  assert.equal(room.imposterId, null);
  assert.equal(room.game.award, null);
});

test("écran des règles : sans réponse, la partie démarre quand même ; un départ débloque l'attente", () => {
  const m = manager(() => 0.3);
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  toQuestVote(m, room, ['a', 'b']);
  room.game.options = [{ id: 'bal-squelettes', label: 'Bal' }];
  m.vote('a', room, 'bal-squelettes'); m.vote('b', room, 'bal-squelettes');
  tick(VOTE_EARLY_CLOSE_MS, PHASE_MS.questReveal);
  assert.equal(room.phase, 'rules');
  m.minigameReady('a', room);
  m.leave('b', room); // b part : a était le seul à attendre
  tick(700);
  assert.equal(room.phase, 'roleReveal');
});

test('Pont Branlant : parcours, poussée pendant la course, podium sur la plateforme d’arrivée', () => {
  const hits: Hit[] = [];
  // tirage fixé : un bot poussé dans le vide trop souvent peut, rarement, ne jamais arriver
  const m = new RoomManager({ changed: () => {}, hit: (_r, h) => hits.push(h) }, () => now, seeded(23));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'pont-branlant');
  const mg = room.mg!;
  assert.ok(mg.course && !mg.arena);
  assert.deepEqual(mg.podium, mg.course!.finishCenter);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.ok(mg.race && Object.keys(mg.race).length === 2);
  // pousser le bot : permis pendant la course, avec recharge
  const bot = [...room.players.values()].find((p) => p.bot)!;
  const bp = room.sim!.position!(bot.id)!;
  m.playerMoved('a', room, bp.x - 0.8, 0, bp.z);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), true);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), false, 'recharge');
  // la course finit (le bot finit par arriver, l’humain immobile non)
  for (let i = 0; i < 7000 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.equal(mg.results![0].id, bot.id);
  assert.deepEqual(mg.results!.map((r) => r.points), [PLACE_POINTS[0], PLACE_POINTS[1]]);
  const p = room.brawl!.position(bot.id)!;
  assert.ok(Math.abs(p.x - mg.podium[0]) < 3 && Math.abs(p.z - mg.podium[1]) < 3, 'le bot est sur le podium, à l’arrivée');
});

test('Tonneaux Fous : poussée pendant la partie, tonneaux dans les ticks, podium devant la rampe', () => {
  const hits: Hit[] = [];
  const ticks: MinigameTick[] = [];
  const m = new RoomManager({ changed: () => {}, hit: (_r, h) => hits.push(h), tick: (_r, t) => ticks.push(t) }, () => now, seeded(5));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'tonneaux-fous');
  const mg = room.mg!;
  assert.ok(!mg.arena && !mg.course);
  assert.deepEqual(mg.podium, [...BARREL_PODIUM]);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.ok(mg.ramp && Object.keys(mg.ramp).length === 2);
  const bot = [...room.players.values()].find((p) => p.bot)!;
  const bp = room.sim!.position!(bot.id)!;
  m.playerMoved('a', room, bp.x - 0.8, 0, bp.z);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), true);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), false, 'recharge');
  for (let i = 0; i < 60; i++) tick(SIM_STEP_MS);
  assert.ok(ticks.some((t) => (t.br?.length ?? 0) > 0), 'les tonneaux roulent');
  // le bot finit par arriver en haut ; l'humain, immobile au départ, non
  for (let i = 0; i < 4000 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.equal(mg.results![0].id, bot.id);
  assert.ok(mg.ramp![bot.id].finishedAt !== null);
});

test("Horde de Gobelins : coup d'épée par mg:action, podium dans la clairière, partie à durée fixe", () => {
  const ticks: MinigameTick[] = [];
  const m = new RoomManager({ changed: () => {}, tick: (_r, t) => ticks.push(t) }, () => now, seeded(9));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'horde-gobelins');
  const mg = room.mg!;
  assert.deepEqual(mg.podium, [...HORDE.podium]);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.ok(mg.horde && mg.horde.points.a === 0);
  for (let i = 0; i < 80; i++) tick(SIM_STEP_MS);
  assert.ok(ticks.some((t) => (t.gb?.length ?? 0) > 0), 'des gobelins');
  assert.equal(m.minigameAction('a', room, 'slash'), false, 'personne à portée');
  assert.equal(m.minigameAction('a', room, 'voler'), false, 'action inconnue');
  for (let i = 0; i < 2000 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.equal(mg.results!.length, 2);
  assert.ok((mg.horde!.points[[...room.players.values()].find((p) => p.bot)!.id] ?? 0) > 0, 'le bot a tué des gobelins');
});

test("Coffres Piégés : ouvrir et inspecter par mg:action, le secret ne part qu'à l'imposteur", () => {
  const secrets: [string, MinigameSecret][] = [];
  const m = new RoomManager({ changed: () => {}, mgSecret: (_r, id, sec) => secrets.push([id, sec]) }, () => now, seeded(12));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'coffres-pieges');
  const mg = room.mg!;
  assert.deepEqual(mg.podium, [...CHESTS.podium]);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.equal(mg.chests!.count, 3, 'deux joueurs : trois coffres');
  let inspected = false;
  for (let i = 0; i < 20000 && room.phase === 'mgPlay'; i++) {
    const c = mg.chests!;
    if (c.turn === 'a' && c.stage === 'turn' && !c.inspecting) {
      const k = [...Array(c.count).keys()].find((j) => !c.opened.includes(j))!;
      const [x, z] = chestFront(k, c.count);
      m.playerMoved('a', room, x, 0, z);
      if (!inspected) { assert.equal(m.minigameAction('a', room, 'inspect'), true); inspected = true; }
      else m.minigameAction('a', room, 'open');
    }
    tick(SIM_STEP_MS);
  }
  assert.equal(room.phase, 'mgResults');
  assert.ok(inspected);
  if (room.imposterId === 'a') { assert.equal(secrets.length, 1); assert.equal(secrets[0][0], 'a'); }
  else assert.equal(secrets.length, 0);
  assert.equal(mg.results!.length, 2);
  assert.equal(mg.chests!.alive.length, 1);
});

test("Wagonnets de la Mine : monter dans un wagon par mg:action avec son numéro ; la malédiction n'arrive qu'à l'imposteur", () => {
  const secrets: [string, MinigameSecret][] = [];
  const m = new RoomManager({ changed: () => {}, mgSecret: (_r, id, sec) => secrets.push([id, sec]) }, () => now, seeded(5));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'wagonnets-mine');
  const mg = room.mg!;
  assert.deepEqual(mg.podium, [...MINE.podium]);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.equal(mg.mine!.tracks.length, 4);
  let boarded = 0;
  for (let i = 0; i < 40000 && room.phase === 'mgPlay'; i++) {
    const s = mg.mine!;
    if (s.stage === 'curse') m.minigameAction('a', room, 'curse', 2);
    if (s.stage === 'pick' && !('a' in s.picks)) {
      const free = [0, 1, 2, 3].find((w) => !Object.values(s.picks).includes(w))!;
      assert.equal(m.minigameAction('a', room, 'board', 'x'), false, 'numéro de wagon invalide');
      assert.equal(m.minigameAction('a', room, 'board', free), true);
      boarded++;
    }
    tick(SIM_STEP_MS);
  }
  assert.equal(room.phase, 'mgResults');
  assert.equal(boarded, 3, 'une fois par manche');
  if (room.imposterId === 'a') assert.ok(secrets.length >= 3 && secrets.every(([id, s]) => id === 'a' && 'cursed' in s && s.cursed === 2));
  else assert.equal(secrets.length, 0);
  assert.equal(mg.results!.length, 2);
});

test("révélation : les pièces passent des joueurs trompés à l'imposteur, puis de l'imposteur aux bons votants, sans dette", () => {
  const m = manager(() => 0.5);
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  m.join('c', room.code, profile('C'));
  m.join('d', room.code, profile('D'));
  room.imposterId = 'b';
  // a et c ont trouvé, d s'est trompé ; ni d ni l'imposteur n'ont de pièce
  room.game.scores = { a: 3, b: 0, c: 2, d: 0 };
  room.game.votes = { a: 'b', c: 'b', d: 'a' };
  (m as unknown as { resolveImposterVote(r: typeof room): void }).resolveImposterVote(room);
  const rv = room.game.reveal!;
  assert.equal(rv.found, 2);
  assert.deepEqual(rv.transfers, [], "d n'avait rien à donner, l'imposteur non plus");
  // (l'imposteur reçoit d'abord, puis paie dans l'ordre des places tant qu'il a de quoi)
  room.game.scores = { a: 3, b: 0, c: 2, d: 1 };
  (m as unknown as { resolveImposterVote(r: typeof room): void }).resolveImposterVote(room);
  assert.deepEqual(room.game.reveal!.transfers, [{ from: 'd', to: 'b', stage: 1 }, { from: 'b', to: 'a', stage: 2 }]);
  assert.deepEqual(room.game.scores, { a: 4, b: 0, c: 2, d: 0 });
  assert.deepEqual(room.game.reveal!.deltas, { a: 1, b: 0, c: 0, d: -1 });
});

test('grand podium : classement par pièces, ex aequo à la même place, annonces de la dernière à la première', () => {
  const players = [{ id: 'a', slot: 0 }, { id: 'b', slot: 1 }, { id: 'c', slot: 2 }, { id: 'd', slot: 3 }];
  assert.deepEqual(finalRanking(players, { a: 2, b: 7, c: 7 }), [
    { id: 'b', rank: 1, coins: 7 }, { id: 'c', rank: 1, coins: 7 }, { id: 'a', rank: 3, coins: 2 }, { id: 'd', rank: 4, coins: 0 },
  ]);
  const at = [0, 1, 2, 3].map((i) => finaleRevealAt(i, 4));
  assert.deepEqual(at.slice(1), [FINALE.introMs + 2 * FINALE.stepMs, FINALE.introMs + FINALE.stepMs, FINALE.introMs], "le dernier d'abord");
  assert.equal(at[0], at[1] + FINALE.stepMs + FINALE.drumMs, 'suspense avant le vainqueur');
  assert.equal(finaleRevealAt(0, 1), FINALE.introMs, 'seul : pas de suspense');
  assert.equal(PHASE_MS.finale, finaleMs(MAX_PLAYERS));
});

test('Bombe du Labyrinthe : labyrinthe tiré avant les règles, manches jusqu’au dernier debout, podium au centre', () => {
  const m = new RoomManager({ changed: () => {} }, () => now, seeded(8));
  const room = m.create('a', profile('A'));
  m.addBot('a', room); m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'bombe-labyrinthe');
  const mg = room.mg!;
  assert.ok(mg.labyrinth && !mg.arena, 'le labyrinthe est connu dès les règles');
  assert.deepEqual(mg.podium, [0, 0]);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  assert.equal(mg.bomb!.rounds, 2, 'trois joueurs : deux manches');
  // l'humain reste planté dans son coin : la partie se joue quand même jusqu'au bout
  for (let i = 0; i < 5000 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.equal(mg.bomb!.out.length, 2);
  assert.deepEqual(mg.results!.map((r) => r.rank), [1, 2, 3]);
});

test('Regard de la Gorgone : cimetière tiré avant les règles, poussée permise, secret à l’imposteur, podium devant l’arrivée', () => {
  const secrets: [string, MinigameSecret][] = [];
  const m = new RoomManager({ changed: () => {}, mgSecret: (_r, id, sec) => secrets.push([id, sec]) }, () => now, seeded(6));
  const room = m.create('a', profile('A'));
  m.addBot('a', room);
  tick(1300);
  toMinigame(m, room, ['a'], 'regard-gorgone');
  const mg = room.mg!;
  assert.ok(mg.cemetery && mg.cemetery.covers.length > 0);
  m.minigameReady('a', room);
  for (let i = 0; i < 250 && room.phase !== 'mgPlay'; i++) tick(100);
  assert.equal(room.phase, 'mgPlay');
  const bot = [...room.players.values()].find((p) => p.bot)!;
  const bp = room.sim!.position!(bot.id)!;
  m.playerMoved('a', room, bp.x - 0.8, 0, bp.z);
  assert.equal(m.hit('a', room, bot.id, false, [1, 0]), true, 'on peut pousser');
  for (let i = 0; i < 4000 && room.phase === 'mgPlay'; i++) tick(SIM_STEP_MS);
  assert.equal(room.phase, 'mgResults');
  assert.equal(mg.results!.length, 2);
  for (const [id, sec] of secrets) { assert.equal(id, room.imposterId); assert.ok('turnAt' in sec); }
});
