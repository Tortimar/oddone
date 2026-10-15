import * as THREE from 'three';
import {
  BOMB, FEST, GORGON, SHEEP, BARRELS, BRAWL, CHESTS, GORGE, HORDE, MARKET, MINE, rampFloor, PODIUM_SPOTS, PODIUM_TELEPORT_MS, SLOT_COLORS, formatSurvival, isMinigamePhase, podiumGround,
  type MinigameSecret, type Hit, type MinigameState, type MinigameTick, type RoomState,
} from '@oddone/shared';
import { camera, renderer, resize, scene } from '../engine/render.ts';
import { setCameraCeiling, setCameraOrigin, setCameraRadius, updateCamera, type CameraMode } from '../game/cameraRig.ts';
import { actions, captureMouse, look } from '../game/input.ts';
import type { LocalPlayer, RemotePlayer } from '../game/players.ts';
import type { Network } from '../net/network.ts';
import type { Tavern } from '../world/tavern.ts';
import { $, escapeHtml } from '../ui/dom.ts';
import { portraitImg } from '../ui/portraits.ts';
import { RULES } from './rules.ts';
import { SkeletonBallArena } from './skeletonBallArena.ts';
import { GorgeArena } from './gorgeArena.ts';
import { MarketArena } from './marketArena.ts';
import { BarrelArena } from './barrelArena.ts';
import { HordeArena } from './hordeArena.ts';
import { ChestArena } from './chestArena.ts';
import { MineArena } from './mineArena.ts';
import { BombArena } from './bombArena.ts';
import { GorgonArena } from './gorgonArena.ts';
import { SheepArena } from './sheepArena.ts';
import { FestArena } from './festArena.ts';
import type { Frame, GameView } from './view.ts';
import { scoreFloats } from './announcer.ts';
import { FloatTexts } from '../world/floatText.ts';

/**
 * Déroulé d'un mini-jeu côté joueur (le serveur reste maître des phases et des contacts) :
 *
 *   rules        écran des règles façon Mario Party : entraînement en direct dans le cadre,
 *                règles, commandes, avantage de l'imposteur, bouton « Commencer » (Entrée)
 *   roleReveal   chacun découvre en secret s'il est l'imposteur de cette quête (carte de rôle)
 *   mgCountdown  tout le monde à sa place de départ, 3, 2, 1…
 *   mgPlay       la partie : on se déplace chez soi, le reste arrive du serveur
 *   mgResults    le podium tombe du ciel, la caméra se décale, classement façon Lego Party ;
 *                téléportés sur les marches, les joueurs peuvent bouger et se donner des coups
 *
 * Ce qui est propre à chaque mini-jeu (scène, règles du joueur local, HUD) est dans sa vue
 * (`GameView`, voir view.ts) : `SkeletonBallArena`, `GorgeArena`.
 */

export interface MinigameContext {
  me: () => LocalPlayer;
  remotes: Map<string, RemotePlayer>;
  net: Network;
  tavern: () => Tavern;
  imposter: () => boolean;
  /** Retour à la taverne : remettre bots et caméra en place. */
  onExit(): void;
}

const rich = (t: string) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

/** Crée la vue du mini-jeu demandé. */
function createView(mg: MinigameState): Promise<GameView> {
  if (mg.id === GORGE.id) return GorgeArena.create(mg.course!);
  if (mg.id === BARRELS.id) return BarrelArena.create();
  if (mg.id === HORDE.id) return HordeArena.create();
  if (mg.id === CHESTS.id) return ChestArena.create();
  if (mg.id === MINE.id) return MineArena.create();
  if (mg.id === MARKET.id) return MarketArena.create();
  if (mg.id === BOMB.id) return BombArena.create(mg.labyrinth!);
  if (mg.id === GORGON.id) return GorgonArena.create(mg.cemetery!);
  if (mg.id === SHEEP.id) return SheepArena.create();
  if (mg.id === FEST.id) return FestArena.create();
  return SkeletonBallArena.create(mg.arena!);
}

