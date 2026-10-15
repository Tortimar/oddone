import type { CharacterConfig } from './catalog.ts';
import type { SkeletonArena } from './minigames/skeletonBall.ts';
import type { GorgeCourse, RaceStatus } from './minigames/gorge.ts';
import type { MarketState } from './minigames/market.ts';
import type { RampStatus } from './minigames/barrels.ts';
import type { HordeState } from './minigames/horde.ts';
import type { ChestSecret, ChestsState } from './minigames/chests.ts';
import type { MineSecret, MineState } from './minigames/mine.ts';
import type { BombState, Maze } from './minigames/bomb.ts';
import type { GorgonField, GorgonSecret, GorgonState } from './minigames/gorgon.ts';
import type { SheepRaceState } from './minigames/sheep.ts';
import type { BombFestState } from './minigames/bombfest.ts';
import type { FinalRank } from './finale.ts';

/** Règles du lobby, partagées client/serveur. */
export const MAX_PLAYERS = 4;
export const SEAT_COUNT = 4;
export const CODE_LENGTH = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O, trop proches de 1 et 0
/** Nombre minimum de joueurs assis pour lancer la partie (1 pour tester seul). */
export const MIN_PLAYERS_TO_START = 1;
/** Fréquence d'envoi des positions par le client. */
export const MOVE_RATE_HZ = 15;

/**
 * Déroulé d'une soirée, piloté par le serveur :
 *
 *   lobby ──(tous assis)──▶ countdown ──▶ intro ──▶ roundsVote ──▶ roundsReveal ──▶ questVote
 *
 *   questVote ──▶ questReveal ──┬──▶ (mini-jeu codé) rules ──▶ roleReveal ──▶ mgCountdown ──▶ mgPlay ──▶ mgResults
 *                               │       ──▶ debrief ──▶ scoreReveal ──▶ imposterVote ──▶ imposterReveal ──┐
 *                               └──▶ (pas encore codé) quest ─────────────────────────────┤
 *                                                                                          ▼
 *                                         questVote (quête suivante)  ou  finale ──▶ lobby
 *
 * - `rules` : écran des règles et entraînement ; se termine quand tout le monde est prêt.
 * - `roleReveal` : un imposteur est tiré pour CETTE quête ; chacun découvre son rôle en secret
 *   (`role:secret`), l'imposteur relit son avantage.
 * - `mgResults` : le podium tombe sur l'arène, classement, et quelques secondes de bagarre.
 * - `debrief` : retour au comptoir, le tavernier commente ; `scoreReveal` : la caméra se tourne vers
 *   les joueurs et les pièces d'or du mini-jeu leur tombent dessus (`game.award`) ; `imposterVote` :
 *   ils désignent l'imposteur ; `imposterReveal` : révélation, puis les pièces passent des joueurs
 *   qui se sont trompés à l'imposteur, et de l'imposteur à ceux qui l'ont démasqué (`reveal.transfers`).
 *
 * - `finale` : grand podium au milieu de la taverne, places annoncées de la dernière à la première
 *   (`game.final` ; programme et durée dans finale.ts).
 *
 * Un point = une pièce d'or.
 */
export type Phase =
  | 'lobby' | 'countdown' | 'intro' | 'roundsVote' | 'roundsReveal' | 'questVote' | 'questReveal' | 'quest' | 'finale'
  | 'rules' | 'roleReveal' | 'mgCountdown' | 'mgPlay' | 'mgResults' | 'debrief' | 'scoreReveal' | 'imposterVote' | 'imposterReveal';

/** Durée de chaque phase (ms). Les votes se terminent plus tôt si tout le monde a voté. */
export const PHASE_MS: Record<Exclude<Phase, 'lobby'>, number> = {
  countdown: 3000,
  intro: 9000,
  roundsVote: 15000,
  roundsReveal: 4500,
  questVote: 20000,
  questReveal: 5000,
  quest: 7000, // quête sans mini-jeu (pas encore codé)
  finale: 21600, // à 4 joueurs ; la durée réelle dépend du nombre de joueurs (`finaleMs`)
  rules: 60000, // écran des règles : se termine dès que tout le monde a appuyé sur « Commencer »
  roleReveal: 5500,
  mgCountdown: 3500,
  mgPlay: 120000, // durée maximale : le mini-jeu s'arrête souvent avant
  mgResults: 13000, // podium : chute, téléportation, bagarre
  debrief: 8000,
  scoreReveal: 6500,
  imposterVote: 20000,
  imposterReveal: 10000,
};
/** Délai entre le dernier vote et la clôture anticipée du vote. */
export const VOTE_EARLY_CLOSE_MS = 1200;
/** Pièces d'or d'un mini-jeu selon la place (1er, 2e, 3e, 4e). */
export const PLACE_POINTS: readonly number[] = [4, 3, 2, 1];
/** Pièces prises par vote, dans un sens ou dans l'autre (jamais plus qu'on n'en a). */
export const STEAL_POINTS = 1;
/** Podium : moment (ms depuis le début de mgResults) où les joueurs apparaissent sur les marches. */
export const PODIUM_TELEPORT_MS = 1500;

