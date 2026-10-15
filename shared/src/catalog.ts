/**
 * Catalogue de personnalisation : la même liste sert au client (atelier, rendu)
 * et au serveur (validation de ce que les joueurs envoient).
 */

export type Option = readonly [value: string, label: string];

/** Classes KayKit dont on peut prendre les pièces (même squelette pour toutes). */
export type KitClass = 'knight' | 'mage' | 'rogue' | 'hood' | 'barbarian';

export const BODIES: readonly Option[] = [['knight', 'Chevalier'], ['mage', 'Mage'], ['rogue', 'Voleur'], ['barbarian', 'Barbare']];
export const HEADS: readonly Option[] = [['knight', 'Chevalier'], ['mage', 'Mage'], ['rogue', 'Voleur'], ['hood', 'Capuche'], ['barbarian', 'Barbare']];
export const HATS: readonly Option[] = [['none', 'Aucun'], ['knight', 'Heaume'], ['mage', 'Chapeau pointu'], ['barbarian', 'Casque à cornes']];
export const CAPES: readonly Option[] = [['none', 'Aucune'], ['knight', 'Chevalier'], ['mage', 'Mage'], ['rogue', 'Voleur'], ['barbarian', 'Barbare']];
/** Objets tenus : "classe:NomDuMeshDansLeGlb". */
export const RIGHT_HAND: readonly Option[] = [['none', 'Rien'], ['knight:1H_Sword', 'Épée'], ['knight:2H_Sword', 'Grande épée'], ['barbarian:1H_Axe', 'Hache'], ['barbarian:2H_Axe', 'Grande hache'], ['mage:1H_Wand', 'Baguette'], ['mage:2H_Staff', 'Bâton'], ['rogue:Knife', 'Dague'], ['rogue:1H_Crossbow', 'Arbalète'], ['barbarian:Mug', 'Chope']];
export const LEFT_HAND: readonly Option[] = [['none', 'Rien'], ['knight:Round_Shield', 'Bouclier rond'], ['knight:Badge_Shield', 'Écusson'], ['knight:Rectangle_Shield', 'Pavois'], ['knight:Spike_Shield', 'À pointes'], ['barbarian:Barbarian_Round_Shield', 'Viking'], ['mage:Spellbook_open', 'Grimoire'], ['rogue:Knife_Offhand', 'Dague']];
export const FACE_ACC: readonly Option[] = [['none', 'Aucun'], ['glasses', 'Lunettes'], ['shades', 'Lunettes noires'], ['mustache', 'Moustache'], ['mask', 'Masque de héros'], ['patch', 'Cache-œil']];
export const TOP_ACC: readonly Option[] = [['none', 'Aucun'], ['halo', 'Auréole'], ['crown', 'Couronne'], ['antennas', 'Antennes'], ['flower', 'Fleur'], ['ears', 'Oreilles de chat'], ['propeller', 'Hélice'], ['horn', 'Corne de licorne']];
export const NECK_ACC: readonly Option[] = [['none', 'Aucun'], ['medal', 'Médaille'], ['scarf', 'Écharpe'], ['bowtie', 'Nœud pap']];
export const BACK_ACC: readonly Option[] = [['none', 'Aucun'], ['backpack', 'Sac à dos'], ['wings', 'Ailes'], ['jetpack', 'Jetpack'], ['shell', 'Carapace']];
export const SIZES: readonly Option[] = [['0.86', 'Petit'], ['1', 'Normal'], ['1.14', 'Costaud']];

/** Teintes de tenue (degrés HSL) ; null = couleurs d'origine. */
export const HUES: readonly (number | null)[] = [null, 0, 22, 48, 95, 140, 175, 200, 228, 262, 295, 325];
/** Tons de peau ; null = peau d'origine. */
export const SKINS: readonly (string | null)[] = [null, '#f7c7a4', '#e0a27a', '#b97852', '#7e4e31', '#9be7ff', '#a8f0a0'];
export const ACCESSORY_COLORS: readonly string[] = ['#ffd23f', '#ff5fa2', '#3d8bff', '#5bd16b', '#ff7a3d', '#a66bff', '#2ec4b6', '#f2efff', '#3a3d4a', '#7a4a2a'];

