import {
  BRAWL, PODIUM_TELEPORT_MS, STEAL_POINTS, type Hit, type Point,
  BOT_NAMES, CODE_ALPHABET, CODE_LENGTH, MAX_PLAYERS, MIN_PLAYERS_TO_START, PHASE_MS, QUESTS, QUEST_CHOICES, ROUND_CHOICES,
  GORGE, GORGE_STARTS, makeGorgeCourse, MARKET, MARKET_STARTS, type MinigameAction,
  BOMB, BOMB_STARTS, makeMaze, GORGON, GORGON_STARTS, makeGorgonField, SHEEP, SHEEP_STARTS, FEST, FEST_STARTS, BARRELS, BARREL_STARTS, BARREL_PODIUM, HORDE, HORDE_STARTS, CHESTS, CHEST_HOMES, MINE, MINE_STARTS, MINIGAME_ACTIONS, type MinigameSecret,
  SB_STARTS, SEAT_COUNT, VOTE_EARLY_CLOSE_MS, isCeremony, isPlayable, isVotePhase, makeSkeletonArena, randomConfig,
  sanitizeConfig, sanitizeName, finalRanking, finaleMs,
  type GameState, type ImposterReveal, type JoinError, type MinigameState, type MinigameTick, type Phase, type PlayerInfo, type ProfileUpdate,
  type RoomState, type VoteOption,
} from '@oddone/shared';
import { createSim } from './minigames/index.ts';

/** Mini-jeux où l'on peut pousser les autres pendant la partie (recharge et portée). */
const PUSH_RULES: Record<string, { cooldownMs: number; reach: number }> = {
  [GORGE.id]: GORGE.push,
  [BARRELS.id]: BARRELS.push,
  [GORGON.id]: GORGON.push,
};
import type { MinigameSim } from './minigames/types.ts';
import { PodiumBrawl } from './minigames/podium.ts';

/**
 * Logique pure des tavernes, sans réseau : facile à tester.
 * Le serveur Socket.io appelle ces méthodes et diffuse `snapshot()` à chaque `changed`.
 *
 * Le serveur fait autorité sur tout le déroulé de la soirée (voir le schéma dans
 * shared/src/protocol.ts) : phases et minuteurs, votes, égalités tirées au sort, bots,
 * imposteur secret et mini-jeux (simulation des squelettes et des bots, contacts, classement).
 */

export interface Room {
  code: string;
  phase: Phase;
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  hostId: string;
  players: Map<string, PlayerInfo>;
  game: GameState;
  mg: MinigameState | null;
  /** Imposteur de la quête en cours. Secret : jamais envoyé dans room:state avant la révélation. */
  imposterId: string | null;
  sim: MinigameSim | null;
  /** Podium d'après mini-jeu (bots qui reculent et rendent les coups). */
  brawl: PodiumBrawl | null;
  /** Dernière position connue de chaque humain (envoyée par son client). */
  positions: Map<string, Point & { y: number }>;
  /** Dernier coup porté par chaque joueur (anti-spam). */
  lastHit: Map<string, number>;
}

export interface RoomEvents {
  /** L'état d'une taverne a changé : le diffuser à ses joueurs. */
  changed(room: Room): void;
  /** Rôle secret à envoyer à un seul joueur. */
  secret?(room: Room, playerId: string, role: { imposter: boolean; quest: string }): void;
  /** Positions du mini-jeu en cours (environ 20 par seconde). */
  tick?(room: Room, tick: MinigameTick): void;
  /** Un coup sur le podium, à montrer à tous (la cible applique le recul chez elle). */
  hit?(room: Room, hit: Hit): void;
  /** Information secrète de mini-jeu pour un seul joueur (ce que l'imposteur a vu dans un coffre). */
  mgSecret?(room: Room, playerId: string, s: MinigameSecret): void;
}

