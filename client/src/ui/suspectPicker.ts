import * as THREE from 'three';
import { SLOT_COLORS, type RoomState } from '@oddone/shared';
import { escapeHtml } from './dom.ts';
import { portraitImg } from './portraits.ts';

/**
 * Vote de l'imposteur, directement au comptoir : on vise un joueur assis à la souris (il s'illumine),
 * un clic vote pour lui. Au-dessus de chaque joueur flottent les portraits de ceux qui l'ont désigné ;
 * à la révélation, un écriteau « IMPOSTEUR » apparaît au-dessus du coupable.
 */

interface Seat {
  /** Volume invisible pour viser le joueur (plus simple et plus large que le personnage). */
  hit: THREE.Mesh;
  ring: THREE.Mesh;
  glow: THREE.Sprite;
}

/** Hauteur (au-dessus des pieds) où flottent les votes : au-dessus de l'étiquette du nom. */
const VOTES_Y = 2.5;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)'); grad.addColorStop(0.45, 'rgba(255,255,255,0.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SuspectPicker {
  private seats = new Map<string, Seat>();
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private hasMouse = false;
  private hover: string | null = null;
  private tmp = new THREE.Vector3();
  private layer: HTMLElement;
  private bubbles = new Map<string, HTMLElement>();
  private glowTex = glowTexture();
  private active = false;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, private canvas: HTMLCanvasElement, private vote: (id: string) => void) {
    this.layer = document.createElement('div');
    this.layer.id = 'voteFloat';
    document.body.append(this.layer);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.hasMouse = true;
    });
    canvas.addEventListener('pointerleave', () => { this.hasMouse = false; });
    canvas.addEventListener('click', () => { if (this.active && this.hover) this.vote(this.hover); });
  }

  private seat(id: string): Seat {
    let s = this.seats.get(id);
    if (s) return s;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 2.6, 10), new THREE.MeshBasicMaterial());
    hit.visible = false; // (le rayon le touche quand même : il ne teste pas la visibilité)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.82, 40), new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: '#ffd23f', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(2.6, 3.2, 1);
    this.scene.add(hit, ring, glow);
    s = { hit, ring, glow };
    this.seats.set(id, s);
    return s;
  }

  /**
   * À chaque image. `where(id)` : position (pieds) de chaque joueur au comptoir.
   * Renvoie l'id du joueur visé (pour le curseur).
   */
  update(s: RoomState | null, myId: string, where: (id: string) => THREE.Vector3 | null, t: number): string | null {
    const voting = !!s && s.phase === 'imposterVote';
    const showing = !!s && (s.phase === 'imposterVote' || s.phase === 'imposterReveal');
    this.active = voting;
    const ids = s ? s.players.map((p) => p.id) : [];
    // les volumes et halos suivent les joueurs
    for (const [id, seat] of this.seats) {
      const p = where(id);
      const alive = showing && ids.includes(id) && !!p;
      seat.ring.visible = alive; seat.glow.visible = alive;
      if (!alive || !p) continue;
      seat.hit.position.set(p.x, p.y + 1.3, p.z);
      seat.hit.updateMatrixWorld();
      seat.ring.position.set(p.x, p.y + 0.06, p.z);
      seat.glow.position.set(p.x, p.y + 1.4, p.z);
    }
    for (const id of ids) if (!this.seats.has(id) && where(id)) this.seat(id);

    // le joueur visé (pas soi-même)
    this.hover = null;
    if (voting && this.hasMouse) {
      this.ray.setFromCamera(this.mouse, this.camera);
      let best = Infinity;
      for (const [id, seat] of this.seats) {
        if (id === myId || !ids.includes(id) || !where(id)) continue;
        const hit = this.ray.intersectObject(seat.hit, false)[0];
        if (hit && hit.distance < best) { best = hit.distance; this.hover = id; }
      }
    }
    const mine = s?.game.votes[myId];
    const imp = s?.phase === 'imposterReveal' ? s.game.reveal?.imposterId : null;
    for (const [id, seat] of this.seats) {
      if (!seat.ring.visible) continue;
      const hovered = id === this.hover, chosen = id === mine, culprit = id === imp;
      const ringMat = seat.ring.material as THREE.MeshBasicMaterial, glowMat = seat.glow.material as THREE.SpriteMaterial;
      ringMat.color.set(culprit ? '#ff2a2a' : chosen ? '#e8742c' : '#ffd23f');
      ringMat.opacity = culprit || chosen ? 0.95 : hovered ? 0.9 : voting && id !== myId ? 0.25 : 0;
      seat.ring.scale.setScalar(hovered ? 1.08 + Math.sin(t * 8) * 0.05 : 1);
      glowMat.color.set(culprit ? '#ff2a2a' : '#ffd23f');
      glowMat.opacity = culprit ? 0.55 + Math.sin(t * 6) * 0.15 : hovered ? 0.5 : chosen ? 0.22 : 0;
    }
    this.canvas.style.cursor = this.hover ? 'pointer' : '';
    this.renderVotes(s, showing, where, imp ?? null);
    return this.hover;
  }

  /** Les portraits des votants, en bulle au-dessus de chaque joueur désigné (+ l'écriteau du coupable). */
  private renderVotes(s: RoomState | null, showing: boolean, where: (id: string) => THREE.Vector3 | null, imp: string | null): void {
    this.layer.hidden = !showing;
    if (!showing || !s) { for (const el of this.bubbles.values()) el.remove(); this.bubbles.clear(); return; }
    for (const p of s.players) {
      const voters = s.players.filter((q) => s.game.votes[q.id] === p.id);
      const key = voters.map((v) => v.id).join(',') + (p.id === imp ? '|imp' : '');
      let el = this.bubbles.get(p.id);
      if (!voters.length && p.id !== imp) { el?.remove(); this.bubbles.delete(p.id); continue; }
      if (!el) { el = document.createElement('div'); el.className = 'vf'; this.layer.append(el); this.bubbles.set(p.id, el); }
      if (el.dataset.k !== key) {
        const before = new Set((el.dataset.k ?? '').split('|')[0].split(','));
        el.dataset.k = key;
        el.innerHTML = (p.id === imp ? '<b class="vf-imp">Imposteur</b>' : '')
          + `<span class="vf-row">${voters.map((v) => `<i class="${before.has(v.id) ? '' : 'new'}" style="--c:${SLOT_COLORS[v.slot % 4]}" title="${escapeHtml(v.name)}">${portraitImg(v.cfg, v.name)}</i>`).join('')}</span>`;
      }
      const at = where(p.id);
      if (!at) { el.hidden = true; continue; }
      this.tmp.set(at.x, at.y + VOTES_Y, at.z).project(this.camera);
      el.hidden = this.tmp.z > 1;
      el.style.left = `${((this.tmp.x + 1) / 2) * innerWidth}px`;
      el.style.top = `${((1 - this.tmp.y) / 2) * innerHeight}px`;
    }
    for (const [id, el] of this.bubbles) if (!s.players.some((p) => p.id === id)) { el.remove(); this.bubbles.delete(id); }
  }
}