export const isCeremony = (p: Phase) => p !== 'lobby' && p !== 'countdown';
export const isVotePhase = (p: Phase) => p === 'roundsVote' || p === 'questVote' || p === 'imposterVote';
/** Phases où les joueurs sont dans l'arène d'un mini-jeu (et plus au comptoir). */
export const isMinigamePhase = (p: Phase) => p === 'rules' || p === 'roleReveal' || p === 'mgCountdown' || p === 'mgPlay' || p === 'mgResults';

export interface PlayerInfo {
  id: string;
  name: string;
  cfg: CharacterConfig;
  /** Place 0..3 (couleur J1..J4), attribuée par le serveur. */
  slot: number;
  /** Tabouret occupé (0..3) ou -1. Être assis = être prêt. */
  seat: number;
  /** Joueur simulé par le serveur (pour tester). */
  bot: boolean;
}

export interface VoteOption { id: string; label: string }

export interface GameState {
  /** Nombre de quêtes choisi, null tant que le vote n'a pas eu lieu. */
  totalRounds: number | null;
  /** Numéro de la quête en cours (1..totalRounds), 0 avant la première. */
  round: number;
  /** Options du vote en cours (nombres de quêtes ou quêtes proposées). */
  options: VoteOption[];
  /** Vote de chaque joueur : id du joueur → id de l'option. */
  votes: Record<string, string>;
  /** Option retenue à l'issue du dernier vote. */
  chosen: VoteOption | null;
  /** true si le dernier vote s'est fini sur une égalité tranchée au hasard. */
  tie: boolean;
  /** Quêtes déjà jouées (ids), dans l'ordre. */
  played: string[];
  /** Pièces d'or de chaque joueur sur la soirée (déjà à jour : l'affichage les fait tomber après). */
  scores: Record<string, number>;
  /** Pièces gagnées au dernier mini-jeu, selon la place (montrées en `scoreReveal`), null sinon. */
  award: Record<string, number> | null;
  /** Révélation de l'imposteur de la dernière quête (rempli à `imposterReveal`). */
  reveal: ImposterReveal | null;
  /** Classement de la soirée, du plus riche au plus pauvre (rempli à `finale`). */
  final: FinalRank[] | null;
}

export interface ImposterReveal {
  imposterId: string;
  /** Pièces gagnées ou perdues par chacun lors de la révélation. */
  deltas: Record<string, number>;
  /**
   * Les pièces qui changent de main, dans l'ordre : d'abord des joueurs qui se sont trompés vers
   * l'imposteur (`stage` 1), puis de l'imposteur vers ceux qui l'ont démasqué (`stage` 2).
   */
  transfers: { from: string; to: string; stage: 1 | 2 }[];
  /** Nombre de joueurs qui l'ont démasqué. */
  found: number;
}

export type MinigameAction = 'pick' | 'deliver' | 'transform' | 'slash' | 'open' | 'inspect' | 'board' | 'curse' | 'sort';
export const MINIGAME_ACTIONS: readonly MinigameAction[] = ['pick', 'deliver', 'transform', 'slash', 'open', 'inspect', 'board', 'curse', 'sort'];

/** Information secrète de mini-jeu, pour un seul joueur. */
export type MinigameSecret = ChestSecret | MineSecret | GorgonSecret;

export interface Hit {
  from: string;
  to: string;
  /** true : coup de pied (en l'air), false : coup de poing. */
  kick: boolean;
  /** Direction du coup (normalisée), de l'attaquant vers la cible. */
  dir: [number, number];
}

export interface MinigameResult {
  id: string;
  /** Place (1 = gagnant). Des ex aequo partagent la même place. */
  rank: number;
  points: number;
  /** Temps passé sans se faire toucher (ms). */
  survivedMs: number;
}

/** État public d'un mini-jeu. Les positions (squelettes, bots) arrivent à part dans `mg:tick`. */
export interface MinigameState {
  /** Id de la quête jouée (voir quests.ts). */
  id: string;
  /** Bal des Squelettes : le cimetière. */
  arena: SkeletonArena | null;
  /** Pont Branlant : le parcours, et l'état de chaque coureur. */
  course: GorgeCourse | null;
  race: Record<string, RaceStatus> | null;
  /** Festin du Roi : manches, recette (seulement quand elle est montrée), échoppes, paniers, points. */
  market: MarketState | null;
  /** Tonneaux Fous : l'état de chaque grimpeur (les tonneaux arrivent dans `mg:tick`). */
  ramp: Record<string, RampStatus> | null;
  /** Horde de Gobelins : points et gobelins tués (les gobelins arrivent dans `mg:tick`). */
  horde: HordeState | null;
  /** Coffres Piégés : manches, tours, coffres ouverts (la mimique reste secrète). */
  chests: ChestsState | null;
  /** Wagonnets de la Mine : manches, voies, wagons choisis (la malédiction reste secrète jusqu'au départ). */
  mine: MineState | null;
  /** Bombe du Labyrinthe : le labyrinthe (tiré avant les règles), puis manches, bombe, éliminés. */
  labyrinth: Maze | null;
  bomb: BombState | null;
  /** Regard de la Gorgone : le cimetière (tiré avant les règles), puis le regard, les arrivées, les statues. */
  cemetery: GorgonField | null;
  gorgon: GorgonState | null;
  /** Course des Moutons : les arrivées (les moutons arrivent dans mg:tick). */
  sheep: SheepRaceState | null;
  /** Festival des Bombes : plateaux, boîtes, explosés. */
  fest: BombFestState | null;
  /** Centre de l'endroit où tombe le podium [x, z]. */
  podium: [number, number];
  /** Point de départ de chaque joueur [x, z]. */
  starts: Record<string, [number, number]>;
  /** Joueurs qui ont appuyé sur « Commencer » sur l'écran des règles. */
  ready: string[];
  /** Joueurs touchés : moment (ms depuis le début de mgPlay) et qui les a touchés (null = un squelette). */
  caught: Record<string, { at: number; by: string | null }>;
  /** Début de mgPlay (horloge serveur), null avant. */
  startedAt: number | null;
  results: MinigameResult[] | null;
}

