import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_CONFIG } from '@oddone/shared';
import { CLIPS, computeAnchors, loadCharacterLibrary } from '../characters/library.ts';
import { composeCharacter, playAnimation, updateActor, type Actor } from '../characters/character.ts';
import { createSkeleton, type SkeletonKind } from '../characters/skeletons.ts';
import { KIT_NAMES, loadKit, type Kit, type KitName } from '../world/kits.ts';

/**
 * Page outil : parcourir les kits de décor et les personnages, voir chaque modèle à l'échelle
 * d'un héros, copier son nom. Ouverte via /catalog.html (npm run dev).
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KIT_LABELS: Record<KitName, string> = {
  dungeon: 'Donjon', furniture: 'Mobilier', restaurant: 'Cuisine', halloween: 'Halloween',
  prototype: 'Prototype', medieval: 'Village médiéval', skeletons: 'Armes squelettes',
};
type Tab = KitName | 'characters';
const CHARACTERS: { name: string; kind: 'hero' | SkeletonKind }[] = [
  { name: 'heros', kind: 'hero' }, { name: 'skeleton_minion', kind: 'minion' }, { name: 'skeleton_warrior', kind: 'warrior' },
  { name: 'skeleton_rogue', kind: 'rogue' }, { name: 'skeleton_mage', kind: 'mage' },
];
const HERO_HEIGHT = 2.47; // hauteur d'un héros KayKit en unités du modèle

/* ---------------- Vignettes : un renderer hors écran ---------------- */
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
thumbRenderer.setSize(192, 192);
thumbRenderer.setPixelRatio(1);
const thumbScene = new THREE.Scene();
thumbScene.add(new THREE.HemisphereLight('#fff4e0', '#5a3a22', 2.2));
const thumbSun = new THREE.DirectionalLight('#ffffff', 1.6);
thumbSun.position.set(3, 5, 4);
thumbScene.add(thumbSun);
const thumbCam = new THREE.PerspectiveCamera(30, 1, 0.01, 500);
const thumbCache = new Map<string, string>();

function frame(cam: THREE.PerspectiveCamera, obj: THREE.Object3D, distance = 1.15) {
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 0.05);
  const d = (r / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * distance;
  const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
  cam.position.copy(sphere.center).addScaledVector(dir, d);
  cam.near = d / 100; cam.far = d * 10;
  cam.lookAt(sphere.center);
  cam.updateProjectionMatrix();
  return sphere;
}

