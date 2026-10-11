import * as THREE from 'three';
import { DEFAULT_CONFIG, SLOT_COLORS, MOVE_RATE_HZ, sanitizeConfig, sanitizeName, type RoomState } from '@oddone/shared';
import { camera, canvas, renderer, scene } from './engine/render.ts';
import { computeAnchors, loadCharacterLibrary } from './characters/library.ts';
import { playAnimation } from './characters/character.ts';
import { buildTavern, type Npc, type Tavern } from './world/tavern.ts';
import { LocalPlayer, RemotePlayer } from './game/players.ts';
import { actions, consumeActions, initInput, look, setInputEnabled } from './game/input.ts';
import { updateCamera, type CameraMode } from './game/cameraRig.ts';
import { Network } from './net/network.ts';
import { initAtelier } from './ui/atelier.ts';
import { $, escapeHtml, toast } from './ui/dom.ts';

/* ================= État du client ================= */
let tavern: Tavern;
let me: LocalPlayer;
let mode: 'menu' | 'tavern' = 'menu';
let camMode: CameraMode = 'menu';
let room: RoomState | null = null;
const remotes = new Map<string, RemotePlayer>();
let profile = loadProfile();

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('oddone-profile') ?? '{}');
    return { name: sanitizeName(saved.name ?? ''), cfg: sanitizeConfig(saved.cfg ?? DEFAULT_CONFIG) };
  } catch { return { name: 'Aventurier', cfg: { ...DEFAULT_CONFIG } }; }
}
function saveProfile() { try { localStorage.setItem('oddone-profile', JSON.stringify(profile)); } catch { /* stockage indisponible */ } }

/* ================= Réseau ================= */
const net = new Network({
  onState: (s) => applyRoomState(s),
  onMoved: (id, t) => remotes.get(id)?.setTransform(t),
  onGameStart: (round) => {
    say(tavern.npcs.barman, round === 1 ? 'Que la première manche commence !' : `Manche ${round}, en piste !`);
  },
  onConnectionChange: (ok) => {
    $('netNote').textContent = ok ? '' : 'Connexion au serveur perdue, reconnexion…';
    if (!ok && mode === 'tavern') leaveTavern('La connexion au serveur a été coupée.');
  },
});

function applyRoomState(s: RoomState) {
  room = s;
  const mine = s.players.find((p) => p.id === net.myId);
  if (mine) {
    me.setIdentity(mine.name, mine.slot);
    // le serveur a libéré mon tabouret (fin de manche, conflit…) : je me lève
    if (mine.seat < 0 && me.seat >= 0) me.standUp();
  }
  const seen = new Set<string>();
  for (const info of s.players) {
    if (info.id === net.myId) continue;
    seen.add(info.id);
    let r = remotes.get(info.id);
    if (!r) {
      r = new RemotePlayer(info.name, info.cfg, info.slot);
      remotes.set(info.id, r);
      toast(`${info.name} entre dans la taverne`);
    }
    r.setInfo(info);
  }
  for (const [id, r] of remotes) {
    if (!seen.has(id)) { r.dispose(); remotes.delete(id); toast(`${r.name} a quitté la taverne`); }
  }
  renderLobbyCard();
}

/* ================= Accueil ================= */
const pseudo = $<HTMLInputElement>('pseudo');
const codeIn = $<HTMLInputElement>('codeIn');
pseudo.value = profile.name === 'Aventurier' ? '' : profile.name;
codeIn.value = (new URLSearchParams(location.search).get('code') ?? '').toUpperCase().slice(0, 4);

function homeMessage(t: string) { $('homeMsg').textContent = t; }
function setBusy(b: boolean) { for (const id of ['createBtn', 'joinBtn']) $<HTMLButtonElement>(id).disabled = b; }

async function enter(kind: 'create' | 'join') {
  profile.name = sanitizeName(pseudo.value);
  saveProfile();
  const code = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (kind === 'join' && code.length !== 4) { homeMessage('Le code fait 4 lettres.'); return; }
  setBusy(true); homeMessage('Connexion à la taverne…');
  const res = kind === 'create' ? await net.create(profile.name, profile.cfg) : await net.join(code, profile.name, profile.cfg);
  setBusy(false);
  if ('error' in res) { homeMessage(res.error); return; }
  homeMessage('');
  mode = 'tavern'; camMode = 'follow';
  $('home').hidden = true; $('hud').hidden = false;
  $('codeOut').textContent = res.state.code;
  history.replaceState(null, '', `?code=${res.state.code}`);
  me.spawn();
  setInputEnabled(true);
  canvas.focus();
  applyRoomState(res.state);
  setTimeout(() => say(tavern.npcs.barman, 'Bienvenue ! Asseyez-vous au comptoir quand vous êtes prêts.'), 700);
  toast(kind === 'create' ? `Taverne ouverte ! Donne le code ${res.state.code} à tes amis.` : 'Bienvenue dans la taverne !');
}

