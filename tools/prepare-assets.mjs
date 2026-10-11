// Régénère client/public/assets à partir des packs KayKit (licence CC0, Kay Lousberg).
// Usage : cd tools && npm install && npm run assets
// - personnages : animations triées (KEEP_ANIMATIONS), armes conservées, données orphelines supprimées
// - décor : les modèles listés sont fusionnés dans un seul tavern-props.glb (un nœud racine par modèle)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');
const out = join(here, '../client/public/assets');
const io = new NodeIO();

const REPOS = {
  adventurers: 'KayKit-Character-Pack-Adventures-1.0',
  dungeon: 'KayKit-Dungeon-Remastered-1.0',
  furniture: 'KayKit-Furniture-Bits-1.0',
};

/** Animations gardées (toutes partagées par les 5 modèles ; seules celles du chevalier sont conservées). */
const KEEP_ANIMATIONS = new Set([
  'Idle', 'Unarmed_Idle', 'Running_A', 'Walking_A', 'Jump_Start', 'Jump_Idle', 'Jump_Land',
  'Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Punch_B', 'Unarmed_Melee_Attack_Kick',
  'Hit_A', 'Hit_B', 'Cheer', 'Interact', 'Use_Item', 'Dodge_Backward', 'Death_A',
  'Sit_Chair_Down', 'Sit_Chair_Idle', 'Sit_Chair_StandUp', 'Sit_Floor_Down', 'Sit_Floor_Idle',
  'Lie_Down', 'Lie_Idle', 'Lie_StandUp',
]);

const CHARACTERS = [
  // [fichier source, fichier produit, garder les animations, ne garder que la tête]
  ['Knight', 'knight', true, false],
  ['Mage', 'mage', false, false],
  ['Rogue', 'rogue', false, false],
  ['Rogue_Hooded', 'hood', false, true],
  ['Barbarian', 'barbarian', false, false],
];

const DUNGEON_PROPS = ['wall', 'wall_window_open', 'wall_doorway', 'wall_corner', 'wall_pillar', 'floor_wood_large', 'floor_wood_large_dark',
  'table_long_decorated_A', 'table_medium_decorated_A', 'table_small_decorated_A', 'table_medium', 'table_long', 'stool', 'chair',
  'keg', 'keg_decorated', 'barrel_large', 'barrel_small_stack', 'crates_stacked', 'shelves', 'shelf_large', 'shelf_small_candles',
  'bottle_A_brown', 'bottle_A_green', 'bottle_B_green', 'bottle_C_brown', 'bottle_A_labeled_brown', 'candle_lit', 'candle_triple',
  'torch_mounted', 'banner_patternA_red', 'banner_shield_blue', 'banner_patternB_green', 'plate_food_A', 'plate_stack', 'chest_gold',
  'coin_stack_large', 'sword_shield', 'pillar', 'column', 'box_stacked', 'trunk_large_A'];
const FURNITURE_PROPS = ['rug_rectangle_stripes_A', 'rug_oval_A', 'cabinet_medium_decorated', 'pictureframe_standing_A', 'chair_stool_wood',
  'armchair', 'shelf_B_large_decorated', 'lamp_standing', 'book_set'];

function fetchRepos() {
  mkdirSync(cache, { recursive: true });
  for (const name of Object.values(REPOS)) {
    const dir = join(cache, name);
    if (existsSync(dir)) continue;
    console.log(`Téléchargement de ${name}…`);
    execSync(`git clone --depth 1 https://github.com/KayKit-Game-Assets/${name}.git "${dir}"`, { stdio: 'inherit' });
  }
}

/** Supprime les accesseurs que plus rien n'utilise (données d'animations retirées). */
function dropOrphanAccessors(doc) {
  for (const a of doc.getRoot().listAccessors()) if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose();
}

async function buildCharacters() {
  const src = join(cache, REPOS.adventurers, 'addons/kaykit_character_pack_adventures/Characters/gltf');
  mkdirSync(join(out, 'characters'), { recursive: true });
  for (const [name, file, keepAnims, onlyHead] of CHARACTERS) {
    const doc = await io.read(join(src, `${name}.glb`));
    const root = doc.getRoot();
    for (const node of root.listNodes()) {
      if (!node.getMesh()) continue;
      const parent = node.getParentNode()?.getName() ?? '';
      if (onlyHead && (parent.startsWith('handslot') || !node.getName().includes('Head'))) node.dispose();
    }
    for (const a of root.listAnimations()) if (!keepAnims || !KEEP_ANIMATIONS.has(a.getName())) a.dispose();
    await doc.transform(prune());
    const target = join(out, 'characters', `${file}.glb`);
    await io.write(target, doc);
    // relecture : les données des animations retirées n'apparaissent orphelines qu'après une écriture
    const clean = await io.read(target);
    dropOrphanAccessors(clean);
    await clean.transform(dedup());
    await io.write(target, clean);
    console.log(`personnage ${file}.glb`);
  }
}

async function buildProps() {
  const sources = [
    [join(cache, REPOS.dungeon, 'addons/kaykit_dungeon_remastered/Assets/gltf'), DUNGEON_PROPS, ['.gltf.glb', '.glb']],
    [join(cache, REPOS.furniture, 'addons/kaykit_furniture_bits/Assets/gltf'), FURNITURE_PROPS, ['.gltf', '.glb']],
  ];
  const merged = new Document();
  merged.createBuffer();
  for (const [dir, names, exts] of sources) {
    for (const name of names) {
      const path = exts.map((e) => join(dir, name + e)).find(existsSync);
      if (!path) { console.warn(`introuvable : ${name}`); continue; }
      const doc = await io.read(path);
      const scene = doc.getRoot().listScenes()[0];
      const wrap = doc.createNode(name);
      for (const c of scene.listChildren()) { scene.removeChild(c); wrap.addChild(c); }
      scene.addChild(wrap);
      mergeDocuments(merged, doc);
    }
  }
  const [main, ...rest] = merged.getRoot().listScenes();
  for (const s of rest) { for (const c of s.listChildren()) { s.removeChild(c); main.addChild(c); } s.dispose(); }
  await merged.transform(unpartition(), dedup(), prune());
  mkdirSync(join(out, 'props'), { recursive: true });
  await io.write(join(out, 'props', 'tavern-props.glb'), merged);
  console.log('décor props/tavern-props.glb');
}

fetchRepos();
await buildCharacters();
await buildProps();
console.log('Assets prêts dans client/public/assets');
