import * as THREE from 'three';
import {
  CourseMap, GORGE, NORMAL_CONTROLS, formatSurvival, scrambledControls,
  type ControlMap, type GorgeCourse, type MinigameTick,
} from '@oddone/shared';
import { OUTLINE, canvasTexture, gradientMap } from '../engine/render.ts';
import { Particles, PodiumView } from './effects.ts';
import type { World } from '../world/tavern.ts';
import type { Frame, GameView, HudInfo } from './view.ts';

/**
 * L'arène du « Pont Branlant » : un canyon de grès rouge, des chemins d'une case perchés sur des
 * colonnes de roche au-dessus du vide, des ponts de corde (les checkpoints) et l'arrivée.
 * Gère aussi, côté joueur local : déplacements en 4 directions, commandes mélangées après
 * chaque pont, tornade, chute et retour au dernier pont.
 */

const ARROW: Record<string, string> = { up: '↑', right: '→', down: '↓', left: '←' };
const KEYS = ['Z', 'D', 'S', 'Q'];
const C = GORGE.cell;

/** Strates de grès pour les flancs des colonnes. */
const rockTexture = canvasTexture(64, 256, (g, w, h) => {
  const bands = ['#b8643f', '#c97a4c', '#a5532f', '#d38c58', '#9c4a2a', '#c2703f'];
  let y = 0, i = 0;
  while (y < h) { const bh = 10 + ((i * 37) % 22); g.fillStyle = bands[i % bands.length]; g.fillRect(0, y, w, bh); y += bh; i++; }
  g.fillStyle = 'rgba(0,0,0,.08)';
  for (let k = 0; k < 18; k++) g.fillRect((k * 23) % w, (k * 71) % h, 2, 14);
});
const sandTexture = canvasTexture(64, 64, (g, w) => {
  g.fillStyle = '#e2b47c'; g.fillRect(0, 0, w, w);
  for (let k = 0; k < 40; k++) { g.fillStyle = k % 2 ? 'rgba(160,100,60,.18)' : 'rgba(255,240,210,.25)'; g.fillRect((k * 29) % w, (k * 17) % w, 3, 3); }
  g.strokeStyle = 'rgba(120,70,40,.35)'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, w - 2);
});
const swirlTexture = canvasTexture(128, 128, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  for (let k = 0; k < 7; k++) {
    g.strokeStyle = `rgba(255,255,255,${0.25 + (k % 3) * 0.2})`; g.lineWidth = 5 + (k % 3) * 3;
    g.beginPath(); g.moveTo(-20 + k * 22, h); g.bezierCurveTo(k * 22, h * 0.6, k * 22 + 40, h * 0.4, k * 22 + 30, 0); g.stroke();
  }
});
swirlTexture.wrapS = THREE.RepeatWrapping;