export function initMinigames(ctx: MinigameContext) {
  let state: RoomState | null = null;
  let view: GameView | null = null;
  let viewKey = '';
  let entered = false;
  let camMode: CameraMode = 'training';
  let rulesKey = '';
  let sentReady = false;
  let lastPhase = '';
  let simTime = 0;
  let countShown = '';
  // podium et coups
  let teleported = false, attackReadyAt = 0, panelShown = false;

  const myId = () => ctx.net.myId;
  const mg = (): MinigameState | null => state?.mg ?? null;
  const inMinigame = () => !!state && isMinigamePhase(state.phase) && !!state.mg;

  /** « +1 », « 1er »… au-dessus d'un joueur (voir announcer.ts et world/floatText.ts). */
  let floats: FloatTexts | null = null;
  function float(id: string, text: string, color: string): void {
    const target = id === myId() ? ctx.me().root : ctx.remotes.get(id)?.root;
    if (target && floats) floats.above(target, text, color);
  }

  function frame(): Frame {
    const s = state!, m = s.mg!, now = ctx.net.serverNow();
    return {
      phase: s.phase, state: s, mg: m, me: ctx.me(), myId: myId(), remotes: ctx.remotes, now,
      playMs: s.phase === 'mgPlay' && m.startedAt ? now - m.startedAt : 0, simTime, imposter: ctx.imposter(), net: ctx.net, float,
    };
  }

  /* ================= Entrée / sortie de l'arène ================= */

  async function prepare(m: MinigameState) {
    const key = `${state!.code}|${state!.game.round}|${m.id}|${JSON.stringify(m.arena?.graves.slice(0, 2) ?? m.course?.cells.slice(0, 3))}`;
    if (key === viewKey) return;
    viewKey = key;
    const built = await createView(m);
    if (viewKey !== key || !inMinigame()) return; // la partie a changé pendant le chargement
    view = built;
    enter();
  }

  function start(id: string): [number, number] { return mg()?.starts[id] ?? [0, 0]; }

  function enter() {
    if (!view || entered) return;
    entered = true;
    const me = ctx.me();
    view.scene.add(me.root);
    floats = new FloatTexts(view.scene);
    for (const r of ctx.remotes.values()) view.scene.add(r.root);
    // l'arme du mini-jeu, pour tout le monde (rendue en sortant)
    if (view.weapon) { me.equip(view.weapon); for (const r of ctx.remotes.values()) r.equip(view.weapon); }
    teleported = false; panelShown = false;
    placeAtStart();
    placeBotsAtStart();
    setCameraOrigin(mg()!.podium[0], mg()!.podium[1]);
    setCameraRadius(view.cameraRadius ?? null);
    setCameraCeiling(view.cameraCeiling ?? null);
    if (state!.phase === 'rules') view.startTraining(frame());
    $('rsMouse').hidden = !view.thirdPerson;
    camMode = state!.phase === 'rules' ? view.cameras.training : view.cameras.play;
    updateCamera(camMode, 0, 10, { position: me.root.position, yaw: me.yaw }); // pas de travelling depuis la taverne
    onPhase();
  }

  /** Face à la caméra au cimetière ; face au gouffre (dos à la caméra) au Pont Branlant. */
  function startYaw(x: number, z: number): number {
    if (view?.startYaw) return view.startYaw(x, z);
    return mg()?.id === GORGE.id ? Math.PI : 0;
  }

  /** Le joueur local à sa place de départ ; en 3e personne, la caméra se met derrière lui. */
  function placeAtStart() {
    const me = ctx.me(), [x, z] = start(myId()), yaw = startYaw(x, z);
    me.placeAt(x, z, yaw);
    look.yaw = view?.thirdPerson ? yaw + Math.PI : 0;
  }

  /**
   * Caméra à la souris (curseur capturé) : en 3e personne, dès l'entraînement de l'écran des règles
   * et pendant la partie. Sur l'écran des règles, Échap libère le curseur (pour cliquer « Commencer »)
   * et un clic dans le cadre d'entraînement le reprend.
   */
  function wantsMouseLook(): boolean {
    if (!entered || !view?.thirdPerson || !state) return false;
    const p = state.phase;
    return p === 'rules' || p === 'roleReveal' || p === 'mgCountdown' || p === 'mgPlay';
  }

  function exit() {
    const was = entered;
    entered = false;
    viewKey = '';
    $('rules').hidden = true; $('mgHud').hidden = true; $('mgResults').hidden = true;
    setCameraRadius(null); setCameraCeiling(null);
    floats?.clear(); floats = null;
    if (!was || !view) { view = null; return; }
    const me = ctx.me();
    view.exit();
    me.equip(null); for (const r of ctx.remotes.values()) r.equip(null);
    scene.add(me.root);
    for (const r of ctx.remotes.values()) { scene.add(r.root); r.snapNext(); r.model?.holder.rotation.set(0, 0, 0); }
    me.speedMul = 1; me.frozen = false; me.clearPose(); me.walkAnim = false;
    me.fourWay = false; me.controls = null; me.laneAssist = 0; me.canJump = true;
    me.model?.holder.rotation.set(0, 0, 0);
    const mine = state?.players.find((p) => p.id === myId());
    if (mine && mine.seat >= 0) me.sitInstant(mine.seat, ctx.tavern());
    view = null;
    resize(); // le rendu reprend tout l'écran
    ctx.onExit();
  }

  function placeBotsAtStart() {
    for (const p of state?.players ?? []) {
      if (!p.bot) continue;
      const [x, z] = start(p.id);
      ctx.remotes.get(p.id)?.teleport({ p: [x, 0, z], r: startYaw(x, z), a: 'Idle' });
    }
  }

  /* ================= Phases ================= */

  function onPhase() {
    if (!state || !entered || !view) return;
    const me = ctx.me(), phase = state.phase;
    if (phase === lastPhase) return;
    lastPhase = phase;
    $('rules').hidden = phase !== 'rules';
    $('mgHud').hidden = phase === 'rules' || phase === 'roleReveal';
    $('mgHud').classList.toggle('podium', phase === 'mgResults');
    $('mgResults').hidden = true;
    if (phase === 'roleReveal' || phase === 'mgCountdown') {
      view.stopTraining();
      if (phase === 'roleReveal' || !view.thirdPerson) placeAtStart(); // (sans retourner la caméra une 2e fois)
      placeBotsAtStart();
      camMode = view.cameras.play;
    } else if (phase === 'mgPlay') {
      simTime = 0; attackReadyAt = 0;
    } else if (phase === 'mgResults') {
      me.frozen = true;
      teleported = false; panelShown = false;
      camMode = 'podium';
    }
    view.onPhase(frame());
  }

  /** Place de chacun sur le podium : selon l'ordre du classement. */
  function podiumSpot(id: string): [number, number, number] {
    const i = mg()?.results?.findIndex((r) => r.id === id) ?? -1;
    const [x, z, y] = PODIUM_SPOTS[Math.max(0, i)] ?? PODIUM_SPOTS[PODIUM_SPOTS.length - 1];
    const [ox, oz] = mg()!.podium;
    return [ox + x, oz + z, y];
  }

  /** Tout le monde apparaît sur sa marche (chacun se place lui-même ; les bots viennent du serveur). */
  function teleportToPodium() {
    if (!view) return;
    teleported = true;
    const me = ctx.me();
    me.fourWay = false; me.controls = null; me.laneAssist = 0; me.canJump = true; me.speedMul = 1;
    me.model?.holder.rotation.set(0, 0, 0);
    const [x, z, y] = podiumSpot(myId());
    me.placeAt(x, z, 0, y);
    const res = mg()?.results?.find((r) => r.id === myId());
    if (res?.rank === 1) me.playPose('Cheer', { speed: 1 });
    for (const r of mg()?.results ?? []) {
      const [sx, sz, sy] = podiumSpot(r.id);
      view.particles.burst(sx, sy + 0.6, sz, SLOT_COLORS[(state?.players.find((p) => p.id === r.id)?.slot ?? 0) % 4], 14, 1.2, 0.9);
      const remote = ctx.remotes.get(r.id);
      remote?.teleport({ p: [sx, sy, sz], r: 0, a: r.rank === 1 ? 'Cheer' : 'Idle' });
      remote?.model?.holder.rotation.set(0, 0, 0);
    }
    attackReadyAt = 0;
  }

  /**
   * Coup de poing (au sol) ou de pied (en l'air) sur le podium, ou poussée pendant la partie :
   * on vise les joueurs devant soi, à portée.
   */
  function attack(push: boolean) {
    const me = ctx.me();
    if (simTime < attackReadyAt) return;
    attackReadyAt = simTime + (push ? view!.pushCooldownMs! : BRAWL.cooldownMs) / 1000;
    const kick = !push && !me.grounded;
    me.attack(kick);
    const reach = push ? view!.pushReach ?? GORGE.push.reach : BRAWL.reach;
    const P = me.root.position, fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
    for (const [id, r] of ctx.remotes) {
      const Q = r.root.position, dx = Q.x - P.x, dz = Q.z - P.z, d = Math.hypot(dx, dz);
      if (d > reach || d < 1e-3 || Math.abs(Q.y - P.y) > BRAWL.reachY) continue;
      if ((dx * fx + dz * fz) / d < 0.25) continue; // il faut être tourné vers lui
      ctx.net.hit(id, kick, push ? [fx, fz] : [dx / d, dz / d]);
    }
  }

  /** Temps restant avant de pouvoir repousser (0..1, 1 = prêt). */
  function pushCharge(): number {
    const cd = (view?.pushCooldownMs ?? 1) / 1000;
    return Math.min(1, Math.max(0, 1 - (attackReadyAt - simTime) / cd));
  }

  /* ================= Écran des règles ================= */

  function renderRulesStatic() {
    const m = mg(), s = state;
    if (!m || !s) return;
    const rules = RULES[m.id];
    if (!rules) return;
    const key = `${s.code}|${s.game.round}|${m.id}`;
    if (key === rulesKey) return;
    rulesKey = key;
    sentReady = false;
    $('rsQuest').textContent = `Quête ${s.game.round} sur ${s.game.totalRounds}`;
    $('rsTitle').textContent = rules.title;
    $('rsTag').textContent = rules.tagline;
    $('rsText').innerHTML = rules.rules.map((r) => `<p>${rich(r)}</p>`).join('');
    $('rsControls').innerHTML = rules.controls.map((c) => `<li><span class="keys">${c.keys.map((k) => `<span class="key">${escapeHtml(k)}</span>`).join('')}</span>${escapeHtml(c.label)}</li>`).join('');
    $('rsImpName').textContent = rules.imposter.name;
    $('rsImp').innerHTML = rich(rules.imposter.text);
    $('rsPoints').textContent = rules.points;
  }

  function renderRulesLive() {
    const s = state, m = mg();
    if (!s || !m) return;
    const now = ctx.net.serverNow();
    const left = Math.max(0, Math.ceil(((s.phaseEndsAt ?? now) - now) / 1000));
    const since = Math.max(0, Math.floor((now - (s.phaseStartedAt ?? now)) / 1000));
    $('rsClock').textContent = `${Math.floor(since / 60)}:${String(since % 60).padStart(2, '0')}`;
    const allReady = s.players.every((p) => m.ready.includes(p.id));
    $('rsAuto').textContent = allReady ? "C'est parti !" : `Début automatique dans ${left} s`;
    const btn = $<HTMLButtonElement>('rsStart');
    const ready = m.ready.includes(myId()) || sentReady;
    btn.disabled = ready;
    btn.querySelector('.lb')!.textContent = ready ? 'Prêt !' : 'Commencer';
    setHtml('rsChips', s.players.map((p) => {
      const ok = m.ready.includes(p.id);
      return `<li class="${ok ? 'ok' : ''}"><i style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</i><span>${escapeHtml(p.name)}${p.id === myId() ? ' (toi)' : ''}<small>${ok ? 'Prêt !' : 'Entraînement…'}</small></span></li>`;
    }).join(''));
  }

  function ready() {
    if (sentReady || state?.phase !== 'rules') return;
    sentReady = true;
    ctx.net.minigameReady();
  }
  // (un clic est un geste du joueur : le navigateur accepte alors de capturer la souris)
  $('rsStart').onclick = () => { ready(); captureMouse(); };
  $('rsFrame').addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) captureMouse(); });

  /* ================= HUD de partie ================= */

  function setHtml(id: string, html: string) {
    const el = $(id);
    if (el.dataset.k !== html) { el.innerHTML = html; el.dataset.k = html; }
  }

  function renderHud(f: Frame) {
    const s = f.state, m = f.mg, now = f.now;
    const info = view!.hud(f);
    setHtml('mgTop', info.boxes.map((b) => `<div class="mg-box ${b.cls ?? ''}"><small>${escapeHtml(b.label)}</small><b>${escapeHtml(b.value)}</b></div>`).join(''));
    setHtml('mgChips', s.players.map((p) => {
      const c = info.chip(p.id);
      return `<li class="${c.cls ?? ''} ${p.id === f.myId ? 'me' : ''}"><i style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</i>${escapeHtml(p.name)}<small>${escapeHtml(c.text)}</small></li>`;
    }).join(''));
    setHtml('mgExtra', info.extra ?? '');
    const pushEl = $('mgPush');
    pushEl.hidden = !(view!.pushCooldownMs && s.phase === 'mgPlay');
    if (!pushEl.hidden) {
      const k = pushCharge();
      (pushEl.querySelector('b') as HTMLElement).style.width = `${k * 100}%`;
      pushEl.classList.toggle('ready', k >= 1);
    }

    // compte à rebours puis « Partez ! »
    let count = '';
    if (s.phase === 'mgCountdown' && s.phaseEndsAt) count = String(Math.min(3, Math.max(1, Math.ceil((s.phaseEndsAt - now) / 1000))));
    else if (s.phase === 'mgPlay' && m.startedAt && now - m.startedAt < 1000) count = m.id === GORGE.id ? 'Partez !' : m.id === BARRELS.id ? 'Grimpez !' : m.id === HORDE.id ? 'À l’attaque !' : m.id === CHESTS.id ? 'Bonne chance…' : m.id === MINE.id ? 'En voiture !' : m.id === BOMB.id ? 'Sauve qui peut !' : m.id === GORGON.id ? 'Avancez… doucement !' : m.id === SHEEP.id ? 'Partez !' : m.id === FEST.id ? 'Triez !' : 'Courez !';
    const countEl = $('mgCount');
    if (count !== countShown) {
      countShown = count;
      countEl.textContent = count;
      countEl.classList.remove('pop'); void countEl.offsetWidth; if (count) countEl.classList.add('pop');
    }
    const status = $('mgStatus');
    status.textContent = info.status?.text ?? '';
    status.className = `mg-status ${info.status?.cls ?? ''}`;
    $('mgCurse').classList.toggle('on', !!info.vignette);

    if (s.phase === 'mgResults' && s.phaseStartedAt && s.phaseEndsAt) {
      $('mgrBar').style.width = `${Math.min(100, ((now - s.phaseStartedAt) / (s.phaseEndsAt - s.phaseStartedAt)) * 100)}%`;
    }
  }

  /** Classement façon Lego Party : à droite du podium (en bas sur mobile). */
  function renderResults() {
    const s = state, m = mg();
    if (!s || !m?.results) return;
    const rules = RULES[m.id];
    $('mgrQuest').textContent = rules?.title ?? '';
    $('mgrTitle').textContent = 'Classement';
    $('mgrList').innerHTML = m.results.map((r, i) => {
      const p = s.players.find((q) => q.id === r.id);
      if (!p) return '';
      let time: string;
      if (m.fest) time = m.fest.out.includes(r.id) ? `Explosé à ${formatSurvival(r.survivedMs)}` : `Dernier debout · ${m.fest.boards[r.id]?.sorted ?? 0} triées`;
      else if (m.sheep) time = m.sheep.times[r.id] != null ? `Arrivé en ${formatSurvival(m.sheep.times[r.id])}` : 'Pas arrivé à temps';
      else if (m.gorgon) time = m.gorgon.finished.includes(r.id) ? 'Arrivé !' : m.gorgon.petrified.includes(r.id) ? 'Pétrifié' : 'Pas arrivé à temps';
      else if (m.bomb) time = m.bomb.alive.includes(r.id) ? 'Dernier debout !' : `Explosé à la manche ${m.bomb.outRound[r.id] ?? 1}`;
      else if (m.mine) time = `${m.mine.points[r.id] ?? 0} points de manche`;
      else if (m.chests) time = m.chests.alive.includes(r.id) ? 'Dernier survivant !' : `Mimique à la manche ${(m.chests.outRound[r.id] ?? 0) + 1}`;
      else if (m.market) time = `${m.market.points[r.id] ?? 0} points de manche`;
      else if (m.horde) { const k = m.horde.kills[r.id] ?? [0, 0]; time = `${m.horde.points[r.id] ?? 0} points${k[1] ? ` · ${k[1]} doré${k[1] > 1 ? 's' : ''}` : ''}`; }
      else if (m.ramp) time = m.ramp[r.id]?.finishedAt != null ? `Arrivé en ${formatSurvival(r.survivedMs)}` : `Pas arrivé (rampe ${Math.min(BARRELS.runs, rampFloor(m.ramp[r.id]?.best ?? 0))} / ${BARRELS.runs})`;
      else if (m.race) time = m.race[r.id]?.finishedAt != null ? `Arrivé en ${formatSurvival(r.survivedMs)}` : `Pas arrivé (pont ${m.race[r.id]?.cp ?? 0})`;
      else time = m.caught[r.id] ? formatSurvival(r.survivedMs) : 'Jamais touché !';
      return `<li class="${r.rank === 1 ? 'first' : ''}" style="animation-delay:${0.15 + i * 0.12}s"><span class="rk">${r.rank}</span><span class="nm"><i style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</i><span>${escapeHtml(p.name)}${p.id === myId() ? ' (toi)' : ''}<small>${time}</small></span></span><span class="pt"><span class="coin"></span>+${r.points}</span></li>`;
    }).join('');
  }

  /* ================= Boucle ================= */

  function update(t: number, dt: number) {
    if (!state || !entered || !view) return;
    simTime += dt;
    const f = frame(), me = f.me, phase = f.phase;
    const podiumTime = phase === 'mgResults' && state.phaseStartedAt ? f.now - state.phaseStartedAt : 0;
    if (phase === 'mgResults') {
      view.podium.setTime(podiumTime / 1000);
      if (!teleported && podiumTime >= PODIUM_TELEPORT_MS && view.podium.ready) teleportToPodium();
      if (!panelShown && podiumTime >= PODIUM_TELEPORT_MS - 300) { panelShown = true; renderResults(); $('mgResults').hidden = false; }
    }
    const brawling = phase === 'mgResults' && teleported;
    me.frozen = !(phase === 'rules' || phase === 'mgPlay' || brawling);
    // caméras fixes (et podium) : « haut » = vers le fond de l'arène ; en 3e personne, la souris décide
    if (!view.thirdPerson || phase === 'mgResults') look.yaw = phase === 'mgResults' ? 0 : view.controlYaw ?? 0;
    if (phase !== 'mgResults') view.beforeMove(f, dt);

    if (phase === 'rules' && actions.confirm) ready();
    const playing = (phase === 'mgPlay' || phase === 'rules') && !me.frozen;
    const used = playing && (actions.act || actions.special) && !!view.onAct?.(f, actions.special);
    if (brawling && actions.act) attack(false);
    else if (playing && actions.act && !used && view.pushCooldownMs) attack(true);

    const others = view.solidPlayers && !brawling ? [...ctx.remotes.values()].map((r) => r.root.position) : [];
    me.update(t, dt, view.world, others);

    const flash = phase !== 'mgResults' ? view.afterMove(f, dt) : null;
    if (brawling && me.root.position.y < -8) { const [x, z, y] = podiumSpot(myId()); me.placeAt(x, z, 0, y); } // tombé du podium
    if (phase === 'rules') {
      if (flash) {
        const el = $('rsFlash');
        el.textContent = flash;
        el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
      }
      renderRulesLive();
    } else renderHud(f);

    view.update(t, dt, f);
    floats?.update();
    updateCamera(camMode, t, dt, { position: me.root.position, yaw: me.yaw });
    if (view.podium.shake > 0) {
      camera.position.x += (Math.random() - 0.5) * view.podium.shake * 0.5;
      camera.position.y += (Math.random() - 0.5) * view.podium.shake * 0.5;
    }
  }

  const frameRect = new THREE.Vector4();
  function render() {
    if (!view || !entered) {
      // l'arène se charge : écran neutre derrière l'écran des règles
      renderer.setClearColor('#241338');
      renderer.clear();
      return;
    }
    let w = innerWidth, h = innerHeight;
    const rules = state?.phase === 'rules';
    if (rules) {
      const r = $('rsFrame').getBoundingClientRect();
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      frameRect.set(r.left, innerHeight - r.bottom, w, h);
      renderer.setScissorTest(true);
      renderer.setViewport(frameRect.x, frameRect.y, w, h);
      renderer.setScissor(frameRect.x, frameRect.y, w, h);
    }
    if (Math.abs(camera.aspect - w / h) > 1e-3) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    renderer.render(view.scene, camera);
    if (rules) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, innerWidth, innerHeight);
    }
  }

  return {
    /** true pendant les phases de mini-jeu : main.ts lui laisse la main. */
    get active(): boolean { return inMinigame(); },
    /** Le mini-jeu veut la caméra à la souris (curseur capturé). */
    get mouseLook(): boolean { return wantsMouseLook(); },
    /** Le mini-jeu cache l'étiquette de nom du joueur local. */
    get hideOwnTag(): boolean { return !!view?.hideOwnTag && state?.phase !== 'mgResults'; },
    /** Pour le débogage et les tests automatisés. */
    get view() { return view; },
    onState(s: RoomState | null) {
      // points gagnés, places aux étapes : comparés à l'état précédent
      const prev = state?.mg;
      if (entered && prev && s?.mg && s.phase === 'mgPlay') for (const e of scoreFloats(prev, s.mg)) float(e.id, e.text, e.color);
      state = s;
      if (!s || !inMinigame()) { lastPhase = ''; exit(); return; }
      renderRulesStatic();
      if (s.phase === 'rules') $('rules').hidden = false; // même pendant le chargement de l'arène
      if (!view) void prepare(s.mg!);
      else onPhase();
      if (s.phase === 'rules') renderRulesLive();
    },
    onTick(tick: MinigameTick) {
      if (!view || !entered || !state) return;
      const f = frame();
      if (state.phase !== 'mgResults') { view.applyTick(tick, f); return; }
      if (!teleported) return; // les bots apparaissent sur le podium avec tout le monde
      const [ox, oz] = f.mg.podium;
      for (const [id, x, z, yaw, anim] of tick.bots) {
        const y = view.podium.ready ? podiumGround(x - ox, z - oz) : 0;
        ctx.remotes.get(id)?.setTransform({ p: [x, y, z], r: yaw, a: anim });
      }
    },
    /** Un coup (podium) ou une poussée (partie) : étoiles à l'impact, et recul si c'est moi qui le prends. */
    /** Information secrète du serveur (pour moi seul). */
    onSecret(sec: MinigameSecret) {
      if (!view || !entered || !state || state.phase !== 'mgPlay') return;
      view.onSecret?.(sec, frame());
    },
    onHit(h: Hit) {
      if (!view || !entered || !state) return;
      if (state.phase !== 'mgResults' && state.phase !== 'mgPlay') return;
      const f = frame();
      const target = h.to === f.myId ? f.me.root : ctx.remotes.get(h.to)?.root;
      if (target) view.particles.burst(target.position.x, target.position.y + 1.3, target.position.z, h.kick ? '#ffd23f' : '#fff3c2', h.kick ? 12 : 8, 1.6, 0.6);
      if (h.to === f.myId) f.me.knock(h.dir, h.kick);
      view.onHit?.(h, f);
    },
    update,
    render,
  };
}
