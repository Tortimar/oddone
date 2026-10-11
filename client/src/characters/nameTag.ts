import * as THREE from 'three';
import { canvasTexture, roundRect } from '../engine/render.ts';

/** Étiquette de nom flottante au-dessus d'un personnage. */
export class NameTag {
  readonly sprite: THREE.Sprite;
  private key = '';

  constructor(parent: THREE.Object3D) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
    this.sprite.scale.set(1.3, 0.325, 1);
    parent.add(this.sprite);
  }

  set(name: string, color: string, force = false): void {
    if (!force && this.key === name + color) return;
    this.key = name + color;
    const mat = this.sprite.material;
    mat.map?.dispose();
    mat.map = canvasTexture(320, 80, (g, w) => {
      g.font = '38px "Lilita One", sans-serif';
      const tw = Math.min(g.measureText(name).width, 230), bw = tw + 78, x = (w - bw) / 2;
      g.fillStyle = 'rgba(26,15,10,.85)'; roundRect(g, x, 10, bw, 58, 29); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(x + 30, 39, 11, 0, 7); g.fill();
      g.fillStyle = '#fbf1dc'; g.textBaseline = 'middle'; g.fillText(name, x + 52, 41, 230);
    });
    mat.needsUpdate = true;
  }

  setHeight(y: number): void { this.sprite.position.y = y; }
}
