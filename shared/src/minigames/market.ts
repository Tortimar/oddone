import type { Bounds, Circle } from '../geometry.ts';

/**
 * « Le Festin du Roi » : marché du village, partagé client/serveur.
 *
 * Les joueurs apparaissent sur la place, entourée d'une dizaine d'échoppes ; au centre, la grande
 * marmite. Chaque manche : la recette du roi (3 ingrédients) s'affiche quelques secondes puis
 * disparaît. Il faut alors retrouver ces ingrédients sur les comptoirs (répartis au hasard, ils
 * changent à chaque manche) et les rapporter à la marmite. 1er : 5 points, puis 3, 2, 1.
 * Après 5 manches, le classement donne les points habituels (4, 3, 2, 1).
 * Imposteur : en plus de « prendre », il peut une fois par manche prendre un produit et le
 * transformer en un ingrédient de la recette.
 */

export const MARKET = {
  id: 'festin-roi',
  rounds: 5,
  /** La recette reste affichée… */
  showMs: 5000,
  /** …puis on a ce temps pour la préparer. */
  huntMs: 40_000,
  /** Pause entre deux manches (résultats de la manche). */
  pauseMs: 4000,
  /** Points de chaque manche selon l'ordre de livraison. */
  roundPoints: [5, 3, 2, 1],
  recipeSize: 3,
  /** Ingrédients qu'on peut porter à la fois. */
  carry: 3,
  bounds: { halfX: 12.5, halfZ: 12 } as Bounds,
  /** Rayon du cercle des échoppes. */
  stallRadius: 9.8,
  /** Distance à laquelle on peut se servir sur un comptoir (depuis le devant de l'échoppe). */
  pickRadius: 2.2,
  cauldronRadius: 1.5,
  /** Distance à la marmite pour y verser ses ingrédients. */
  deliverRadius: 3.2,
  botSpeed: 4.8,
} as const;

export interface Ingredient {
  id: string;
  name: string;
  /** Modèle de l'ingrédient seul (kit indiqué). */
  model: string;
  kit: 'restaurant' | 'halloween';
  /** Caisse exposée sur le comptoir (kit restaurant), ou null : caisse vide + l'ingrédient posé dessus. */
  crate: string | null;
}

export const INGREDIENTS: readonly Ingredient[] = [
  { id: 'carotte', name: 'Carotte', model: 'food_ingredient_carrot', kit: 'restaurant', crate: 'crate_carrots' },
  { id: 'fromage', name: 'Fromage', model: 'food_ingredient_cheese', kit: 'restaurant', crate: 'crate_cheese' },
  { id: 'jambon', name: 'Jambon', model: 'food_ingredient_ham', kit: 'restaurant', crate: 'crate_ham' },
  { id: 'salade', name: 'Salade', model: 'food_ingredient_lettuce', kit: 'restaurant', crate: 'crate_lettuce' },
  { id: 'oignon', name: 'Oignon', model: 'food_ingredient_onion', kit: 'restaurant', crate: 'crate_onions' },
  { id: 'patate', name: 'Pomme de terre', model: 'food_ingredient_potato', kit: 'restaurant', crate: 'crate_potatoes' },
  { id: 'steak', name: 'Steak', model: 'food_ingredient_steak', kit: 'restaurant', crate: 'crate_steak' },
  { id: 'tomate', name: 'Tomate', model: 'food_ingredient_tomato', kit: 'restaurant', crate: 'crate_tomatoes' },
  { id: 'pain', name: 'Pain', model: 'food_ingredient_bun', kit: 'restaurant', crate: 'crate_buns' },
  { id: 'citrouille', name: 'Citrouille', model: 'pumpkin_orange_small', kit: 'halloween', crate: null },
];
export const INGREDIENT_BY_ID: ReadonlyMap<string, Ingredient> = new Map(INGREDIENTS.map((i) => [i.id, i]));

/** Les échoppes, en cercle autour de la marmite, tournées vers elle. */
export const STALLS: readonly { x: number; z: number; yaw: number }[] = Array.from({ length: INGREDIENTS.length }, (_, i) => {
  const a = ((i + 0.5) / INGREDIENTS.length) * Math.PI * 2;
  const x = Math.sin(a) * MARKET.stallRadius, z = Math.cos(a) * MARKET.stallRadius;
  return { x, z, yaw: Math.atan2(-x, -z) }; // face au centre
});

/** Devant du comptoir : là où l'on se tient pour se servir. */
export function stallFront(i: number): [number, number] {
  const s = STALLS[i], k = (MARKET.stallRadius - 2.1) / MARKET.stallRadius;
  return [s.x * k, s.z * k];
}

/** Obstacles : la marmite et chaque échoppe (un cercle suffit). */
export const MARKET_CIRCLES: readonly Circle[] = [
  { x: 0, z: 0, r: MARKET.cauldronRadius },
  ...STALLS.map((s) => ({ x: s.x, z: s.z, r: 1.25 })),
];

/** Places de départ (par place J1..J4), autour de la marmite. */
export const MARKET_STARTS: readonly [number, number][] = [[-2.6, 2.6], [2.6, 2.6], [-2.6, -2.6], [2.6, -2.6]];

export type MarketStage = 'show' | 'hunt' | 'pause';

/** Ce qui vient de se passer pour un joueur (pour l'afficher) : livraison réussie ou ratée. */
export interface MarketEvent { id: string; kind: 'ok' | 'fail' | 'pick' | 'magic'; at: number; item?: string; points?: number }

/** État public de la partie (dans `mg.market`). */
export interface MarketState {
  /** Manche en cours (1..rounds). */
  round: number;
  stage: MarketStage;
  /** Fin de l'étape en cours (ms de jeu, depuis le début de mgPlay). */
  stageEndsAt: number;
  /** La recette, seulement pendant `show` (ensuite, il faut s'en souvenir !). */
  recipe: string[] | null;
  /** Ingrédient vendu par chaque échoppe (même ordre que STALLS). */
  stalls: string[];
  /** Ce que porte chacun. */
  carry: Record<string, string[]>;
  /** Ordre de livraison de la manche en cours. */
  delivered: string[];
  /** Points de manche cumulés. */
  points: Record<string, number>;
  /** Derniers événements (les plus récents à la fin). */
  events: MarketEvent[];
}

/** Échoppe la plus proche à portée de main, ou −1. */
export function stallInReach(x: number, z: number): number {
  let best = -1, bestD: number = MARKET.pickRadius;
  STALLS.forEach((_, i) => {
    const [fx, fz] = stallFront(i), d = Math.hypot(x - fx, z - fz);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export const nearCauldron = (x: number, z: number) => Math.hypot(x, z) <= MARKET.deliverRadius;