/**
 * Positions envoyées par le serveur ~20 fois par seconde pendant `mgPlay`.
 * Les nombres sont arrondis au centième pour alléger les messages.
 */
export interface MinigameTick {
  /** ms depuis le début de mgPlay */
  t: number;
  /** Squelettes, dans leur ordre d'apparition : [x, z, angle, sortie de terre en cours 0/1]. */
  sk: [number, number, number, number][];
  /** Bots : [id, x, z, angle, animation, hauteur (chute)]. */
  bots: [string, number, number, number, string, number?][];
  /** Tonneaux Fous : [id, s, u, vs, vu] (repère de la rampe, voir barrels.ts). */
  br?: [number, number, number, number, number][];
  /** Horde de Gobelins : [id, x, z, angle, animation, doré 0/1]. */
  gb?: [number, number, number, number, string, number][];
  /** Course des Moutons : [id, x, z, angle, marche 0/1]. */
  sh?: [number, number, number, number, number][];
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Début et fin de la phase en cours (horloge serveur, ms) ; null en lobby. */
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  hostId: string;
  players: PlayerInfo[];
  game: GameState;
  /** Mini-jeu en cours (phases rules → mgResults), sinon null. */
  mg: MinigameState | null;
}

/** Position / orientation / animation d'un joueur, envoyée en continu. */
export interface Transform {
  p: [number, number, number];
  r: number;
  a: string;
}

export type JoinResult =
  | { ok: true; you: string; state: RoomState; serverTime: number }
  | { ok: false; error: JoinError };

export type JoinError = 'room_not_found' | 'room_full' | 'game_in_progress' | 'bad_code';

export interface ProfileUpdate { name: string; cfg: CharacterConfig }

export interface ClientToServerEvents {
  'room:create': (req: ProfileUpdate, ack: (res: JoinResult) => void) => void;
  'room:join': (req: ProfileUpdate & { code: string }, ack: (res: JoinResult) => void) => void;
  'room:leave': () => void;
  'player:profile': (p: ProfileUpdate) => void;
  'player:move': (t: Transform) => void;
  'seat:take': (seat: number, ack: (ok: boolean) => void) => void;
  'seat:leave': () => void;
  /** Voter pour une option du vote en cours (on peut changer d'avis tant que le vote est ouvert). */
  'vote:cast': (optionId: string) => void;
  /** Hôte uniquement, en lobby : ajouter / retirer un bot. */
  'bot:add': () => void;
  'bot:remove': (botId: string) => void;
  /** Écran des règles : « Commencer » (prêt). */
  'mg:ready': () => void;
  /** Action de mini-jeu : prendre, livrer, ou (imposteur) prendre en transformant ; `arg` : wagon choisi… */
  'mg:action': (kind: MinigameAction, arg?: number) => void;
  /** Podium : coup porté à un autre joueur (kick = coup de pied, dir = direction normalisée). */
  'mg:hit': (to: string, kick: boolean, dir: [number, number]) => void;
}

export interface ServerToClientEvents {
  'room:state': (s: RoomState) => void;
  'player:moved': (id: string, t: Transform) => void;
  'mg:tick': (tick: MinigameTick) => void;
  /** Rôle secret pour la quête en cours, envoyé à chaque joueur séparément (jamais dans room:state). */
  'role:secret': (role: { imposter: boolean; quest: string }) => void;
  /** Podium : un joueur en a frappé un autre (la cible applique le recul chez elle). */
  'player:hit': (hit: Hit) => void;
  /** Information secrète de mini-jeu pour un seul joueur (Coffres Piégés : ce que l'imposteur a vu ; Wagonnets : le wagon maudit). */
  'mg:secret': (s: MinigameSecret) => void;
}

export const JOIN_ERROR_TEXT: Record<JoinError, string> = {
  room_not_found: 'Aucune taverne ouverte avec ce code.',
  room_full: 'Cette taverne est pleine (4 aventuriers maximum).',
  game_in_progress: 'Une partie est déjà en cours dans cette taverne.',
  bad_code: 'Le code fait 4 lettres.',
};