const newGame = (): GameState => ({ totalRounds: null, round: 0, options: [], votes: {}, chosen: null, tie: false, played: [], scores: {}, award: null, reveal: null, final: null });
/** Pas de simulation des mini-jeux (ms). */
export const SIM_STEP_MS = 50;

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private phaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private otherTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  /** Pour tester un mini-jeu : cette quête est proposée à chaque vote (et choisie par les bots). */
  forcedQuest: string | null = null;
  /** Pour tester le grand podium : la soirée saute de l'intro au podium, avec des pièces tirées au hasard. */
  skipToFinale = false;
  /** Pour tester l'avantage de l'imposteur : il est toujours tiré parmi les humains (pas les bots). */
  humanImposter = false;

  constructor(private events: RoomEvents, private now: () => number = Date.now, private random: () => number = Math.random) {}

  /* ================= Entrées / sorties ================= */

  create(playerId: string, profile: ProfileUpdate): Room {
    let code = this.newCode();
    while (this.rooms.has(code)) code = this.newCode();
    const room: Room = {
      code, phase: 'lobby', phaseStartedAt: null, phaseEndsAt: null, hostId: playerId, players: new Map(), game: newGame(),
      mg: null, imposterId: null, sim: null, brawl: null, positions: new Map(), lastHit: new Map(),
    };
    this.rooms.set(code, room);
    this.addPlayer(room, playerId, sanitizeName(profile?.name), sanitizeConfig(profile?.cfg), false);
    return room;
  }

  join(playerId: string, rawCode: unknown, profile: ProfileUpdate): Room | JoinError {
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase().replace(/[^A-Z]/g, '') : '';
    if (code.length !== CODE_LENGTH) return 'bad_code';
    const room = this.rooms.get(code);
    if (!room) return 'room_not_found';
    if (room.players.size >= MAX_PLAYERS) return 'room_full';
    if (isCeremony(room.phase)) return 'game_in_progress';
    this.addPlayer(room, playerId, sanitizeName(profile?.name), sanitizeConfig(profile?.cfg), false);
    this.evaluateReady(room); // un nouvel arrivant debout annule le départ
    this.events.changed(room);
    return room;
  }

  leave(playerId: string, room: Room): void {
    room.players.delete(playerId);
    room.positions.delete(playerId);
    delete room.game.votes[playerId];
    const humans = [...room.players.values()].filter((p) => !p.bot);
    if (humans.length === 0) { this.destroy(room); return; } // les bots seuls ne gardent pas la taverne ouverte
    if (room.hostId === playerId) room.hostId = humans[0].id;
    room.sim?.remove(playerId);
    if (room.mg) delete room.mg.starts[playerId];
    if (isCeremony(room.phase)) { this.checkAllVoted(room); this.checkAllReady(room); }
    else this.evaluateReady(room);
    this.events.changed(room);
  }

  updateProfile(playerId: string, room: Room, profile: ProfileUpdate): void {
    const p = room.players.get(playerId);
    if (!p) return;
    p.name = sanitizeName(profile?.name);
    p.cfg = sanitizeConfig(profile?.cfg);
    this.events.changed(room);
  }

  /* ================= Tabourets ================= */

  takeSeat(playerId: string, room: Room, seat: unknown): boolean {
    const p = room.players.get(playerId);
    if (!p || isCeremony(room.phase)) return false;
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return false;
    for (const other of room.players.values()) if (other !== p && other.seat === seat) return false;
    p.seat = seat;
    this.evaluateReady(room);
    this.events.changed(room);
    return true;
  }

  leaveSeat(playerId: string, room: Room): void {
    const p = room.players.get(playerId);
    if (!p || p.seat < 0 || isCeremony(room.phase)) return; // pendant la soirée, on reste assis
    p.seat = -1;
    this.evaluateReady(room);
    this.events.changed(room);
  }

  /* ================= Bots ================= */

  addBot(requesterId: string, room: Room): boolean {
    if (requesterId !== room.hostId || isCeremony(room.phase) || room.players.size >= MAX_PLAYERS) return false;
    const used = new Set([...room.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${room.players.size + 1}`;
    let id = '';
    do id = `bot-${Math.floor(this.random() * 1e9).toString(36)}`; while (room.players.has(id));
    const bot = this.addPlayer(room, id, name, randomConfig(this.random), true);
    this.evaluateReady(room);
    this.events.changed(room);
    this.botSitSoon(room, bot, 1200);
    return true;
  }

  removeBot(requesterId: string, room: Room, botId: unknown): boolean {
    const bot = typeof botId === 'string' ? room.players.get(botId) : undefined;
    if (requesterId !== room.hostId || !bot?.bot || isCeremony(room.phase)) return false;
    room.players.delete(bot.id);
    this.evaluateReady(room);
    this.events.changed(room);
    return true;
  }

  /** Un bot va s'asseoir sur le premier tabouret libre (s'il est encore debout en lobby). */
  private botSitSoon(room: Room, bot: PlayerInfo, delay: number): void {
    this.later(room, delay, () => {
      if (!room.players.has(bot.id) || bot.seat >= 0 || isCeremony(room.phase)) return;
      const taken = new Set([...room.players.values()].map((p) => p.seat));
      for (let s = 0; s < SEAT_COUNT; s++) if (!taken.has(s)) { this.takeSeat(bot.id, room, s); return; }
    });
  }

  /* ================= Votes ================= */

  vote(playerId: string, room: Room, optionId: unknown): boolean {
    const p = room.players.get(playerId);
    if (!p || !isVotePhase(room.phase) || typeof optionId !== 'string') return false;
    if (!room.game.options.some((o) => o.id === optionId)) return false;
    if (room.phase === 'imposterVote' && optionId === playerId) return false; // on ne vote pas contre soi
    room.game.votes[playerId] = optionId;
    this.checkAllVoted(room);
    this.events.changed(room);
    return true;
  }

  /** Tout le monde a voté : on clôt le vote un peu plus tôt. */
  private checkAllVoted(room: Room): void {
    if (!isVotePhase(room.phase)) return;
    const everyone = [...room.players.keys()].every((id) => room.game.votes[id] !== undefined);
    const closeAt = this.now() + VOTE_EARLY_CLOSE_MS;
    if (everyone && room.phaseEndsAt !== null && closeAt < room.phaseEndsAt) this.setPhase(room, room.phase, closeAt - this.now(), false);
  }

  private startVote(room: Room, phase: 'roundsVote' | 'questVote' | 'imposterVote', options: VoteOption[]): void {
    room.game.options = options;
    room.game.votes = {};
    this.setPhase(room, phase);
    // les bots votent au hasard après un petit temps de réflexion
    for (const p of room.players.values()) {
      if (!p.bot) continue;
      this.later(room, 1500 + this.random() * 4500, () => {
        if (room.phase !== phase || !room.players.has(p.id)) return;
        let pool = options;
        // les bots préfèrent les quêtes dont le mini-jeu existe (pratique pour tester)
        if (phase === 'questVote') {
          const playable = options.filter((o) => isPlayable(o.id) && (!this.forcedQuest || o.id === this.forcedQuest));
          if (playable.length) pool = playable;
        }
        if (phase === 'imposterVote') pool = options.filter((o) => o.id !== p.id);
        if (pool.length) this.vote(p.id, room, pool[Math.floor(this.random() * pool.length)].id);
      });
    }
  }

  /**
   * Révélation, en deux temps : chaque joueur qui s'est trompé (ou n'a pas voté) donne STEAL_POINTS
   * pièces à l'imposteur, puis l'imposteur en donne autant à chaque joueur qui l'a démasqué.
   * On ne donne jamais plus de pièces qu'on n'en a.
   */
  private resolveImposterVote(room: Room): void {
    const imp = room.imposterId!, g = room.game, deltas: Record<string, number> = { [imp]: 0 };
    const transfers: ImposterReveal['transfers'] = [];
    const give = (from: string, to: string, stage: 1 | 2) => {
      for (let k = 0; k < STEAL_POINTS && (g.scores[from] ?? 0) > 0; k++) {
        g.scores[from] -= 1; g.scores[to] = (g.scores[to] ?? 0) + 1;
        deltas[from] = (deltas[from] ?? 0) - 1; deltas[to] = (deltas[to] ?? 0) + 1;
        transfers.push({ from, to, stage });
      }
    };
    const others = [...room.players.values()].filter((p) => p.id !== imp).sort((a, b) => a.slot - b.slot);
    const found = others.filter((p) => g.votes[p.id] === imp);
    for (const p of others) deltas[p.id] = 0;
    for (const p of others) if (g.votes[p.id] !== imp) give(p.id, imp, 1);
    for (const p of found) give(imp, p.id, 2);
    g.reveal = { imposterId: imp, deltas, found: found.length, transfers };
  }

  /** Option la plus votée ; égalité (ou aucun vote) : tirage au sort parmi les ex aequo. */
  private resolveVote(room: Room): VoteOption {
    const counts = new Map(room.game.options.map((o) => [o.id, 0]));
    for (const v of Object.values(room.game.votes)) counts.set(v, (counts.get(v) ?? 0) + 1);
    const max = Math.max(...counts.values());
    const best = room.game.options.filter((o) => counts.get(o.id) === max);
    const chosen = best[Math.floor(this.random() * best.length)];
    room.game.chosen = chosen;
    room.game.tie = best.length > 1;
    return chosen;
  }

  /**
   * Trois quêtes au hasard, en évitant celles déjà jouées. Tant que peu de mini-jeux existent,
   * au moins une des trois est jouable (quitte à rejouer un mini-jeu déjà fait).
   */
  private questOptions(room: Room): VoteOption[] {
    const fresh = this.shuffle(QUESTS.filter((q) => !room.game.played.includes(q.id)));
    const pool = fresh.length >= QUEST_CHOICES ? fresh : [...fresh, ...this.shuffle(QUESTS.filter((q) => !fresh.includes(q)))];
    let picked = pool.slice(0, QUEST_CHOICES);
    if (!picked.some((q) => q.playable)) {
      const playable = QUESTS.filter((q) => q.playable);
      const unplayed = playable.filter((q) => !room.game.played.includes(q.id));
      const list = unplayed.length ? unplayed : playable;
      if (list.length) picked = [list[Math.floor(this.random() * list.length)], ...picked.slice(0, QUEST_CHOICES - 1)];
    }
    const forced = this.forcedQuest ? QUESTS.find((q) => q.id === this.forcedQuest) : undefined;
    if (forced && !picked.includes(forced)) picked = [forced, ...picked.slice(0, QUEST_CHOICES - 1)];
    return this.shuffle(picked).map((q) => ({ id: q.id, label: q.name }));
  }

  private shuffle<T>(list: readonly T[]): T[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /* ================= Mini-jeux ================= */

  /** Écran des règles : « Commencer ». Quand tout le monde est prêt, le mini-jeu démarre. */
  minigameReady(playerId: string, room: Room): boolean {
    if (room.phase !== 'rules' || !room.mg || !room.players.has(playerId) || room.mg.ready.includes(playerId)) return false;
    room.mg.ready.push(playerId);
    this.checkAllReady(room);
    this.events.changed(room);
    return true;
  }

  private checkAllReady(room: Room): void {
    if (room.phase !== 'rules' || !room.mg) return;
    const all = [...room.players.keys()].every((id) => room.mg!.ready.includes(id));
    const closeAt = this.now() + 700; // le temps de voir le dernier « Prêt ! »
    if (all && room.phaseEndsAt !== null && closeAt < room.phaseEndsAt) this.setPhase(room, 'rules', 700, false);
  }

  /** Position reçue d'un joueur humain (la simulation ne s'en sert que pendant la partie). */
  playerMoved(playerId: string, room: Room, x: number, y: number, z: number, yaw = 0): void {
    if (!room.players.has(playerId)) return;
    room.positions.set(playerId, { x, y, z });
    if (room.phase === 'mgPlay') room.sim?.setHumanPosition(playerId, x, z, y, yaw);
  }

  /**
   * Podium : un joueur en frappe un autre. Le serveur vérifie la phase, la cadence et la distance,
   * fait reculer les bots lui-même et transmet le coup à tous (la cible humaine recule chez elle).
   */
  hit(playerId: string, room: Room, to: unknown, kick: unknown, dir: unknown): boolean {
    // coups permis : sur le podium (après la téléportation), et pendant les parties où l'on pousse
    const push = room.phase === 'mgPlay' ? PUSH_RULES[room.mg?.id ?? ''] : undefined;
    const pushing = !!push;
    const podium = room.phase === 'mgResults' && room.phaseStartedAt !== null && this.now() - room.phaseStartedAt >= PODIUM_TELEPORT_MS;
    if (!pushing && !podium) return false;
    if (typeof to !== 'string' || to === playerId || !room.players.has(to) || !room.players.has(playerId)) return false;
    if (!Array.isArray(dir) || dir.length !== 2 || !dir.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    const last = room.lastHit.get(playerId) ?? -Infinity;
    if (this.now() - last < (push ? push.cooldownMs - 100 : BRAWL.cooldownMs)) return false;
    const from = room.positions.get(playerId), target = room.positions.get(to) ?? room.brawl?.position(to) ?? room.sim?.position?.(to);
    if (from && target && Math.hypot(from.x - target.x, from.z - target.z) > (push ? push.reach : BRAWL.reach) + 1) return false; // trop loin
    const len = Math.hypot(dir[0], dir[1]);
    if (len < 1e-3) return false;
    room.lastHit.set(playerId, this.now());
    const h: Hit = { from: playerId, to, kick: kick === true, dir: [dir[0] / len, dir[1] / len] };
    if (pushing) room.sim?.knock?.(to, h.dir);
    else room.brawl?.knock(to, h.kick, h.dir);
    this.events.hit?.(room, h);
    return true;
  }

  /** Boucle du podium : bots qui reculent, rendent les coups ; positions envoyées à tous. */
  private podiumLoop(room: Room, last: number): void {
    this.later(room, SIM_STEP_MS, () => {
      const brawl = room.brawl;
      if (room.phase !== 'mgResults' || !brawl) return;
      const now = this.now();
      const humans = new Map([...room.positions].filter(([id]) => room.players.has(id) && !room.players.get(id)!.bot));
      const hits = now - (room.phaseStartedAt ?? now) >= PODIUM_TELEPORT_MS ? brawl.step(Math.min(200, now - last), humans) : [];
      for (const h of hits) this.events.hit?.(room, h);
      this.events.tick?.(room, { t: Math.round(brawl.elapsed), sk: [], bots: brawl.tick() });
      this.podiumLoop(room, now);
    });
  }

  private startMinigame(room: Room, id: string): void {
    const starts: Record<string, [number, number]> = {};
    const gorge = id === GORGE.id, market = id === MARKET.id, barrels = id === BARRELS.id, horde = id === HORDE.id, chests = id === CHESTS.id, mine = id === MINE.id, bomb = id === BOMB.id, gorgon = id === GORGON.id, sheep = id === SHEEP.id, fest = id === FEST.id;
    const spots = gorge ? GORGE_STARTS : market ? MARKET_STARTS : barrels ? BARREL_STARTS : horde ? HORDE_STARTS : chests ? CHEST_HOMES : mine ? MINE_STARTS : bomb ? BOMB_STARTS : gorgon ? GORGON_STARTS : sheep ? SHEEP_STARTS : fest ? FEST_STARTS : SB_STARTS;
    for (const p of room.players.values()) starts[p.id] = [...spots[p.slot % spots.length]];
    const course = gorge ? makeGorgeCourse(this.random) : null;
    room.mg = {
      id, arena: gorge || market || barrels || horde || chests || mine || bomb || gorgon || sheep || fest ? null : makeSkeletonArena(this.random), course, race: null, market: null, ramp: null, horde: null, chests: null, mine: null,
      labyrinth: bomb ? makeMaze(this.random) : null, bomb: null, cemetery: gorgon ? makeGorgonField(this.random) : null, gorgon: null, sheep: null, fest: null,
      // le podium tombe à l'arrivée du Pont Branlant, devant la marmite au Festin du Roi, devant la rampe des Tonneaux Fous
      podium: course ? course.finishCenter : market ? [0, 5.2] : barrels ? [...BARREL_PODIUM] : horde ? [...HORDE.podium] : chests ? [...CHESTS.podium] : mine ? [...MINE.podium] : bomb ? [...BOMB.podium] : gorgon ? [...GORGON.podium] : sheep ? [...SHEEP.podium] : fest ? [...FEST.podium] : [0, 0],
      starts, ready: [], caught: {}, startedAt: null, results: null,
    };
    this.setPhase(room, 'rules');
    for (const p of room.players.values()) {
      if (p.bot) this.later(room, 1500 + this.random() * 2500, () => { if (room.players.has(p.id)) this.minigameReady(p.id, room); });
    }
  }

  /** Action de mini-jeu (prendre, livrer, transformer) : la simulation vérifie tout. */
  minigameAction(playerId: string, room: Room, kind: unknown, arg?: unknown): boolean {
    if (room.phase !== 'mgPlay' || !room.sim?.action || !MINIGAME_ACTIONS.includes(kind as MinigameAction)) return false;
    const n = typeof arg === 'number' && Number.isInteger(arg) ? arg : undefined;
    const ok = room.sim.action(playerId, kind as MinigameAction, n);
    this.sendSecrets(room);
    if (ok) this.events.changed(room);
    return ok;
  }

  /** Secrets de la simulation : chacun au seul joueur concerné. */
  private sendSecrets(room: Room): void {
    for (const s of room.sim?.secrets?.() ?? []) this.events.mgSecret?.(room, s.to, s.data);
  }

  /** Boucle de simulation (pas fixe de SIM_STEP_MS), tant que dure mgPlay. */
  private simLoop(room: Room, last: number): void {
    this.later(room, SIM_STEP_MS, () => {
      const sim = room.sim, mg = room.mg;
      if (room.phase !== 'mgPlay' || !sim || !mg) return;
      const now = this.now();
      const res = sim.step(Math.min(200, Math.max(0, now - last)));
      for (const h of res.hits) this.events.hit?.(room, h);
      this.sendSecrets(room);
      this.events.tick?.(room, sim.tick());
      if (res.done) this.finishMinigame(room);
      else {
        if (res.changed) this.events.changed(room);
        this.simLoop(room, now);
      }
    });
  }

  private finishMinigame(room: Room): void {
    const sim = room.sim, mg = room.mg;
    if (!sim || !mg || mg.results) return;
    mg.results = sim.results();
    for (const r of mg.results) room.game.scores[r.id] = (room.game.scores[r.id] ?? 0) + r.points;
    room.game.award = Object.fromEntries(mg.results.map((r) => [r.id, r.points]));
    this.events.tick?.(room, sim.tick()); // poses finales des bots
    // le podium tombe au milieu de l'arène, ou sur la plateforme d'arrivée du Pont Branlant
    const bounds = mg.course ? { halfX: 5.5 * GORGE.cell, halfZ: 3.4 * GORGE.cell } : mg.id === MARKET.id || mg.id === BARRELS.id || mg.id === HORDE.id || mg.id === CHESTS.id || mg.id === MINE.id || mg.id === BOMB.id || mg.id === GORGON.id || mg.id === SHEEP.id || mg.id === FEST.id ? { halfX: 6, halfZ: 2.5 } : { halfX: 12, halfZ: 9 };
    room.brawl = new PodiumBrawl(mg.results, new Set([...room.players.values()].filter((p) => p.bot).map((p) => p.id)), this.random, mg.podium, bounds);
    room.lastHit.clear();
    this.setPhase(room, 'mgResults');
    this.podiumLoop(room, this.now());
    this.events.changed(room);
  }

  /** Après une quête (mini-jeu ou pause) : quête suivante ou fin de soirée. */
  private nextQuestOrFinale(room: Room): void {
    const g = room.game;
    room.mg = null; room.sim = null; room.brawl = null; room.imposterId = null;
    g.reveal = null; g.award = null;
    if (g.round < (g.totalRounds ?? 0)) {
      g.round += 1;
      this.startVote(room, 'questVote', this.questOptions(room));
    } else {
      g.final = finalRanking([...room.players.values()], g.scores);
      this.setPhase(room, 'finale', finaleMs(g.final.length));
    }
  }

  /* ================= Déroulé de la soirée ================= */

  /** Tout le monde assis (et assez de monde) → compte à rebours ; sinon retour au lobby. */
  private evaluateReady(room: Room): void {
    if (isCeremony(room.phase)) return;
    const players = [...room.players.values()];
    const allSeated = players.length >= MIN_PLAYERS_TO_START && players.every((p) => p.seat >= 0);
    if (allSeated && room.phase === 'lobby') this.setPhase(room, 'countdown');
    else if (!allSeated && room.phase === 'countdown') this.setLobby(room);
  }

  private setLobby(room: Room): void {
    this.clearPhaseTimer(room);
    room.phase = 'lobby';
    room.phaseStartedAt = room.phaseEndsAt = null;
  }

  /** Change de phase et programme la suite. `restart` = false garde le début de phase (clôture anticipée). */
  private setPhase(room: Room, phase: Exclude<Phase, 'lobby'>, duration = PHASE_MS[phase], restart = true): void {
    this.clearPhaseTimer(room);
    room.phase = phase;
    const now = this.now();
    if (restart || room.phaseStartedAt === null) room.phaseStartedAt = now;
    room.phaseEndsAt = now + duration;
    this.phaseTimers.set(room.code, setTimeout(() => this.onPhaseEnd(room), duration));
  }

  private onPhaseEnd(room: Room): void {
    this.phaseTimers.delete(room.code);
    if (!this.rooms.has(room.code)) return;
    const g = room.game;
    switch (room.phase) {
      case 'countdown':
        room.game = newGame();
        this.setPhase(room, 'intro');
        break;
      case 'intro':
        if (this.skipToFinale) {
          for (const id of room.players.keys()) g.scores[id] = Math.floor(this.random() * 16);
          this.nextQuestOrFinale(room);
          break;
        }
        this.startVote(room, 'roundsVote', ROUND_CHOICES.map((n) => ({ id: String(n), label: `${n} quêtes` })));
        break;
      case 'roundsVote':
        g.totalRounds = Number(this.resolveVote(room).id);
        this.setPhase(room, 'roundsReveal');
        break;
      case 'roundsReveal':
        g.round = 1;
        this.startVote(room, 'questVote', this.questOptions(room));
        break;
      case 'questVote':
        this.resolveVote(room);
        this.setPhase(room, 'questReveal');
        break;
      case 'questReveal':
        g.played.push(g.chosen!.id);
        if (isPlayable(g.chosen!.id)) this.startMinigame(room, g.chosen!.id);
        else this.setPhase(room, 'quest'); // mini-jeu pas encore codé : simple pause
        break;
      case 'quest':
        this.nextQuestOrFinale(room);
        break;
      case 'rules': {
        // un imposteur par quête, tiré après les règles et prévenu en secret, chacun de son côté
        const mg = room.mg!, ids = [...room.players.keys()];
        const humans = ids.filter((id) => !room.players.get(id)?.bot);
        const pool = this.humanImposter && humans.length ? humans : ids;
        room.imposterId = pool[Math.floor(this.random() * pool.length)] ?? null;
        for (const id of ids) this.events.secret?.(room, id, { imposter: id === room.imposterId, quest: mg.id });
        room.sim = createSim(mg, [...room.players.values()].map((p) => ({
          id: p.id, bot: p.bot, imposter: p.id === room.imposterId, start: mg.starts[p.id] ?? [0, 0],
        })), this.random);
        this.setPhase(room, 'roleReveal');
        break;
      }
      case 'roleReveal':
        this.setPhase(room, 'mgCountdown');
        break;
      case 'mgCountdown':
        room.mg!.startedAt = this.now();
        this.setPhase(room, 'mgPlay', (room.sim?.maxMs ?? PHASE_MS.mgPlay) + 2000);
        this.simLoop(room, this.now());
        break;
      case 'mgPlay':
        this.finishMinigame(room); // durée maximale atteinte (la simulation s'arrête normalement avant)
        return;
      case 'mgResults':
        room.brawl = null;
        this.setPhase(room, 'debrief');
        break;
      case 'debrief':
        this.setPhase(room, 'scoreReveal');
        break;
      case 'scoreReveal':
        // vote seulement s'il y a quelqu'un à démasquer… et quelqu'un pour le faire
        if (room.imposterId && room.players.has(room.imposterId) && room.players.size >= 2) {
          this.startVote(room, 'imposterVote', [...room.players.values()].sort((a, b) => a.slot - b.slot).map((p) => ({ id: p.id, label: p.name })));
        } else this.nextQuestOrFinale(room);
        break;
      case 'imposterVote':
        this.resolveImposterVote(room);
        this.setPhase(room, 'imposterReveal');
        break;
      case 'imposterReveal':
        this.nextQuestOrFinale(room);
        break;
      case 'finale':
        this.backToLobby(room);
        break;
      default:
        return;
    }
    this.events.changed(room);
  }

  /** Fin de soirée : tout le monde se lève ; les bots se rassoient un peu plus tard. */
  private backToLobby(room: Room): void {
    this.setLobby(room);
    room.game = newGame();
    room.mg = null; room.sim = null; room.brawl = null; room.imposterId = null;
    room.positions.clear();
    let i = 0;
    for (const p of room.players.values()) {
      p.seat = -1;
      if (p.bot) this.botSitSoon(room, p, 2500 + 700 * i++);
    }
  }

  snapshot(room: Room): RoomState {
    return {
      code: room.code,
      phase: room.phase,
      phaseStartedAt: room.phaseStartedAt,
      phaseEndsAt: room.phaseEndsAt,
      hostId: room.hostId,
      players: [...room.players.values()].sort((a, b) => a.slot - b.slot),
      game: room.game,
      mg: room.mg,
    };
  }

  /* ================= Utilitaires ================= */

  private addPlayer(room: Room, id: string, name: string, cfg: PlayerInfo['cfg'], bot: boolean): PlayerInfo {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const p: PlayerInfo = { id, name, cfg, slot, seat: -1, bot };
    room.players.set(id, p);
    return p;
  }

  private later(room: Room, ms: number, fn: () => void): void {
    let set = this.otherTimers.get(room.code);
    if (!set) { set = new Set(); this.otherTimers.set(room.code, set); }
    const t = setTimeout(() => { set!.delete(t); if (this.rooms.get(room.code) === room) fn(); }, ms);
    set.add(t);
  }

  private clearPhaseTimer(room: Room): void {
    const t = this.phaseTimers.get(room.code);
    if (t) clearTimeout(t);
    this.phaseTimers.delete(room.code);
  }

  private destroy(room: Room): void {
    this.clearPhaseTimer(room);
    for (const t of this.otherTimers.get(room.code) ?? []) clearTimeout(t);
    this.otherTimers.delete(room.code);
    this.rooms.delete(room.code);
  }

  private newCode(): string {
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
    return s;
  }
}