function thumbnail(key: string, obj: THREE.Object3D): string {
  const cached = thumbCache.get(key);
  if (cached) return cached;
  thumbScene.add(obj);
  frame(thumbCam, obj);
  thumbRenderer.render(thumbScene, thumbCam);
  thumbScene.remove(obj);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

/* ---------------- Visionneuse ---------------- */
const viewCanvas = $<HTMLCanvasElement>('view');
const view = new THREE.WebGLRenderer({ canvas: viewCanvas, antialias: true });
view.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
view.shadowMap.enabled = true;
const viewScene = new THREE.Scene();
viewScene.background = new THREE.Color('#2a1a10');
viewScene.add(new THREE.HemisphereLight('#fff4e0', '#3a2418', 2.0));
const viewSun = new THREE.DirectionalLight('#ffe8c8', 2.2);
viewSun.position.set(6, 12, 8);
viewSun.castShadow = true;
viewSun.shadow.mapSize.set(1024, 1024);
viewScene.add(viewSun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshToonMaterial({ color: '#4a2f1d' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
viewScene.add(ground);
const grid = new THREE.GridHelper(60, 60, '#6b4a33', '#3e2818');
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.6;
grid.position.y = 0.002;
viewScene.add(grid);
const viewCam = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
const controls = new OrbitControls(viewCam, viewCanvas);
controls.enableDamping = true;

let hero: (Actor & { model: ReturnType<typeof composeCharacter> }) | null = null;
let shown: THREE.Object3D | null = null;
let shownActor: Actor | null = null;

function resizeView() {
  const w = viewCanvas.clientWidth, h = viewCanvas.clientHeight;
  if (!w || !h) return;
  view.setSize(w, h, false);
  viewCam.aspect = w / h;
  viewCam.updateProjectionMatrix();
}
new ResizeObserver(resizeView).observe(viewCanvas);

/** Affiche un objet posé au sol, avec le héros de référence à sa gauche. */
function show(obj: THREE.Object3D, actor: Actor | null, withHero: boolean) {
  if (shown) viewScene.remove(shown);
  shown = obj;
  shownActor = actor;
  obj.position.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y = -box.min.y; // posé au sol
  obj.position.x = -(box.min.x + box.max.x) / 2;
  obj.position.z = -(box.min.z + box.max.z) / 2;
  obj.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  viewScene.add(obj);
  const size = box.getSize(new THREE.Vector3());
  if (hero) {
    hero.root.visible = withHero;
    hero.root.position.set(-(size.x / 2) - 1.1, 0, 0);
  }
  const both = new THREE.Box3().setFromObject(obj);
  if (withHero && hero) both.union(new THREE.Box3().setFromObject(hero.root));
  const center = both.getCenter(new THREE.Vector3());
  const radius = both.getBoundingSphere(new THREE.Sphere()).radius;
  const d = (radius / Math.sin(THREE.MathUtils.degToRad(viewCam.fov / 2))) * 1.05;
  viewCam.position.copy(center).add(new THREE.Vector3(0.55, 0.5, 1).normalize().multiplyScalar(d));
  viewCam.near = d / 200; viewCam.far = d * 20; viewCam.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  $('viewHint').hidden = true;
  return size;
}

/* ---------------- Interface ---------------- */
const kits = new Map<KitName, Kit>();
let tab: Tab = 'dungeon';
let category: string | null = null;
let selected = '';
const query = $<HTMLInputElement>('q');

function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 1800);
}

function renderTabs() {
  const items: [Tab, string, number][] = [
    ...KIT_NAMES.map((k): [Tab, string, number] => [k, KIT_LABELS[k], kits.get(k)?.models.length ?? 0]),
    ['characters', 'Personnages', CHARACTERS.length],
  ];
  $('tabs').innerHTML = items.map(([k, label, n]) => `<button role="tab" data-k="${k}" aria-selected="${k === tab}">${label}<small>${n}</small></button>`).join('');
}
$('tabs').onclick = (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  tab = b.dataset.k as Tab;
  category = null;
  renderTabs();
  renderGrid();
};

function renderCategories(cats: string[]) {
  const el = $('cats');
  el.hidden = cats.length < 2;
  el.innerHTML = [`<button data-c="" aria-pressed="${category === null}">Tout</button>`,
    ...cats.map((c) => `<button data-c="${c}" aria-pressed="${c === category}">${c}</button>`)].join('');
}
$('cats').onclick = (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  category = b.dataset.c || null;
  renderGrid();
};
query.addEventListener('input', () => renderGrid());

let renderToken = 0;
function renderGrid() {
  const token = ++renderToken;
  const grid = $('grid');
  const q = query.value.trim().toLowerCase();
  if (tab === 'characters') {
    renderCategories([]);
    const list = CHARACTERS.filter((c) => !q || c.name.includes(q));
    grid.innerHTML = list.map((c) => card(c.name)).join('');
    fillThumbs(token, list.map((c) => c.name), async (name) => {
      const c = CHARACTERS.find((x) => x.name === name)!;
      const actor = c.kind === 'hero' ? { root: new THREE.Group(), model: composeCharacter(DEFAULT_CONFIG) } : await createSkeleton(c.kind);
      if (c.kind === 'hero') actor.root.add(actor.model.holder);
      actor.model.actions.Idle.play();
      actor.model.mixer.update(0.3);
      return actor.root;
    });
    return;
  }
  const kit = kits.get(tab);
  if (!kit) return;
  const cats = [...new Set(kit.models.map((m) => m.category).filter((c): c is string => !!c))].sort();
  renderCategories(cats);
  const models = kit.models.filter((m) => (!category || m.category === category) && (!q || m.name.toLowerCase().includes(q)));
  grid.innerHTML = models.length ? models.map((m) => card(m.name)).join('') : '<p class="empty">Aucun modèle ne correspond.</p>';
  fillThumbs(token, models.map((m) => m.name), async (name) => kit.create(name));
}

function card(name: string) {
  return `<button class="card" data-name="${name}" aria-pressed="${name === selected}"><span class="thumb"><span class="wait"></span></span><span class="label">${name}</span></button>`;
}

/** Calcule les vignettes par petits paquets pour garder la page fluide. */
async function fillThumbs(token: number, names: string[], make: (name: string) => Promise<THREE.Object3D>) {
  const grid = $('grid');
  for (let i = 0; i < names.length; i++) {
    if (token !== renderToken) return;
    const key = `${tab}/${names[i]}`;
    const url = thumbCache.get(key) ?? thumbnail(key, await make(names[i]));
    const slot = grid.querySelector(`[data-name="${CSS.escape(names[i])}"] .thumb`);
    if (slot) slot.innerHTML = `<img alt="" src="${url}">`;
    if (i % 12 === 11) await new Promise((r) => setTimeout(r, 0));
  }
}

$('grid').onclick = async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!b) return;
  selected = b.dataset.name!;
  $('grid').querySelectorAll('.card').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
  await select(selected);
};

