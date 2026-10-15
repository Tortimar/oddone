import * as THREE from 'three';
import type { RoomState } from '@oddone/shared';
import { gradientMap } from '../engine/toon.ts';
import { FLOAT_GAIN, FLOAT_LOSS, FloatTexts } from './floatText.ts';

/**
 * Les pièces d'or au comptoir (un point = une pièce) :
 * - `scoreReveal` : les pièces du mini-jeu tombent sur la tête de chaque joueur (« +4 »…) ;
 * - `imposterReveal` : elles volent des joueurs qui se sont trompés vers l'imposteur, puis de
 *   l'imposteur vers ceux qui l'ont démasqué ; chacun réagit (content ou pas).
 * Tout est calé sur l'horloge du serveur (`phaseStartedAt`) : chez tout le monde, les pièces
 * tombent en même temps, et le tableau des scores compte au rythme des pièces qui arrivent.
 */

/** Une pièce (ou une réaction) prévue à un instant donné (heure du serveur, ms). */
export type CoinEvent =
  | { kind: 'drop'; to: string; at: number; land: number; first: boolean; total: number }
  | { kind: 'fly'; from: string; to: string; at: number; land: number; stage: 1 | 2 };

const DROP_START = 1600, DROP_GAP = 450, COIN_GAP = 110, FALL = 700;
const FLY_START = 2800, FLY_GAP = 380, FLY = 900, STAGE_PAUSE = 1300;

/** Le programme des pièces de la phase en cours (vide hors `scoreReveal` / `imposterReveal`). */
export function coinSchedule(s: RoomState): CoinEvent[] {
  const start = s.phaseStartedAt;
  if (start === null) return [];
  const g = s.game;
  const order = [...s.players].sort((a, b) => a.slot - b.slot);
  const out: CoinEvent[] = [];
  if (s.phase === 'scoreReveal' && g.award) {
    order.forEach((p, i) => {
      const n = g.award?.[p.id] ?? 0;
      for (let k = 0; k < n; k++) {
        const at = start + DROP_START + i * DROP_GAP + k * COIN_GAP;
        out.push({ kind: 'drop', to: p.id, at, land: at + FALL, first: k === 0, total: n });
      }
    });
  }
  if (s.phase === 'imposterReveal' && g.reveal) {
    let at = start + FLY_START;
    let stage: 1 | 2 = 1;
    for (const t of g.reveal.transfers) {
      if (t.stage !== stage) { stage = t.stage; at += STAGE_PAUSE; }
      out.push({ kind: 'fly', from: t.from, to: t.to, at, land: at + FLY, stage: t.stage });
      at += FLY_GAP;
    }
  }
  return out;
}

/**
 * Pièces affichées pour chacun : le serveur a déjà tout compté, on retire ce qui n'est pas encore
 * « arrivé » à l'écran (le mini-jeu tant que les pièces ne sont pas tombées, les vols en vol).
 */
export function displayedScores(s: RoomState, now: number): Record<string, number> {
  const shown: Record<string, number> = {};
  for (const p of s.players) shown[p.id] = s.game.scores[p.id] ?? 0;
  const award = s.game.award;
  if (award && (s.phase === 'mgResults' || s.phase === 'debrief')) {
    for (const [id, n] of Object.entries(award)) if (id in shown) shown[id] -= n;
  }
  for (const e of coinSchedule(s)) {
    if (e.kind === 'drop') { if (now < e.land && e.to in shown) shown[e.to] -= 1; continue; }
    if (now < e.at && e.from in shown) shown[e.from] += 1; // pas encore partie
    if (now < e.land && e.to in shown) shown[e.to] -= 1; // pas encore arrivée
  }
  return shown;
}

/* ================= Les pièces en 3D ================= */

const coinGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.045, 20);
const coinMat = new THREE.MeshToonMaterial({ color: '#ffcf3a', gradientMap, emissive: '#5a3a00', emissiveIntensity: 0.35 });
const rimGeo = new THREE.TorusGeometry(0.16, 0.018, 6, 20);
const rimMat = new THREE.MeshToonMaterial({ color: '#d99a1c', gradientMap });

function makeCoin(): THREE.Group {
  const g = new THREE.Group();
  const face = new THREE.Mesh(coinGeo, coinMat);
  face.rotation.x = Math.PI / 2; // debout, face à la caméra
  const rim = new THREE.Mesh(rimGeo, rimMat);
  g.add(face, rim);
  return g;
}

interface Flying { obj: THREE.Object3D; t0: number; dur: number; path: (k: number, out: THREE.Vector3) => void; done?: () => void; spin: number }

/** Hauteur au-dessus de la tête d'un joueur assis au comptoir. */
const HEAD = 2.15;

