/**
 * « La Course des Moutons » : une course en ligne droite sur un chemin de campagne bordé de murets,
 * au milieu d'un troupeau qui erre au hasard. Les moutons sont des obstacles : on se cogne dedans,
 * on ne peut pas les pousser. Les premiers arrivés gagnent.
 * Imposteur : les moutons ont tendance à s'écarter de lui.
 * Partagé client/serveur : le chemin, les constantes, l'état public.
 */

export const SHEEP = {
  id: 'course-moutons',
  /** Demi-largeur du chemin (entre les murets). */
  halfX: 4.5,
  /** Départ (au nord) et arrivée (au sud, vers la caméra). */
  startZ: -42,
  finishZ: 42,
  /** Le chemin continue un peu après l'arrivée (on y freine ; le podium y tombe). */
  endZ: 54,
  /** Le troupeau. */
  count: 70,
  /** Rayon d'un mouton (collisions). */
  radius: 0.7,
  /** Vitesse d'un mouton qui marche (tirée jusqu'à ce maximum), et part de ceux qui broutent sur place. */
  walkMax: 2.4,
  grazeChance: 0.3,
  /** Il change d'idée toutes les… (ms) */
  changeMs: [900, 2800] as const,
  /** Avantage de l'imposteur : les moutons s'écartent de lui à moins de ça, à cette vitesse. */
  shyRadius: 4,
  shySpeed: 3.4,
  /** Rayon d'un coureur. */
  runnerR: 0.45,
  /** Bots (un humain court à 6,2). */
  botSpeed: 5.3,
  maxMs: 70_000,
  /** Le podium tombe après l'arrivée. */
  podium: [0, 48] as [number, number],
} as const;

/** Places de départ, sur la ligne (par place J1..J4). */
export const SHEEP_STARTS: readonly [number, number][] = [-2.7, -0.9, 0.9, 2.7].map((x) => [x, SHEEP.startZ] as [number, number]);

/** Zone où le troupeau erre (entre le départ et l'arrivée). */
export const FLOCK_Z: readonly [number, number] = [SHEEP.startZ + 6, SHEEP.finishZ - 3];

/** État public de la Course des Moutons (les moutons arrivent dans `mg:tick`). */
export interface SheepRaceState {
  /** Arrivés, dans l'ordre. */
  finished: string[];
  /** Temps d'arrivée (ms de jeu). */
  times: Record<string, number>;
}
