import type { CharacterConfig } from './catalog.ts';

/** Règles du lobby, partagées client/serveur. */
export const MAX_PLAYERS = 4;
export const SEAT_COUNT = 4;
export const CODE_LENGTH = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O, trop proches de 1 et 0
/** Nombre minimum de joueurs assis pour lancer la partie (1 pour tester seul). */
export const MIN_PLAYERS_TO_START = 1;
export const COUNTDOWN_MS = 5000;
/** TODO mini-jeux : durée d'une manche factice avant le retour au comptoir. */
export const PLACEHOLDER_ROUND_MS = 6000;
/** Fréquence d'envoi des positions par le client. */
export const MOVE_RATE_HZ = 15;

export type Phase = 'lobby' | 'countdown' | 'playing';

export interface PlayerInfo {
  id: string;
  name: string;
  cfg: CharacterConfig;
  /** Place 0..3 (couleur J1..J4), attribuée par le serveur. */
  slot: number;
  /** Tabouret occupé (0..3) ou -1. Être assis = être prêt. */
  seat: number;
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Horodatage serveur (ms) de fin du compte à rebours, sinon null. */
  countdownEndsAt: number | null;
  hostId: string;
  players: PlayerInfo[];
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
}

export interface ServerToClientEvents {
  'room:state': (s: RoomState) => void;
  'player:moved': (id: string, t: Transform) => void;
  'game:start': (info: { round: number }) => void;
}

export const JOIN_ERROR_TEXT: Record<JoinError, string> = {
  room_not_found: 'Aucune taverne ouverte avec ce code.',
  room_full: 'Cette taverne est pleine (4 aventuriers maximum).',
  game_in_progress: 'Une partie est déjà en cours dans cette taverne.',
  bad_code: 'Le code fait 4 lettres.',
};
