/**
 * Grand podium de fin de soirée (phase `finale`) : le tavernier annonce les places de la dernière
 * à la première, chaque joueur apparaît sur sa marche avec ses pièces d'or.
 * Partagé : le serveur établit le classement et la durée de la phase, le client suit le même
 * programme à l'horloge du serveur (tout le monde voit les mêmes apparitions en même temps).
 */

export interface FinalRank {
  id: string;
  /** Place (1 = le plus riche). Des ex aequo partagent la même place. */
  rank: number;
  coins: number;
}

export const FINALE = {
  /** Le podium tombe, le tavernier prend la parole. */
  introMs: 3600,
  /** Temps entre deux places annoncées. */
  stepMs: 2800,
  /** Suspense en plus avant le vainqueur. */
  drumMs: 1600,
  /** Fête après l'annonce du vainqueur, avant le retour au lobby. */
  holdMs: 8000,
} as const;

/** Classement de la soirée : le plus de pièces d'abord ; à égalité, même place (ordre des places J1 à J4). */
export function finalRanking(players: readonly { id: string; slot: number }[], scores: Record<string, number>): FinalRank[] {
  const list = [...players].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0) || a.slot - b.slot)
    .map((p) => ({ id: p.id, rank: 0, coins: scores[p.id] ?? 0 }));
  list.forEach((f, i) => { f.rank = i > 0 && list[i - 1].coins === f.coins ? list[i - 1].rank : i + 1; });
  return list;
}

/** Moment (ms depuis le début de `finale`) où apparaît le joueur à l'indice `i` du classement, sur `n`. */
export function finaleRevealAt(i: number, n: number): number {
  return FINALE.introMs + (n - 1 - i) * FINALE.stepMs + (i === 0 && n > 1 ? FINALE.drumMs : 0);
}

/** Durée de la phase `finale` pour `n` joueurs. */
export const finaleMs = (n: number) => finaleRevealAt(0, Math.max(1, n)) + FINALE.holdMs;