/** Couleur de chaque place de joueur (J1..J4). */
export const SLOT_COLORS: readonly string[] = ['#e8413c', '#2f7de1', '#f2b81e', '#36b24a'];

export interface CharacterConfig {
  body: string;
  head: string;
  hat: string;
  cape: string;
  hue: number | null;
  skin: string | null;
  face: string;
  top: string;
  neck: string;
  back: string;
  right: string;
  left: string;
  acol: string;
  size: string;
}

export const DEFAULT_CONFIG: Readonly<CharacterConfig> = Object.freeze({
  body: 'knight', head: 'rogue', hat: 'none', cape: 'knight', hue: null, skin: null,
  face: 'none', top: 'none', neck: 'none', back: 'none', right: 'none', left: 'none',
  acol: '#ffd23f', size: '1',
});

/** Champs à liste fermée → options autorisées. */
export const CONFIG_OPTIONS = {
  body: BODIES, head: HEADS, hat: HATS, cape: CAPES, face: FACE_ACC, top: TOP_ACC,
  neck: NECK_ACC, back: BACK_ACC, right: RIGHT_HAND, left: LEFT_HAND, size: SIZES,
} as const;

/** Ne garde que des valeurs connues : tout le reste retombe sur la valeur par défaut. */
export function sanitizeConfig(input: unknown): CharacterConfig {
  const out: CharacterConfig = { ...DEFAULT_CONFIG };
  if (!input || typeof input !== 'object') return out;
  const c = input as Record<string, unknown>;
  for (const key of Object.keys(CONFIG_OPTIONS) as (keyof typeof CONFIG_OPTIONS)[]) {
    const v = c[key];
    if (typeof v === 'string' && CONFIG_OPTIONS[key].some(([value]) => value === v)) out[key] = v;
  }
  if (c.hue === null || (typeof c.hue === 'number' && HUES.includes(c.hue))) out.hue = c.hue as number | null;
  if (c.skin === null || (typeof c.skin === 'string' && SKINS.includes(c.skin))) out.skin = c.skin as string | null;
  if (typeof c.acol === 'string' && ACCESSORY_COLORS.includes(c.acol)) out.acol = c.acol;
  return out;
}

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
export const MAX_NAME_LENGTH = 12;

export function sanitizeName(input: unknown): string {
  const s = typeof input === 'string' ? input.replace(INVISIBLE, '').trim().slice(0, MAX_NAME_LENGTH) : '';
  return s || 'Aventurier';
}

const pick = <T>(a: readonly T[], rnd: () => number) => a[Math.floor(rnd() * a.length)];
const maybe = (a: readonly Option[], p: number, rnd: () => number) => (rnd() < p ? pick(a.slice(1), rnd)[0] : 'none');

/** Tenue tirée au hasard (bouton « Aléatoire » de l'atelier, bots). */
export function randomConfig(rnd: () => number = Math.random): CharacterConfig {
  return {
    body: pick(BODIES, rnd)[0], head: pick(HEADS, rnd)[0], hat: maybe(HATS, 0.4, rnd), cape: maybe(CAPES, 0.6, rnd),
    hue: pick(HUES, rnd), skin: pick(SKINS, rnd), top: maybe(TOP_ACC, 0.4, rnd), face: maybe(FACE_ACC, 0.5, rnd),
    // (le gabarit et les objets en main ne se choisissent plus à l'atelier : taille normale, mains vides)
    neck: maybe(NECK_ACC, 0.4, rnd), back: maybe(BACK_ACC, 0.4, rnd), right: 'none',
    left: 'none', acol: pick(ACCESSORY_COLORS, rnd), size: '1',
  };
}

/** Noms des bots de test. */
export const BOT_NAMES: readonly string[] = ['Bot Gaston', 'Bot Ysolde', 'Bot Bertrand', 'Bot Mélusine', 'Bot Perceval', 'Bot Guenièvre', 'Bot Tristan', 'Bot Ondine'];