function leaveTavern(message = '') {
  net.leave();
  room = null;
  for (const r of remotes.values()) r.dispose();
  remotes.clear();
  mode = 'menu'; camMode = 'menu';
  setInputEnabled(false);
  atelier.close();
  $('hud').hidden = true; $('home').hidden = false; $('banner').hidden = true;
  homeMessage(message);
  history.replaceState(null, '', location.pathname);
}

$('createBtn').onclick = () => enter('create');
$('joinBtn').onclick = () => enter('join');
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter('join'); });
$('quit').onclick = () => leaveTavern();
$('copy').onclick = () => {
  const url = `${location.origin}${location.pathname}?code=${room?.code ?? ''}`;
  navigator.clipboard?.writeText(url).then(() => toast('Lien d\'invitation copié')).catch(() => toast(`Code : ${room?.code}`));
};

/* ================= HUD ================= */
function renderLobbyCard() {
  if (!room) return;
  const items = room.players.map((p) => {
    const ready = p.seat >= 0, isMe = p.id === net.myId;
    return `<li><i class="dot" style="--c:${SLOT_COLORS[p.slot % 4]}"></i><span class="nm">${escapeHtml(p.name)}${isMe ? ' (toi)' : ''}</span><span class="st${ready ? ' ok' : ''}">${ready ? 'Prêt' : 'Debout'}</span></li>`;
  });
  for (let i = room.players.length; i < 4; i++) items.push('<li><i class="dot" style="--c:rgba(42,26,16,.12)"></i><span class="nm empty">Place libre</span></li>');
  $('plist').innerHTML = items.join('');
}

function renderBanner() {
  const b = $('banner');
  if (!room || mode !== 'tavern') { b.hidden = true; return; }
  const seated = room.players.filter((p) => p.seat >= 0).length;
  if (room.phase === 'countdown' && room.countdownEndsAt) {
    const left = Math.max(0, Math.ceil((room.countdownEndsAt - (Date.now() + net.clockOffset)) / 1000));
    b.hidden = false; b.innerHTML = `Tout le monde est prêt !<small>La manche commence dans ${left}…</small>`;
  } else if (room.phase === 'playing') {
    b.hidden = false; b.innerHTML = 'Manche en cours<small>Les mini-jeux ne sont pas encore branchés : retour au comptoir dans quelques secondes.</small>';
  } else if (me.seat >= 0) {
    b.hidden = false; b.innerHTML = `Prêt ! En attente des autres (${seated}/${room.players.length})<small>Les autres aventuriers doivent s'asseoir au comptoir.</small>`;
  } else b.hidden = true;
}

/* ================= PNJ et interactions ================= */
function say(npc: Npc, text: string) {
  const el = $('bub-' + npc.id);
  el.innerHTML = `<b>${escapeHtml(npc.name)}</b>${escapeHtml(text)}`;
  npc.talkTime = 3.2;
  playAnimation(npc, 'Interact', { once: true, fade: 0.2, restart: true });
  npc.busyTime = 1.2;
}
const BARMAN_LINES = ['Une chope pour le héros !', 'On raconte qu\'un imposteur traîne dans le coin…', 'Méfie-toi de celui qui sourit trop.', 'La maison ne fait pas crédit aux traîtres.'];

type Target = { kind: 'tailor' | 'barman' | 'stand'; label: string } | { kind: 'sit'; seat: number; label: string };
function seatTaken(i: number) { return !!room?.players.some((p) => p.id !== net.myId && p.seat === i); }
function findTarget(): Target | null {
  if (me.seat >= 0) return me.sitPhase === 'idle' ? { kind: 'stand', label: 'Se lever' } : null;
  const P = me.root.position;
  if (P.distanceTo(tavern.npcs.tailor.home) < 2.8) return { kind: 'tailor', label: 'Parler à Mirabelle, la couturière' };
  let best = -1, bestD = 1.9;
  tavern.stools.forEach((s, i) => { if (seatTaken(i)) return; const d = Math.hypot(P.x - s.x, P.z - (s.z + 0.6)); if (d < bestD) { bestD = d; best = i; } });
  if (best >= 0) return { kind: 'sit', seat: best, label: 'S\'asseoir au comptoir (prêt)' };
  if (P.distanceTo(tavern.npcs.barman.home) < 3.6) return { kind: 'barman', label: 'Parler à Gaspard' };
  return null;
}
let pendingSeat = false;
async function act(t: Target) {
  if (t.kind === 'tailor') openAtelier();
  else if (t.kind === 'barman') say(tavern.npcs.barman, BARMAN_LINES[Math.floor(Math.random() * BARMAN_LINES.length)]);
  else if (t.kind === 'stand') { me.standUp(); net.leaveSeat(); camMode = 'follow'; look.yaw = 0; }
  else if (t.kind === 'sit' && !pendingSeat) {
    pendingSeat = true;
    const ok = await net.takeSeat(t.seat);
    pendingSeat = false;
    if (!ok) { toast('Ce tabouret vient d\'être pris !'); return; }
    me.sit(t.seat, tavern);
    camMode = 'bar';
    say(tavern.npcs.barman, BARMAN_LINES[0]);
  }
}