function banner(text: string, bg: string, fg: string): THREE.CanvasTexture {
  return canvasTexture(512, 128, (g, w, h) => {
    if (bg === 'checker') {
      for (let x = 0; x < w; x += 32) for (let y = 0; y < h; y += 32) { g.fillStyle = ((x + y) / 32) % 2 ? '#1d120c' : '#fbf1dc'; g.fillRect(x, y, 32, 32); }
      g.fillStyle = 'rgba(26,15,10,.8)'; g.fillRect(70, 24, w - 140, h - 48);
    } else { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.font = '64px "Lilita One", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = fg; g.fillText(text, w / 2, h / 2 + 4);
  });
}

interface Spin { start: number; cone: THREE.Mesh }

export class GorgeArena implements GameView {
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras = { training: 'chase', play: 'chase' } as const;
  readonly pushCooldownMs = GORGE.push.cooldownMs;
  readonly solidPlayers = true;
  readonly map: CourseMap;
  private sun!: THREE.DirectionalLight;
  private bridges: THREE.Group[] = [];
  /** Dernière tornade vue par joueur (pour la déclencher une seule fois). */
  private seenTornado = new Map<string, number | null>();
  private spins = new Map<string, Spin>();
  private fallAt: number | null = null;
  private lastControls = '';
  /**
   * Ponts atteints, vus par le client lui-même : le compteur, la tornade et le point de
   * réapparition réagissent tout de suite, sans attendre la réponse du serveur (qui reste
   * maître des commandes mélangées et de l'arrivée).
   */
  private localCp = 0;
  /** Entraînement (écran des règles) : commandes mélangées par la tornade, chez soi seulement. */
  private trainControls: ControlMap | null = null;
  /** Début de la dernière tornade déclenchée ici (ms de jeu, horloge du serveur). */
  private localTornadoAt: number | null = null;

  private constructor(readonly course: GorgeCourse) {
    this.map = new CourseMap(course);
    this.world = { colliders: [], circles: [], bounds: { halfX: 200, halfZ: 400 }, floor: (x, z) => this.map.walkable(x, z) };
    this.build();
    this.particles = new Particles(this.scene);
    this.podium = new PodiumView(this.scene, course.finishCenter, this.world, this.particles);
  }

  static create(course: GorgeCourse): Promise<GorgeArena> { return Promise.resolve(new GorgeArena(course)); }

  /* ================= Décor ================= */

  private build(): void {
    const s = this.scene;
    s.background = canvasTexture(4, 256, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#f7dcb0'); grad.addColorStop(0.55, '#e7a77a'); grad.addColorStop(1, '#8e4a33');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog('#c98a64', 22, 78);
    s.add(new THREE.HemisphereLight('#ffe9c8', '#7a3e28', 1.8));
    this.sun = new THREE.DirectionalLight('#fff1d6', 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 70 });
    this.sun.shadow.bias = -0.0008;
    s.add(this.sun, this.sun.target);

    // colonnes de roche sous chaque case (sauf les ponts, suspendus au-dessus du vide)
    const rock = new THREE.MeshToonMaterial({ map: rockTexture, gradientMap });
    const top = new THREE.MeshToonMaterial({ map: sandTexture, gradientMap });
    const geo = new THREE.BoxGeometry(C * 0.995, 1, C * 0.995).translate(0, -0.5, 0);
    const ground = this.course.cells.filter(([, , k]) => k !== 'bridge');
    const pillars = new THREE.InstancedMesh(geo, [rock, rock, top, rock, rock, rock], ground.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    ground.forEach(([i, j], n) => {
      const depth = 9 + (((i * 7 + j * 13) % 9) + 9) % 9 * 1.6; // des hauteurs inégales : des aiguilles érodées
      m.makeScale(1, depth, 1).setPosition(i * C, 0, -j * C);
      pillars.setMatrixAt(n, m);
      pillars.setColorAt(n, col.setHSL(0.06, 0.25, 0.86 + (((i * 31 + j * 17) % 7) / 7) * 0.14));
    });
    pillars.castShadow = pillars.receiveShadow = true;
    s.add(pillars);

    // repère d'arrivée (au départ, la caméra est juste derrière les joueurs : pas d'arche)
    const [fx, fz] = this.course.finishCenter;
    this.arch(fx, -(this.course.finishRow - 0.5) * C, 'ARRIVÉE', 'checker', '#ffd23f', 15);

    for (const b of this.course.bridges) this.bridge(b.i, b.j0, b.j1);

    // les parois du canyon, de part et d'autre, et des aiguilles au fond du gouffre
    const zMax = 12, zMin = fz - 30;
    const walls = [new THREE.MeshToonMaterial({ color: '#b5603a', gradientMap }), new THREE.MeshToonMaterial({ color: '#9c4c2c', gradientMap }), new THREE.MeshToonMaterial({ color: '#c97a4c', gradientMap })];
    let k = 0;
    for (let z = zMax; z > zMin; z -= 6.5) {
      for (const side of [-1, 1]) {
        k++;
        const r = 3.2 + (k * 37 % 10) / 4;
        const rockMesh = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), walls[k % 3]);
        rockMesh.scale.set(1.1, 3.4 + (k % 4) * 0.6, 1.3);
        rockMesh.position.set(side * (GORGE.halfWidth * C + 6.5 + (k % 3) * 1.6), -6 + (k % 5), z + (k % 2) * 2);
        rockMesh.rotation.y = k * 0.7;
        rockMesh.castShadow = true; rockMesh.receiveShadow = true;
        s.add(rockMesh);
        const far = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 1.8, 0), walls[(k + 1) % 3]);
        far.scale.set(1, 4, 1);
        far.position.set(side * (GORGE.halfWidth * C + 17 + (k % 4) * 3), -10 + (k % 3) * 3, z - 3);
        s.add(far);
      }
      // aiguilles au fond
      const spire = new THREE.Mesh(new THREE.ConeGeometry(1.4 + (k % 3) * 0.5, 14 + (k % 4) * 3, 6), walls[k % 3]);
      spire.position.set(((k * 53) % 13) - 6.5, -22, z);
      s.add(spire);
    }
    const abyss = new THREE.Mesh(new THREE.PlaneGeometry(200, 400), new THREE.MeshBasicMaterial({ color: '#5a2c1c' }));
    abyss.rotation.x = -Math.PI / 2; abyss.position.set(0, -32, (zMax + zMin) / 2);
    s.add(abyss);
  }

  /** Arche de bannière au-dessus du chemin. */
  private arch(x: number, z: number, text: string, bg: string, fg: string, width: number): void {
    const wood = new THREE.MeshToonMaterial({ color: '#5a3a22', gradientMap });
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 6), wood);
      pole.position.set(x + sx * width / 2, 3, z);
      pole.castShadow = true;
      this.scene.add(pole);
    }
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(width - 0.6, 7), 1.6), new THREE.MeshToonMaterial({ map: banner(text, bg, fg), gradientMap, side: THREE.DoubleSide }));
    ban.position.set(x, 5.2, z); // assez haut pour ne pas cacher la course (ni le podium)
    this.scene.add(ban);
  }

  /** Pont de corde au-dessus du vide, entre deux paliers. */
  private bridge(i: number, j0: number, j1: number): void {
    const g = new THREE.Group();
    const x = i * C, z0 = -(j0 - 0.6) * C, z1 = -(j1 + 0.6) * C, len = z0 - z1;
    g.position.set(x, 0, (z0 + z1) / 2);
    const plankMats = [new THREE.MeshToonMaterial({ color: '#8a5a32', gradientMap }), new THREE.MeshToonMaterial({ color: '#a26c3e', gradientMap })];
    const n = Math.round(len / 0.34);
    for (let p = 0; p < n; p++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(C * 0.95, 0.12, 0.28), plankMats[p % 2]);
      const zz = -len / 2 + (p + 0.5) * (len / n);
      const sag = -0.12 * Math.sin(Math.PI * (p + 0.5) / n);
      plank.position.set(((p * 7) % 3 - 1) * 0.03, -0.06 + sag, zz);
      plank.rotation.y = ((p * 13) % 5 - 2) * 0.02;
      plank.castShadow = plank.receiveShadow = true;
      g.add(plank);
    }
    const ropeMat = new THREE.MeshToonMaterial({ color: '#d9c18f', gradientMap });
    const postMat = new THREE.MeshToonMaterial({ color: '#4a2f1d', gradientMap });
    for (const sx of [-1, 1]) {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len), ropeMat);
      rope.rotation.x = Math.PI / 2; rope.position.set(sx * C * 0.5, 0.75, 0);
      g.add(rope);
      for (const end of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.2), postMat);
        post.position.set(sx * C * 0.5, 0.4, end * len / 2);
        post.castShadow = true;
        const edge = new THREE.Mesh(post.geometry, OUTLINE); edge.scale.setScalar(1.15); post.add(edge);
        g.add(post);
      }
    }
    // fanions du checkpoint à l'entrée du pont
    const flags = new THREE.Group();
    const colors = ['#e8413c', '#f2b81e', '#2f7de1', '#36b24a'];
    for (let f = 0; f < 6; f++) {
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 3), new THREE.MeshToonMaterial({ color: colors[f % 4], gradientMap }));
      fl.rotation.x = Math.PI; fl.position.set(-C * 0.5 + (f + 0.5) * (C / 6), 1.05, len / 2);
      flags.add(fl);
    }
    g.add(flags);
    this.scene.add(g);
    this.bridges.push(g);
  }

  /* ================= Joueur local ================= */

  startTraining(): void { this.fallAt = null; this.localCp = 0; this.localTornadoAt = null; this.trainControls = null; }
  stopTraining(): void { this.fallAt = null; this.localCp = 0; this.localTornadoAt = null; this.trainControls = null; }

  onPhase(f: Frame): void {
    if (f.phase === 'roleReveal' || f.phase === 'mgCountdown') { this.fallAt = null; this.seenTornado.clear(); this.localCp = 0; this.localTornadoAt = null; }
    if (f.phase === 'mgResults') { for (const [id] of this.spins) this.stopSpin(id, f); }
  }

  private status(f: Frame) { return f.mg.race?.[f.myId] ?? null; }
  /** Dernier pont atteint : le plus loin entre ce qu'a vu le serveur et ce qu'on a vu ici. */
  private cp(f: Frame): number {
    if (f.phase === 'rules') return this.localCp;
    return f.phase === 'mgPlay' ? Math.max(this.status(f)?.cp ?? 0, this.localCp) : 0;
  }
  /** Horloge des tornades (ms) : celle du serveur pendant la partie, locale à l'entraînement. */
  private clock(f: Frame): number { return f.phase === 'mgPlay' ? f.playMs : f.simTime * 1000; }
  private tornadoActive(f: Frame): boolean {
    if (f.phase !== 'mgPlay' && f.phase !== 'rules') return false;
    const st = f.phase === 'mgPlay' ? this.status(f) : null;
    const at = Math.max(st?.tornadoAt ?? -Infinity, this.localTornadoAt ?? -Infinity);
    return this.clock(f) - at < GORGE.tornadoMs;
  }

  beforeMove(f: Frame): void {
    const me = f.me, st = this.status(f);
    me.fourWay = true; me.laneAssist = C; me.canJump = false;
    me.speedMul = GORGE.playerSpeed / 6.2;
    me.controls = f.phase === 'mgPlay' && st ? st.controls : f.phase === 'rules' ? this.trainControls : null;
    // en pleine chute ou pris dans la tornade : les touches ne répondent plus
    if (this.fallAt !== null || this.tornadoActive(f)) me.frozen = true;
  }

  afterMove(f: Frame): string | null {
    const me = f.me, P = me.root.position;
    // nouveau pont atteint : checkpoint et tornade tout de suite (le serveur confirmera)
    if ((f.phase === 'mgPlay' || f.phase === 'rules') && this.fallAt === null && P.y > -0.3) {
      const b = this.map.bridgeAt(P.x, P.z);
      if (b >= 0 && b + 1 > this.cp(f)) {
        this.localCp = b + 1;
        this.localTornadoAt = this.clock(f);
        // à l'entraînement, la tornade mélange aussi les commandes (on ne sait pas encore qui est l'imposteur)
        if (f.phase === 'rules') this.trainControls = scrambledControls(Math.random);
        this.startSpin(f.myId, me.root, f);
        if (f.phase === 'rules') return 'Tornade ! Tes commandes sont mélangées';
      }
    }
    // (chute minutée à l'horloge murale : même si l'onglet rame, on réapparaît à temps)
    const wall = performance.now() / 1000;
    if (this.fallAt === null && P.y < -0.6) {
      this.fallAt = wall;
      me.playPose('Jump_Idle', { once: false });
      return 'Plouf !';
    }
    if (this.fallAt !== null && wall - this.fallAt > GORGE.respawnMs / 1000) {
      // retour au dernier pont atteint (ou à la ligne de départ)
      const [x, z] = this.map.spawn(this.cp(f), f.mg.starts[f.myId] ?? [0, 0]);
      me.placeAt(x, z, Math.PI);
      this.particles.burst(x, 0.6, z, '#fff3c2', 12, 1, 0.8);
      this.fallAt = null;
    }
    return null;
  }

  applyTick(tick: MinigameTick, f: Frame): void {
    for (const [id, x, z, yaw, anim, y] of tick.bots) f.remotes.get(id)?.setTransform({ p: [x, y ?? 0, z], r: yaw, a: anim });
  }

  /* ================= Tornades ================= */

  private startSpin(id: string, root: THREE.Object3D, f: Frame): void {
    this.stopSpin(id, f);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 0.3, 3.2, 24, 1, true), new THREE.MeshBasicMaterial({ map: swirlTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: '#fff6e8', opacity: 0.85 }));
    cone.position.y = 1.5;
    root.add(cone);
    this.spins.set(id, { start: f.simTime, cone });
    this.particles.burst(root.position.x, root.position.y + 0.3, root.position.z, '#f6e3c2', 14, 1.8, 1);
  }

  private stopSpin(id: string, f: Frame): void {
    const sp = this.spins.get(id);
    if (!sp) return;
    sp.cone.removeFromParent();
    this.spins.delete(id);
    const root = id === f.myId ? f.me : f.remotes.get(id);
    root?.model?.holder.rotation.set(0, 0, 0);
  }

  update(t: number, dt: number, f: Frame): void {
    this.particles.update(dt);
    this.podium.update(dt);
    const P = f.me.root.position;
    this.sun.position.set(P.x - 8, Math.max(P.y, -4) + 22, P.z + 10);
    this.sun.target.position.set(P.x, 0, P.z - 4);
    this.bridges.forEach((b, i) => { b.rotation.z = Math.sin(t * 1.6 + i) * 0.025; });

    // une tornade par nouveau pont atteint (l'imposteur tourne aussi : il ne doit pas se trahir)
    if (f.phase === 'mgPlay' && f.mg.race) {
      for (const [id, st] of Object.entries(f.mg.race)) {
        const seen = this.seenTornado.get(id) ?? null;
        if (st.tornadoAt !== null && st.tornadoAt !== seen) {
          this.seenTornado.set(id, st.tornadoAt);
          // la nôtre est déjà partie, dès qu'on a posé le pied sur le pont
          if (id === f.myId && this.localTornadoAt !== null && Math.abs(st.tornadoAt - this.localTornadoAt) < 2500) continue;
          const root = id === f.myId ? f.me.root : f.remotes.get(id)?.root;
          if (root) this.startSpin(id, root, f);
        }
      }
    }
    for (const [id, sp] of this.spins) {
      const age = f.simTime - sp.start;
      const actor = id === f.myId ? f.me : f.remotes.get(id);
      if (age > GORGE.tornadoMs / 1000 || !actor) { this.stopSpin(id, f); continue; }
      actor.model?.holder.rotation.set(0, age * 16, 0);
      sp.cone.rotation.y -= dt * 14;
      const k = Math.sin(Math.min(1, age / (GORGE.tornadoMs / 1000)) * Math.PI);
      sp.cone.scale.set(0.6 + k * 0.5, 0.4 + k * 0.7, 0.6 + k * 0.5);
      (sp.cone.material as THREE.MeshBasicMaterial).opacity = 0.85 * k;
    }
  }

  /* ================= HUD ================= */

  hud(f: Frame): HudInfo {
    const st = this.status(f), n = this.course.bridges.length, cp = this.cp(f);
    const race = f.mg.race;
    let status: HudInfo['status'] = null;
    if (f.phase === 'mgPlay') {
      if (this.fallAt !== null) status = { text: 'Plouf ! Retour au dernier pont…', cls: 'fall' };
      else if (this.tornadoActive(f)) status = { text: f.imposter ? 'Tornade ! (tes commandes ne changent pas)' : 'Tornade ! Tes commandes sont mélangées…', cls: 'cursed' };
      else if (st?.finishedAt != null) status = { text: 'Arrivé ! Les autres ont encore un peu de temps…' };
      else if (f.playMs < 4000) status = { text: 'Traverse le gouffre ! E pour pousser' };
    }
    // commandes actuelles : touche → direction prise
    const controls = st?.controls ?? NORMAL_CONTROLS;
    const mixed = controls.some((d, i) => d !== NORMAL_CONTROLS[i]);
    const key = controls.join();
    const fresh = key !== this.lastControls;
    this.lastControls = key;
    const extra = f.phase === 'mgPlay' || f.phase === 'mgCountdown'
      ? `<div class="ctrl ${mixed ? 'mixed' : ''}" ${fresh ? '' : 'style="animation:none"'}><small>${mixed ? 'Commandes mélangées' : 'Tes commandes'}</small><div class="pad">${controls.map((d, i) => `<span class="k${i} ${d !== NORMAL_CONTROLS[i] ? 'swap' : ''}"><i>${KEYS[i]}</i><b>${ARROW[d]}</b></span>`).join('')}</div>${f.imposter && cp > 0 ? '<p>Imposteur : jamais mélangées</p>' : ''}</div>`
      : '';
    const myTime = st?.finishedAt ?? (f.phase === 'mgPlay' ? f.playMs : 0);
    return {
      boxes: [
        { label: st?.finishedAt != null ? 'Arrivé en' : 'Temps', value: formatSurvival(myTime), cls: st?.finishedAt != null ? 'caught' : '' },
        { label: 'Ponts', value: `${cp} / ${n}`, cls: 'sk' },
      ],
      chip: (id) => {
        const r = race?.[id];
        if (!r) return { text: 'Au départ' };
        if (r.finishedAt !== null) return { text: `Arrivé · ${formatSurvival(r.finishedAt)}`, cls: 'done' };
        return { text: `Pont ${id === f.myId ? cp : r.cp} / ${n}` };
      },
      status,
      extra,
    };
  }

  exit(): void {
    for (const sp of this.spins.values()) sp.cone.removeFromParent();
    this.spins.clear();
    this.fallAt = null;
  }
}
