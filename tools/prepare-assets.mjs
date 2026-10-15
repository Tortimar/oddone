// Régénère client/public/assets à partir des packs KayKit (licence CC0, Kay Lousberg).
// Usage : cd tools && npm install && npm run assets
//
// Produit :
//   characters/<classe>.glb      pièces des héros (sans animations), armes comprises
//   characters/skeleton_*.glb    squelettes ennemis (même squelette d'os que les héros)
//   characters/animations.glb    toutes les animations partagées (os uniquement, aucun mesh)
//   kits/<pack>.glb              un pack de décor entier, un nœud racine par modèle (nom = fichier KayKit)
//   kits/<pack>.json             manifeste du pack : nom, dimensions et catégorie de chaque modèle
// Les kits sont compressés avec meshopt (le client les décode avec MeshoptDecoder).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, meshopt, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');
const out = join(here, '../client/public/assets');
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/** Dépôts GitHub officiels de KayKit (tous en CC0). */
const REPOS = {
  adventurers: 'KayKit-Character-Pack-Adventures-1.0',
  skeletons: 'KayKit-Character-Pack-Skeletons-1.0',
  dungeon: 'KayKit-Dungeon-Remastered-1.0',
  furniture: 'KayKit-Furniture-Bits-1.0',
  restaurant: 'KayKit-Restaurant-Bits-1.0',
  halloween: 'KayKit-Halloween-Bits-1.0',
  prototype: 'KayKit-Prototype-Bits-1.0',
  medieval: 'KayKit-Medieval-Hexagon-Pack-1.0',
};

/** Animations gardées. Elles viennent du pack Skeletons, qui contient celles des héros + des extras. */
const KEEP_ANIMATIONS = new Set([
  // déplacements et poses
  'Idle', 'Idle_B', 'Idle_Combat', 'Unarmed_Idle', 'Walking_A', 'Running_A', 'Running_C', 'Dodge_Backward', 'Dodge_Forward',
  'Jump_Start', 'Jump_Idle', 'Jump_Land', 'Cheer', 'Interact', 'Use_Item', 'PickUp', 'Throw', 'Taunt', 'Taunt_Longer',
  // combat
  'Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Punch_B', 'Unarmed_Melee_Attack_Kick',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Jump_Chop', '2H_Melee_Attack_Spin',
  'Block', 'Hit_A', 'Hit_B', 'Spellcast_Shoot', 'Spellcast_Summon',
  // chutes, morts, relevés
  'Death_A', 'Death_B', 'Lie_Down', 'Lie_Idle', 'Lie_StandUp',
  'Death_C_Skeletons', 'Death_C_Skeletons_Resurrect', 'Spawn_Ground', 'Spawn_Ground_Skeletons', 'Skeletons_Awaken_Standing',
  // assis
  'Sit_Chair_Down', 'Sit_Chair_Idle', 'Sit_Chair_StandUp', 'Sit_Floor_Down', 'Sit_Floor_Idle', 'Sit_Floor_StandUp',
]);

const ADVENTURERS = 'addons/kaykit_character_pack_adventures/Characters/gltf';
const SKELETONS = 'addons/kaykit_character_pack_skeletons/Characters/gltf';
const CHARACTERS = [
  // [dépôt, dossier, fichier source, fichier produit, ne garder que la tête]
  ['adventurers', ADVENTURERS, 'Knight', 'knight', false],
  ['adventurers', ADVENTURERS, 'Mage', 'mage', false],
  ['adventurers', ADVENTURERS, 'Rogue', 'rogue', false],
  ['adventurers', ADVENTURERS, 'Rogue_Hooded', 'hood', true],
  ['adventurers', ADVENTURERS, 'Barbarian', 'barbarian', false],
  ['skeletons', SKELETONS, 'Skeleton_Minion', 'skeleton_minion', false],
  ['skeletons', SKELETONS, 'Skeleton_Warrior', 'skeleton_warrior', false],
  ['skeletons', SKELETONS, 'Skeleton_Rogue', 'skeleton_rogue', false],
  ['skeletons', SKELETONS, 'Skeleton_Mage', 'skeleton_mage', false],
];

/** Packs de décor : dossiers glTF à fusionner (la catégorie = sous-dossier, utile pour le catalogue). */
const KITS = {
  dungeon: ['addons/kaykit_dungeon_remastered/Assets/gltf'],
  furniture: ['addons/kaykit_furniture_bits/Assets/gltf'],
  restaurant: ['addons/kaykit_restaurant_bits/Assets/gltf'],
  halloween: ['addons/kaykit_halloween_bits/Assets/gltf'],
  prototype: ['addons/kaykit_prototype_bits/Assets/gltf'],
  medieval: ['addons/kaykit_medieval_hexagon_pack/Assets/gltf'],
  skeletons: ['addons/kaykit_character_pack_skeletons/Assets/gltf'], // armes et boucliers des squelettes
};