async function select(name: string) {
  $<HTMLButtonElement>('copy').disabled = false;
  $('vName').textContent = name;
  const animBox = $('animBox');
  if (tab === 'characters') {
    const c = CHARACTERS.find((x) => x.name === name)!;
    const actor: Actor = c.kind === 'hero' ? { root: new THREE.Group(), model: composeCharacter(DEFAULT_CONFIG) } : await createSkeleton(c.kind);
    if (c.kind === 'hero') actor.root.add(actor.model!.holder);
    playAnimation(actor, 'Idle');
    const size = show(actor.root, actor, false);
    $('vKit').textContent = 'Personnages';
    $('vCat').textContent = c.kind === 'hero' ? 'héros (modulaire)' : 'squelette';
    $('vSize').textContent = fmt(size);
    $('vRatio').textContent = '—';
    $('vCode').textContent = c.kind === 'hero'
      ? `setActorModel(actor, cfg); // characters/character.ts`
      : `const s = await createSkeleton('${c.kind}');\nscene.add(s.root);\nplayAnimation(s, 'Skeletons_Awaken_Standing', { once: true });`;
    animBox.hidden = false;
    return;
  }
  animBox.hidden = true;
  const kit = kits.get(tab)!;
  const info = kit.info(name)!;
  const size = show(kit.create(name), null, true);
  $('vKit').textContent = `${KIT_LABELS[tab]} (${tab})`;
  $('vCat').textContent = info.category ?? '—';
  $('vSize').textContent = fmt(size);
  $('vRatio').textContent = `${(size.y / HERO_HEIGHT).toFixed(2)} × la hauteur`;
  $('vCode').textContent = `const ${tab} = await loadKit('${tab}');\n${tab}.spawn('${name}', { x: 0, z: 0, parent: scene });`;
}
const fmt = (v: THREE.Vector3) => `${v.x.toFixed(2)} × ${v.y.toFixed(2)} × ${v.z.toFixed(2)}`;

$('copy').onclick = () => {
  const name = $('vName').textContent ?? '';
  navigator.clipboard?.writeText(name).then(() => toast(`« ${name} » copié`)).catch(() => toast(name));
};

const animSelect = $<HTMLSelectElement>('anim');
animSelect.onchange = () => { if (shownActor) playAnimation(shownActor, animSelect.value, { fade: 0.2 }); };

/* ---------------- Boucle et démarrage ---------------- */
const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 1 / 30), t = clock.elapsedTime;
  controls.update();
  if (hero?.root.visible) updateActor(hero, t, dt, false);
  if (shownActor) updateActor(shownActor, t, dt, false);
  view.render(viewScene, viewCam);
  requestAnimationFrame(loop);
}

async function boot() {
  await loadCharacterLibrary();
  computeAnchors();
  hero = { root: new THREE.Group(), model: composeCharacter(DEFAULT_CONFIG) };
  hero.root.add(hero.model.holder);
  hero.root.rotation.y = 0.5;
  hero.root.visible = false;
  viewScene.add(hero.root);
  playAnimation(hero, 'Idle');
  animSelect.innerHTML = Object.keys(CLIPS).sort().map((n) => `<option ${n === 'Idle' ? 'selected' : ''}>${n}</option>`).join('');
  resizeView();
  loop();
  for (const k of KIT_NAMES) kits.set(k, await loadKit(k));
  renderTabs();
  renderGrid();
}
renderTabs();
boot().catch((err) => { console.error(err); $('grid').innerHTML = `<p class="empty">Chargement impossible : ${String(err?.message ?? err)}</p>`; });
Object.assign(window, { __catalog: { select: async (t: Tab, name: string) => { tab = t; renderTabs(); renderGrid(); selected = name; await select(name); } } });