/* ================= Atelier ================= */
const atelier = initAtelier({
  getProfile: () => profile,
  onChange: (name, cfg) => {
    profile = { name, cfg };
    saveProfile();
    me.applyLook(cfg);
    me.setIdentity(name, me.slot);
    net.sendProfile(name, cfg);
  },
  onClose: () => {
    camMode = me.seat >= 0 ? 'bar' : 'follow';
    me.frozen = false; me.faceYaw = null;
    look.yaw = me.yaw + Math.PI;
    say(tavern.npcs.tailor, 'Superbe ! Tu vas faire tourner des têtes.');
    canvas.focus();
  },
});
function openAtelier() {
  atelier.open();
  camMode = 'tailor';
  me.frozen = true;
  const tailor = tavern.npcs.tailor.home, P = me.root.position;
  me.faceYaw = Math.atan2(tailor.x - P.x, tailor.z - P.z) + Math.PI * 0.75;
  say(tavern.npcs.tailor, 'Un nouveau look ? Choisis, je m\'occupe des coutures !');
}

/* ================= Boucle ================= */
const tmp = new THREE.Vector3();
function placeBubble(npc: Npc) {
  const el = $('bub-' + npc.id);
  if (npc.talkTime <= 0 || mode !== 'tavern') { el.hidden = true; return; }
  tmp.copy(npc.root.position); tmp.y += 3.2 * (npc.model?.size ?? 1); tmp.project(camera);
  if (tmp.z > 1) { el.hidden = true; return; }
  el.hidden = false;
  el.style.left = `${((tmp.x + 1) / 2) * innerWidth}px`;
  el.style.top = `${((1 - tmp.y) / 2) * innerHeight}px`;
}

let simTime = 0, sendTimer = 0;
function update(dt: number) {
  simTime += dt;
  const t = simTime;
  if (mode === 'tavern') {
    me.update(t, dt, tavern, [...remotes.values()].map((r) => r.root.position));
    const target = findTarget();
    if (actions.act && target) act(target);
    const prompt = $('prompt');
    if (target && !atelier.isOpen && target.kind !== 'stand') { prompt.hidden = false; prompt.querySelector('span')!.textContent = target.label; }
    else prompt.hidden = true;
    $('standBtn').hidden = !(me.seat >= 0 && me.sitPhase === 'idle');
    sendTimer -= dt;
    if (sendTimer <= 0) { sendTimer = 1 / MOVE_RATE_HZ; net.sendMove(me.transform()); }
    // le tavernier suit les joueurs du regard
    const barman = tavern.npcs.barman;
    if (barman.busyTime <= 0) barman.root.rotation.y = Math.atan2(me.root.position.x - barman.home.x, Math.max(0.5, me.root.position.z - barman.home.z)) * 0.6;
  } else {
    me.update(t, dt, tavern, []);
  }
  consumeActions();
  for (const r of remotes.values()) r.update(t, dt);
  const occupied = new Set(room?.players.filter((p) => p.seat >= 0).map((p) => p.seat) ?? []);
  tavern.mugs.forEach((m, i) => { m.visible = occupied.has(i); });
  tavern.update(t, dt);
  for (const npc of Object.values(tavern.npcs)) placeBubble(npc);
  renderBanner();
  updateCamera(camMode, t, dt, { position: me.root.position, yaw: me.yaw }, tavern);
}

const clock = new THREE.Clock();
function loop() {
  update(Math.min(clock.getDelta(), 1 / 30));
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* ================= Démarrage ================= */
async function boot() {
  await loadCharacterLibrary();
  computeAnchors();
  tavern = await buildTavern();
  me = new LocalPlayer(profile.name, profile.cfg, 0);
  me.root.position.set(0, 0, 4.6);
  initInput(() => { if (atelier.isOpen) atelier.close(); });
  $('prompt').onclick = () => { actions.act = true; };
  $('standBtn').onclick = () => { actions.act = true; };
  document.fonts?.load('40px "Lilita One"').then(() => me.tag.set(me.name, SLOT_COLORS[me.slot % 4], true)).catch(() => {});
  $('loading').classList.add('done');
  pseudo.focus();
  loop();
  // utile pour les tests automatisés et le débogage dans la console
  Object.assign(window, { __oddone: { me, tavern, net, remotes, fastForward: (s: number) => { for (let i = 0; i < s * 30; i++) update(1 / 30); } } });
}

boot().catch((err) => {
  console.error(err);
  $('loading').innerHTML = `Le chargement a échoué.<small>${escapeHtml(String(err?.message ?? err))}</small>`;
});
