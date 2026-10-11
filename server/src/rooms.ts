import {
  CODE_ALPHABET, CODE_LENGTH, COUNTDOWN_MS, MAX_PLAYERS, MIN_PLAYERS_TO_START, PLACEHOLDER_ROUND_MS, SEAT_COUNT,
  sanitizeConfig, sanitizeName,
  type JoinError, type Phase, type PlayerInfo, type ProfileUpdate, type RoomState,
} from '@oddone/shared';

/**
 * Logique pure des tavernes (lobbies), sans réseau : facile à tester.
 * Le serveur Socket.io appelle ces méthodes et diffuse `snapshot()` après chaque changement.
 */

export interface Room {
  code: string;
  phase: Phase;
  countdownEndsAt: number | null;
  hostId: string;
  players: Map<string, PlayerInfo>;
  round: number;
}

export interface RoomEvents {
  /** L'état d'une taverne a changé : le diffuser à ses joueurs. */
  changed(room: Room): void;
  /** Le compte à rebours est terminé : la manche démarre. */
  started(room: Room): void;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private events: RoomEvents, private now: () => number = Date.now, private random: () => number = Math.random) {}

  create(playerId: string, profile: ProfileUpdate): Room {
    let code = this.newCode();
    while (this.rooms.has(code)) code = this.newCode();
    const room: Room = { code, phase: 'lobby', countdownEndsAt: null, hostId: playerId, players: new Map(), round: 0 };
    this.rooms.set(code, room);
    this.addPlayer(room, playerId, profile);
    return room;
  }

  join(playerId: string, rawCode: unknown, profile: ProfileUpdate): Room | JoinError {
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase().replace(/[^A-Z]/g, '') : '';
    if (code.length !== CODE_LENGTH) return 'bad_code';
    const room = this.rooms.get(code);
    if (!room) return 'room_not_found';
    if (room.players.size >= MAX_PLAYERS) return 'room_full';
    if (room.phase === 'playing') return 'game_in_progress';
    this.addPlayer(room, playerId, profile);
    this.cancelCountdown(room); // un nouvel arrivant debout annule le départ
    this.events.changed(room);
    return room;
  }

  leave(playerId: string, room: Room): void {
    room.players.delete(playerId);
    if (room.players.size === 0) {
      this.cancelCountdown(room);
      this.rooms.delete(room.code);
      return;
    }
    if (room.hostId === playerId) room.hostId = room.players.keys().next().value!;
    this.evaluateReady(room);
    this.events.changed(room);
  }

  updateProfile(playerId: string, room: Room, profile: ProfileUpdate): void {
    const p = room.players.get(playerId);
    if (!p) return;
    p.name = sanitizeName(profile?.name);
    p.cfg = sanitizeConfig(profile?.cfg);
    this.events.changed(room);
  }

  takeSeat(playerId: string, room: Room, seat: unknown): boolean {
    const p = room.players.get(playerId);
    if (!p || room.phase === 'playing') return false;
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return false;
    for (const other of room.players.values()) if (other !== p && other.seat === seat) return false;
    p.seat = seat;
    this.evaluateReady(room);
    this.events.changed(room);
    return true;
  }

  leaveSeat(playerId: string, room: Room): void {
    const p = room.players.get(playerId);
    if (!p || p.seat < 0) return;
    p.seat = -1;
    this.evaluateReady(room);
    this.events.changed(room);
  }

  snapshot(room: Room): RoomState {
    return {
      code: room.code,
      phase: room.phase,
      countdownEndsAt: room.countdownEndsAt,
      hostId: room.hostId,
      players: [...room.players.values()].sort((a, b) => a.slot - b.slot),
    };
  }

  /** Tout le monde assis (et assez de monde) → compte à rebours ; sinon on l'annule. */
  private evaluateReady(room: Room): void {
    if (room.phase === 'playing') return;
    const players = [...room.players.values()];
    const allSeated = players.length >= MIN_PLAYERS_TO_START && players.every((p) => p.seat >= 0);
    if (allSeated && room.phase === 'lobby') {
      room.phase = 'countdown';
      room.countdownEndsAt = this.now() + COUNTDOWN_MS;
      this.timers.set(room.code, setTimeout(() => this.start(room), COUNTDOWN_MS));
    } else if (!allSeated) {
      this.cancelCountdown(room);
    }
  }

  private cancelCountdown(room: Room): void {
    const t = this.timers.get(room.code);
    if (t) clearTimeout(t);
    this.timers.delete(room.code);
    if (room.phase === 'countdown') { room.phase = 'lobby'; room.countdownEndsAt = null; }
  }

  private start(room: Room): void {
    this.timers.delete(room.code);
    if (!this.rooms.has(room.code) || room.phase !== 'countdown') return;
    room.phase = 'playing';
    room.countdownEndsAt = null;
    room.round += 1;
    this.events.changed(room);
    this.events.started(room);
    // TODO mini-jeux : remplacer cette manche factice par la vraie boucle de jeu.
    this.timers.set(room.code, setTimeout(() => this.endRound(room), PLACEHOLDER_ROUND_MS));
  }

  /** Fin de manche : tout le monde se lève et revient au lobby. */
  endRound(room: Room): void {
    this.timers.delete(room.code);
    if (!this.rooms.has(room.code)) return;
    room.phase = 'lobby';
    for (const p of room.players.values()) p.seat = -1;
    this.events.changed(room);
  }

  private addPlayer(room: Room, id: string, profile: ProfileUpdate): void {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    room.players.set(id, { id, name: sanitizeName(profile?.name), cfg: sanitizeConfig(profile?.cfg), slot, seat: -1 });
  }

  private newCode(): string {
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
    return s;
  }
}
