import type { MinigameSecret, Hit, MinigameAction, MinigameResult, MinigameTick, Point } from '@oddone/shared';

/** Un participant au départ d'un mini-jeu. */
export interface SimEntrant { id: string; bot: boolean; imposter: boolean; start: [number, number] }

export interface SimStep {
  done: boolean;
  /** L'état public du mini-jeu a changé (à diffuser par room:state). */
  changed: boolean;
  /** Coups portés par les bots pendant ce pas. */
  hits: Hit[];
}

/** Ce que `rooms.ts` attend de la simulation de n'importe quel mini-jeu. */
export interface MinigameSim {
  elapsed: number;
  readonly isFinished: boolean;
  /** Durée maximale de la partie (filet de sécurité du minuteur de mgPlay). */
  readonly maxMs: number;
  step(dtMs: number): SimStep;
  tick(): MinigameTick;
  results(): MinigameResult[];
  /** Position d'un humain (y : hauteur, pour les mini-jeux où l'on saute par-dessus quelque chose). */
  setHumanPosition(id: string, x: number, z: number, y?: number, yaw?: number): void;
  remove(id: string): void;
  /** Un humain a poussé ou frappé un bot pendant la partie. */
  knock?(id: string, dir: [number, number]): void;
  position?(id: string): Point | undefined;
  /** Action d'un joueur (prendre, livrer…) ; true si elle a changé l'état public. */
  action?(id: string, kind: MinigameAction, arg?: number): boolean;
  /** Informations secrètes à envoyer à un seul joueur (vidées à chaque appel). */
  secrets?(): { to: string; data: MinigameSecret }[];
}
