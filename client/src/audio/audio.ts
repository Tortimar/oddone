/**
 * Son du jeu : une musique de fond à la fois (fondu enchaîné quand on change d'ambiance) et des
 * bruitages courts (jingles, tic-tac des décomptes, clics).
 *
 * Tout passe par Web Audio : les boucles sont sans couture (AudioBufferSourceNode.loop), et le
 * volume se règle par des nœuds de gain. Les navigateurs interdisent le son avant un premier geste
 * du joueur : le contexte démarre au premier clic ou à la première touche, et la musique demandée
 * avant ce moment part à ce moment-là.
 *
 * Les fichiers sont dans `public/assets/audio/` : `musique-*.ogg` et `sfx-*.ogg` (origine et
 * licences dans CREDITS.md). Un fichier
 * absent ne casse rien : le bruitage est remplacé par un petit bip synthétisé, la musique se tait.
 */

const BASE = '/assets/audio/';

/** Musiques de fond (boucles), par ambiance. Volumes déjà égalisés à la conversion. */
export const MUSIC = {
  taverne: 'musique-taverne.ogg',
  soiree: 'musique-soiree.ogg',
  regles: 'musique-regles.ogg',
  festin: 'musique-festin.ogg',
  squelettes: 'musique-squelettes.ogg',
  pont: 'musique-pont.ogg',
  tonneaux: 'musique-tonneaux.ogg',
  horde: 'musique-horde.ogg',
  coffres: 'musique-coffres.ogg',
  podium: 'musique-podium.ogg',
  vote: 'musique-vote.ogg',
  revelation: 'musique-revelation.ogg',
} as const;
export type MusicId = keyof typeof MUSIC;

/**
 * Bruitages. `beep` : le son de secours (fréquence en Hz, durée en s) si le fichier manque.
 * `gain` : volume relatif du fichier.
 */
const SFX = {
  /** Chaque seconde d'un décompte (3, 2, 1). */
  tick: { file: 'sfx-tick.ogg', gain: 0.7, beep: [660, 0.09] },
  /** « Partez ! » à la fin du décompte d'un mini-jeu. */
  go: { file: 'sfx-go.ogg', gain: 0.9, beep: [990, 0.25] },
  /** Le tavernier annonce quelque chose (résultat d'un vote, nouvelle recette). */
  annonce: { file: 'sfx-annonce.ogg', gain: 0.8, beep: [784, 0.18] },
  /** Carte du rôle : simple héros. */
  roleHeros: { file: 'sfx-role-heros.ogg', gain: 0.9, beep: [660, 0.2] },
  /** Carte du rôle : imposteur (la mélodie descend). */
  roleImposteur: { file: 'sfx-role-imposteur.ogg', gain: 0.85, beep: [220, 0.35] },
  /** Écran noir du rôle : boum grave et cloche qui descend (imposteur), fanfare (héros). */
  revealImposteur: { file: 'sfx-revelation-imposteur.ogg', gain: 1, beep: [110, 0.6] },
  revealHeros: { file: 'sfx-revelation-heros.ogg', gain: 0.9, beep: [523, 0.5] },
  /** Le podium tombe : fin du mini-jeu. */
  fin: { file: 'sfx-fin.ogg', gain: 0.9, beep: [523, 0.3] },
  /** L'imposteur est démasqué (la mélodie monte). */
  trouve: { file: 'sfx-trouve.ogg', gain: 0.85, beep: [880, 0.4] },
  /** L'imposteur s'en tire (descente chromatique, « raté »). */
  rate: { file: 'sfx-rate.ogg', gain: 1, beep: [196, 0.45] },
  /** Grand final de la soirée. */
  finale: { file: 'sfx-finale.ogg', gain: 0.85, beep: [1046, 0.5] },
  /** Un vote, « Prêt ! ». */
  valider: { file: 'sfx-valider.ogg', gain: 0.4, beep: [880, 0.08] },
  /** Un clic d'interface. */
  clic: { file: 'sfx-clic.ogg', gain: 1, beep: [1200, 0.03] },
  /** On prend un ingrédient. */
  prendre: { file: 'sfx-prendre.ogg', gain: 0.75, beep: [740, 0.07] },
  /** On verse dans la marmite. */
  verser: { file: 'sfx-verser.ogg', gain: 0.8, beep: [392, 0.12] },
  /** Raté (attrapé, mauvaise recette). */
  erreur: { file: 'sfx-erreur.ogg', gain: 0.6, beep: [150, 0.18] },
  /** Coup porté ou reçu (podium, poussée). */
  coup: { file: 'sfx-coup.ogg', gain: 1, beep: [180, 0.06] },
} satisfies Record<string, { file: string; gain: number; beep: [number, number] }>;
export type SfxId = keyof typeof SFX;

/* ================= Réglages (gardés dans le navigateur) ================= */
interface Settings { volume: number; muted: boolean }
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem('oddone-audio') ?? '{}');
    return { volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : 0.7, muted: !!s.muted };
  } catch { return { volume: 0.7, muted: false }; }
}
const settings = loadSettings();
function saveSettings() { try { localStorage.setItem('oddone-audio', JSON.stringify(settings)); } catch { /* stockage indisponible */ } }

/** Part de la musique et des bruitages dans le volume général. */
const MUSIC_LEVEL = 0.55, SFX_LEVEL = 0.9;
const FADE_S = 1.4;

