import * as THREE from 'three';
import { canvasTexture } from '../engine/toon.ts';

/**
 * Textes qui jaillissent au-dessus des joueurs (« +4 », « -1 », « 1er », « 2e »…), le même style
 * partout : au comptoir quand les pièces tombent, et dans tous les mini-jeux quand un joueur marque
 * des points ou termine un tronçon, une manche, une course.
 * Animés à l'horloge murale : rien ne traîne si l'image rame.
 */

/** Gain de points (or), perte (rouge). */
export const FLOAT_GAIN = '#ffd23f', FLOAT_LOSS = '#ff6b5b';
/** Couleur d'une place : or, argent, bronze, puis crème. */
export const placeColor = (rank: number) => ['#ffd23f', '#dfe6f0', '#e9a86a'][rank - 1] ?? '#fbf1dc';
export const placeLabel = (rank: number) => (rank === 1 ? '1er' : `${rank}e`);

function labelTexture(text: string, color: string): THREE.CanvasTexture {
  return canvasTexture(160, 80, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.font = '60px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#1d120c'; g.strokeText(text, w / 2, h / 2 + 4);
    g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 4);
  });
}
const LABELS = new Map<string, THREE.CanvasTexture>();
function label(text: string, color: string): THREE.CanvasTexture {
  const k = `${text}|${color}`;
  let t = LABELS.get(k);
  if (!t) { t = labelTexture(text, color); LABELS.set(k, t); }
  return t;
}

export interface FloatOptions {
  /** Taille (largeur ; la hauteur en fait la moitié). */
  size?: number;
  /** Durée de vie (s). */
  life?: number;
  /** Vitesse de montée (unités par seconde). */
  rise?: number;
  /** Hauteur au-dessus de la cible suivie (`above`). */
  height?: number;
}

interface Float { s: THREE.Sprite; t0: number; life: number; rise: number; size: number; base: THREE.Vector3; follow: THREE.Object3D | null; lift: number }

export class FloatTexts {
  private list: Float[] = [];

  constructor(private scene: THREE.Object3D) {}

  /** Au-dessus d'un objet qui bouge (un joueur) : le texte le suit en montant. */
  above(target: THREE.Object3D, text: string, color: string, o: FloatOptions = {}): void {
    // deux textes coup sur coup sur le même joueur : le second s'affiche un cran plus haut
    const stacked = this.list.filter((f) => f.follow === target && this.age(f) < 0.6).length;
    this.add(text, color, new THREE.Vector3(0, (o.height ?? 3.3) + stacked * 0.55, 0), target, o);
  }

  /** À un endroit fixe. */
  at(pos: THREE.Vector3, text: string, color: string, o: FloatOptions = {}): void {
    this.add(text, color, pos.clone(), null, o);
  }

  private add(text: string, color: string, base: THREE.Vector3, follow: THREE.Object3D | null, o: FloatOptions): void {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(text, color), transparent: true, depthWrite: false, depthTest: false }));
    s.renderOrder = 10;
    this.scene.add(s);
    const f: Float = { s, t0: performance.now() / 1000, life: o.life ?? 1.8, rise: o.rise ?? 0.45, size: o.size ?? 0.9, base, follow, lift: 0 };
    this.list.push(f);
    this.place(f);
  }

  private age(f: Float): number { return performance.now() / 1000 - f.t0; }

  private place(f: Float): void {
    const age = this.age(f), left = f.life - age;
    // petit rebond à l'apparition, puis il monte et s'efface
    const pop = age < 0.18 ? 0.45 + (age / 0.18) * 0.75 : age < 0.3 ? 1.2 - ((age - 0.18) / 0.12) * 0.2 : 1;
    f.s.scale.set(f.size * pop, (f.size / 2) * pop, 1);
    f.s.position.copy(f.base).y += f.rise * age;
    if (f.follow) f.s.position.add(f.follow.position);
    (f.s.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, left * 2.5, age * 6));
  }

  update(): void {
    for (const f of this.list) {
      this.place(f);
      if (this.age(f) >= f.life) { f.s.removeFromParent(); f.s.material.dispose(); }
    }
    this.list = this.list.filter((f) => f.s.parent);
  }

  clear(): void {
    for (const f of this.list) { f.s.removeFromParent(); f.s.material.dispose(); }
    this.list = [];
  }
}
