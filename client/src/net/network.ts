import { io, type Socket } from 'socket.io-client';
import {
  JOIN_ERROR_TEXT, type CharacterConfig, type MinigameSecret, type ClientToServerEvents, type Hit, type JoinResult, type MinigameAction, type MinigameTick,
  type RoomState, type ServerToClientEvents, type Transform,
} from '@oddone/shared';

/**
 * Connexion au serveur de jeu. Le serveur fait autorité sur le lobby
 * (codes, places, tabourets, compte à rebours) ; les positions sont relayées telles quelles.
 */

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface NetworkHandlers {
  onState(state: RoomState): void;
  onMoved(id: string, t: Transform): void;
  onConnectionChange(connected: boolean): void;
  /** Positions du mini-jeu (squelettes, bots). */
  onTick(tick: MinigameTick): void;
  /** Rôle secret pour la quête en cours. */
  onRole(role: { imposter: boolean; quest: string }): void;
  /** Un coup sur le podium. */
  onHit(hit: Hit): void;
  /** Information secrète de mini-jeu (Coffres Piégés : ce que l'imposteur a vu). */
  onSecret(s: MinigameSecret): void;
}

export class Network {
  readonly socket: GameSocket;
  myId = '';
  /** Écart horloge serveur − horloge locale (ms), pour afficher le compte à rebours. */
  clockOffset = 0;

  constructor(handlers: NetworkHandlers) {
    // Même origine : en dev, le proxy Vite relaie /socket.io vers le serveur.
    this.socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });
    this.socket.on('room:state', handlers.onState);
    this.socket.on('player:moved', handlers.onMoved);
    this.socket.on('mg:tick', handlers.onTick);
    this.socket.on('role:secret', handlers.onRole);
    this.socket.on('player:hit', handlers.onHit);
    this.socket.on('mg:secret', handlers.onSecret);
    this.socket.on('connect', () => handlers.onConnectionChange(true));
    this.socket.on('disconnect', () => handlers.onConnectionChange(false));
  }

  get connected(): boolean { return this.socket.connected; }

  private handleJoin(res: JoinResult): { state: RoomState } | { error: string } {
    if (!res.ok) return { error: JOIN_ERROR_TEXT[res.error] };
    this.myId = res.you;
    this.clockOffset = res.serverTime - Date.now();
    return { state: res.state };
  }

  create(name: string, cfg: CharacterConfig) {
    return this.socket.timeout(5000).emitWithAck('room:create', { name, cfg })
      .then((r) => this.handleJoin(r))
      .catch(() => ({ error: 'Le serveur ne répond pas. Est-il lancé ?' }));
  }

  join(code: string, name: string, cfg: CharacterConfig) {
    return this.socket.timeout(5000).emitWithAck('room:join', { code, name, cfg })
      .then((r) => this.handleJoin(r))
      .catch(() => ({ error: 'Le serveur ne répond pas. Est-il lancé ?' }));
  }

  leave(): void { this.socket.emit('room:leave'); this.myId = ''; }
  sendProfile(name: string, cfg: CharacterConfig): void { this.socket.emit('player:profile', { name, cfg }); }
  sendMove(t: Transform): void { this.socket.volatile.emit('player:move', t); }
  takeSeat(seat: number): Promise<boolean> { return this.socket.timeout(5000).emitWithAck('seat:take', seat).catch(() => false); }
  leaveSeat(): void { this.socket.emit('seat:leave'); }
  vote(optionId: string): void { this.socket.emit('vote:cast', optionId); }
  addBot(): void { this.socket.emit('bot:add'); }
  removeBot(id: string): void { this.socket.emit('bot:remove', id); }
  minigameReady(): void { this.socket.emit('mg:ready'); }
  hit(to: string, kick: boolean, dir: [number, number]): void { this.socket.emit('mg:hit', to, kick, dir); }
  action(kind: MinigameAction, arg?: number): void { this.socket.emit('mg:action', kind, arg); }
  /** Heure du serveur estimée (ms). */
  serverNow(): number { return Date.now() + this.clockOffset; }
}