function fetchRepos() {
  mkdirSync(cache, { recursive: true });
  for (const name of Object.values(REPOS)) {
    const dir = join(cache, name);
    if (existsSync(dir)) continue;
    console.log(`Téléchargement de ${name}…`);
    execSync(`git clone --depth 1 https://github.com/KayKit-Game-Assets/${name}.git "${dir}"`, { stdio: 'inherit' });
  }
}

const repoPath = (repo, ...p) => join(cache, REPOS[repo], ...p);

/** Supprime les accesseurs que plus rien n'utilise (données d'animations retirées). */
function dropOrphanAccessors(doc) {
  for (const a of doc.getRoot().listAccessors()) if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose();
}

/** Écrit, relit et nettoie : les données retirées n'apparaissent orphelines qu'après une écriture. */
async function writeClean(doc, target) {
  await doc.transform(prune());
  await io.write(target, doc);
  const clean = await io.read(target);
  dropOrphanAccessors(clean);
  await clean.transform(dedup());
  await io.write(target, clean);
}

async function buildCharacters() {
  mkdirSync(join(out, 'characters'), { recursive: true });
  for (const [repo, folder, name, file, onlyHead] of CHARACTERS) {
    const doc = await io.read(repoPath(repo, folder, `${name}.glb`));
    const root = doc.getRoot();
    for (const node of root.listNodes()) {
      if (!node.getMesh()) continue;
      const parent = node.getParentNode()?.getName() ?? '';
      if (onlyHead && (parent.startsWith('handslot') || !node.getName().includes('Head'))) node.dispose();
    }
    for (const a of root.listAnimations()) a.dispose();
    await writeClean(doc, join(out, 'characters', `${file}.glb`));
    console.log(`personnage ${file}.glb`);
  }
}

/** Un fichier d'os animés, sans aucun mesh : les clips s'appliquent à tout perso KayKit par nom d'os. */
async function buildAnimations() {
  const doc = await io.read(repoPath('skeletons', SKELETONS, 'Skeleton_Minion.glb'));
  const root = doc.getRoot();
  for (const node of root.listNodes()) {
    if (node.getMesh()) { node.setMesh(null); node.setSkin(null); }
  }
  for (const m of root.listMeshes()) m.dispose();
  for (const a of root.listAnimations()) if (!KEEP_ANIMATIONS.has(a.getName())) a.dispose();
  const missing = [...KEEP_ANIMATIONS].filter((n) => !root.listAnimations().some((a) => a.getName() === n));
  if (missing.length) console.warn('animations introuvables :', missing.join(', '));
  await writeClean(doc, join(out, 'characters', 'animations.glb'));
  console.log(`animations.glb (${root.listAnimations().length} clips)`);
}

function walk(dir) {
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(gltf|glb)$/.test(f) ? [p] : [];
  });
}

async function buildKit(kit, folders) {
  const merged = new Document();
  merged.createBuffer();
  const manifest = [];
  const seen = new Set();
  for (const folder of folders) {
    const base = repoPath(kit === 'skeletons' ? 'skeletons' : kit, folder);
    for (const file of walk(base)) {
      const name = basename(file).replace(/\.gltf\.glb$|\.gltf$|\.glb$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const doc = await io.read(file);
      const scene = doc.getRoot().listScenes()[0];
      const b = getBounds(scene);
      const wrap = doc.createNode(name);
      for (const c of scene.listChildren()) { scene.removeChild(c); wrap.addChild(c); }
      scene.addChild(wrap);
      for (const a of doc.getRoot().listAnimations()) a.dispose();
      mergeDocuments(merged, doc);
      const category = dirname(relative(base, file)).split(sep).filter((s) => s !== '.').join('/');
      manifest.push({
        name,
        category: category || null,
        size: b.max.map((v, i) => +(v - b.min[i]).toFixed(2)),
        min: b.min.map((v) => +v.toFixed(2)),
      });
    }
  }
  const [main, ...rest] = merged.getRoot().listScenes();
  for (const s of rest) { for (const c of s.listChildren()) { s.removeChild(c); main.addChild(c); } s.dispose(); }
  await merged.transform(unpartition(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  mkdirSync(join(out, 'kits'), { recursive: true });
  await io.write(join(out, 'kits', `${kit}.glb`), merged);
  writeFileSync(join(out, 'kits', `${kit}.json`), JSON.stringify({ kit, source: REPOS[kit], license: 'CC0', models: manifest }, null, 1));
  const mb = (statSync(join(out, 'kits', `${kit}.glb`)).size / 1e6).toFixed(1);
  console.log(`kit ${kit}.glb : ${manifest.length} modèles, ${mb} Mo`);
}

fetchRepos();
await buildCharacters();
await buildAnimations();
for (const [kit, folders] of Object.entries(KITS)) await buildKit(kit, folders);
// ancien fichier remplacé par les kits dungeon + furniture
rmSync(join(out, 'props'), { recursive: true, force: true });
console.log('Assets prêts dans client/public/assets');
