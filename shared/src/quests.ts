/**
 * Les quêtes proposées par le tavernier. Chaque quête = un mini-jeu.
 * Pour brancher un vrai mini-jeu, garder le même `id` côté client et serveur.
 */

export interface Quest {
  id: string;
  /** Nom affiché sur la carte de quête. */
  name: string;
  /** true quand le mini-jeu est codé (sinon la quête est une simple pause). */
  playable?: boolean;
}

export const QUESTS: readonly Quest[] = [
  // (les quêtes sans mini-jeu, de simples pauses, ont été retirées pour l'instant)
  { id: 'bal-squelettes', name: 'Le Bal des Squelettes', playable: true },
  { id: 'festin-roi', name: 'Le Festin du Roi', playable: true },
  { id: 'pont-branlant', name: 'Le Pont Branlant', playable: true },
  { id: 'tonneaux-fous', name: 'Les Tonneaux Fous', playable: true },
  { id: 'horde-gobelins', name: 'La Horde de Gobelins', playable: true },
  { id: 'coffres-pieges', name: 'Les Coffres Piégés', playable: true },
  { id: 'wagonnets-mine', name: 'Les Wagonnets de la Mine', playable: true },
  { id: 'bombe-labyrinthe', name: 'La Bombe du Labyrinthe', playable: true },
  { id: 'regard-gorgone', name: 'Le Regard de la Gorgone', playable: true },
  { id: 'course-moutons', name: 'La Course des Moutons', playable: true },
  { id: 'festival-bombes', name: 'Le Festival des Bombes', playable: true },
];

export const QUEST_BY_ID: ReadonlyMap<string, Quest> = new Map(QUESTS.map((q) => [q.id, q]));

/** Nombre de quêtes proposées par le tavernier à chaque manche. */
export const QUEST_CHOICES = 3;
/** Choix possibles pour la longueur de la soirée. */
export const ROUND_CHOICES: readonly number[] = [3, 5, 7];

export const isPlayable = (id: string | undefined) => !!id && !!QUEST_BY_ID.get(id)?.playable;