/* ================= Moteur ================= */
let ctx: AudioContext | null = null;
let master: GainNode, musicBus: GainNode, sfxBus: GainNode;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

interface Track { id: MusicId; source: AudioBufferSourceNode | null; gain: GainNode }
let current: Track | null = null;
/** Ambiance voulue (même avant le premier geste, ou pendant le chargement). */
let wanted: MusicId | null = null;
/** Atténuation temporaire de la musique (décompte, jingle important). */
let duckUntil = 0;

function outputLevel() { return settings.muted ? 0 : settings.volume; }

function start(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch { return null; }
  master = ctx.createGain();
  master.gain.value = outputLevel();
  master.connect(ctx.destination);
  musicBus = ctx.createGain(); musicBus.gain.value = MUSIC_LEVEL; musicBus.connect(master);
  sfxBus = ctx.createGain(); sfxBus.gain.value = SFX_LEVEL; sfxBus.connect(master);
  return ctx;
}

/** Le premier geste du joueur débloque le son. */
let preloaded = false;
function unlock() {
  const c = start();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  if (!preloaded) { preloaded = true; preload(); }
  if (wanted && current?.id !== wanted) void switchTo(wanted);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) addEventListener(ev, unlock, { capture: true, passive: true });

function load(file: string): Promise<AudioBuffer | null> {
  let p = buffers.get(file);
  if (!p) {
    p = fetch(BASE + encodeURIComponent(file))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((data) => ctx!.decodeAudioData(data))
      .catch(() => null);
    buffers.set(file, p);
  }
  return p;
}

async function switchTo(id: MusicId | null) {
  const c = ctx;
  if (!c || c.state !== 'running' && c.state !== 'suspended') return;
  if (current?.id === id) return;
  const now = c.currentTime;
  // l'ancienne musique s'éteint doucement
  if (current) {
    const old = current;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + FADE_S);
    setTimeout(() => { try { old.source?.stop(); } catch { /* déjà arrêtée */ } old.gain.disconnect(); }, FADE_S * 1000 + 100);
    current = null;
  }
  if (!id) return;
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.connect(musicBus);
  const track: Track = { id, source: null, gain };
  current = track;
  const buf = await load(MUSIC[id]);
  // entre-temps, on a peut-être demandé autre chose
  if (current !== track || !buf) { if (current === track) current = null; gain.disconnect(); return; }
  const src = c.createBufferSource();
  src.buffer = buf; src.loop = true;
  src.connect(gain);
  src.start();
  track.source = src;
  const t = c.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(1, t + FADE_S);
}

/* ================= API ================= */

/** Change d'ambiance (null : silence). Sans effet si c'est déjà celle-là. */
export function playMusic(id: MusicId | null): void {
  if (wanted === id) return;
  wanted = id;
  if (ctx) void switchTo(id);
}

/** Joue un bruitage. `duck` baisse la musique pendant ce temps (en s). */
export function playSfx(id: SfxId, opts: { duck?: number; volume?: number } = {}): void {
  const c = ctx;
  if (!c || c.state !== 'running') return;
  const def = SFX[id];
  if (opts.duck) duck(opts.duck);
  void load(def.file).then((buf) => {
    if (!ctx) return;
    const g = c.createGain();
    g.gain.value = def.gain * (opts.volume ?? 1);
    g.connect(sfxBus);
    if (buf) {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.onended = () => g.disconnect();
      src.start();
    } else beep(def.beep[0], def.beep[1], g);
  });
}

/** Bip de secours : une note brève, attaque nette et extinction douce. */
function beep(freq: number, dur: number, out: GainNode) {
  const c = ctx!;
  const o = c.createOscillator(), env = c.createGain();
  o.type = 'triangle'; o.frequency.value = freq;
  const t = c.currentTime;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(env).connect(out);
  o.start(t); o.stop(t + dur + 0.05);
  o.onended = () => out.disconnect();
}

/** Baisse la musique quelques instants (le temps d'un jingle). */
export function duck(seconds: number): void {
  const c = ctx;
  if (!c) return;
  const t = c.currentTime, end = t + seconds;
  if (end <= duckUntil) return;
  duckUntil = end;
  const g = musicBus.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(MUSIC_LEVEL * 0.3, t + 0.15);
  g.setValueAtTime(MUSIC_LEVEL * 0.3, end);
  g.linearRampToValueAtTime(MUSIC_LEVEL, end + 0.8);
}

/** Précharge les bruitages (petits) pour que le premier jingle ne parte pas en retard. */
function preload(): void {
  for (const def of Object.values(SFX)) void load(def.file);
}

export function getVolume(): number { return settings.volume; }
export function isMuted(): boolean { return settings.muted; }

function applyLevel() {
  saveSettings();
  if (ctx) master.gain.setTargetAtTime(outputLevel(), ctx.currentTime, 0.05);
  for (const fn of listeners) fn();
}
export function setVolume(v: number): void { settings.volume = Math.min(1, Math.max(0, v)); if (settings.volume > 0) settings.muted = false; applyLevel(); }
export function toggleMute(): void { settings.muted = !settings.muted; applyLevel(); }

const listeners: (() => void)[] = [];
/** Prévenir l'interface quand le volume change (bouton du haut, raccourci M). */
export function onLevelChange(fn: () => void): void { listeners.push(fn); }