export class CoinShow {
  private flying: Flying[] = [];
  private texts: FloatTexts;
  private fired = new Set<string>();
  private key = '';
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Object3D) { this.texts = new FloatTexts(scene); }

  /**
   * À chaque image : lance les pièces prévues dont l'heure est venue et anime celles en l'air.
   * `where(id)` : position du joueur ; `react(id, content)` : sa réaction ; `ding()` : bruitage.
   */
  update(s: RoomState | null, now: number, dt: number, where: (id: string) => THREE.Vector3 | null, react: (id: string, happy: boolean) => void, ding: () => void): void {
    const key = s ? `${s.code}|${s.game.round}|${s.phase}|${s.phaseStartedAt}` : '';
    if (key !== this.key) { this.key = key; this.fired.clear(); }
    if (s) {
      coinSchedule(s).forEach((e, i) => {
        const id = `${i}`;
        if (this.fired.has(id) || now < e.at) return;
        this.fired.add(id);
        if (now - e.at > 1500) return; // déjà passé (arrivé en retard) : le tableau suffit
        if (e.kind === 'drop') this.drop(e, where, react, ding);
        else this.fly(e, where, react, ding);
      });
    }
    const t = performance.now() / 1000;
    for (const f of this.flying) {
      const k = Math.min(1, (t - f.t0) / f.dur);
      f.path(k, f.obj.position);
      f.obj.rotation.y += f.spin * dt;
      if (k >= 1) { f.obj.removeFromParent(); f.done?.(); }
    }
    this.flying = this.flying.filter((f) => f.obj.parent);
    this.texts.update();
  }

  private floater(text: string, color: string, at: THREE.Vector3, size = 0.9, life = 1.8): void {
    this.texts.at(at, text, color, { size, life });
  }

  /** Une pièce tombe du plafond sur la tête du joueur (et « +N » à la première). */
  private drop(e: Extract<CoinEvent, { kind: 'drop' }>, where: (id: string) => THREE.Vector3 | null, react: (id: string, happy: boolean) => void, ding: () => void): void {
    const p = where(e.to);
    if (!p) return;
    const base = p.clone(), dur = (e.land - e.at) / 1000;
    const jx = (Math.random() - 0.5) * 0.3, jz = (Math.random() - 0.5) * 0.2;
    const coin = makeCoin();
    this.scene.add(coin);
    this.flying.push({
      obj: coin, t0: performance.now() / 1000, dur, spin: 9,
      path: (k, out) => {
        // chute avec un petit rebond, puis la pièce rentre dans le joueur
        const fall = Math.min(1, k / 0.75), y = HEAD + 2.6 * (1 - fall * fall);
        const bounce = k > 0.75 ? Math.sin(((k - 0.75) / 0.25) * Math.PI) * 0.18 : 0;
        out.set(base.x + jx, base.y + y + bounce - (k > 0.9 ? (k - 0.9) * 4 : 0), base.z + jz);
        coin.scale.setScalar(k > 0.9 ? Math.max(0.05, 1 - (k - 0.9) * 10) : 1);
      },
      done: () => {
        ding();
        if (e.first) {
          this.floater(`+${e.total}`, FLOAT_GAIN, this.tmp.set(base.x, base.y + HEAD + 0.7, base.z), 1.1, 2.4);
          if (e.total >= 4) react(e.to, true);
        }
      },
    });
  }

  /** Une pièce vole d'un joueur à l'autre, en cloche. */
  private fly(e: Extract<CoinEvent, { kind: 'fly' }>, where: (id: string) => THREE.Vector3 | null, react: (id: string, happy: boolean) => void, ding: () => void): void {
    const a = where(e.from), b = where(e.to);
    if (!a || !b) return;
    const from = a.clone(), to = b.clone(), dur = (e.land - e.at) / 1000;
    this.floater('-1', FLOAT_LOSS, this.tmp.set(from.x, from.y + HEAD + 0.6, from.z), 0.8);
    react(e.from, false);
    const coin = makeCoin();
    this.scene.add(coin);
    this.flying.push({
      obj: coin, t0: performance.now() / 1000, dur, spin: 12,
      path: (k, out) => {
        out.lerpVectors(from, to, k);
        out.y = from.y + HEAD + 0.2 + (to.y - from.y) * k + Math.sin(k * Math.PI) * 1.3;
      },
      done: () => {
        ding();
        this.floater('+1', FLOAT_GAIN, this.tmp.set(to.x, to.y + HEAD + 0.6, to.z), 0.8);
        react(e.to, true);
      },
    });
  }

  clear(): void {
    for (const f of this.flying) f.obj.removeFromParent();
    this.texts.clear();
    this.flying = [];
  }
}
