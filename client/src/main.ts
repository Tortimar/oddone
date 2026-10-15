import * as THREE from 'three';
import { DEFAULT_CONFIG, MAX_PLAYERS, QUEST_BY_ID, SLOT_COLORS, MOVE_RATE_HZ, isCeremony, isMinigamePhase, sanitizeConfig, sanitizeName, type Phase, type PlayerInfo, type RoomState } from '@oddone/shared';
import { camera, canvas, renderer, scene } from './engine/render.ts';
import { computeAnchors, loadCharacterLibrary } from './characters/library.ts';
import { playAnimation } from './characters/character.ts';
import { buildTavern, type Npc, type Tavern } from './world/tavern.ts';
import { LocalPlayer, RemotePlayer } from './game/players.ts';
import { actions, consumeActions, initInput, look, setInputEnabled, setMouseLook } from './game/input.ts';
import { updateCamera, type CameraMode } from './game/cameraRig.ts';
import { Network } from './net/network.ts';
import { initAtelier } from './ui/atelier.ts';
import { initQuestDialog } from './ui/questDialog.ts';
import { initRoleCard } from './ui/roleCard.ts';
import { initMinigames } from './minigames/minigame.ts';
import { RULES } from './minigames/rules.ts';
import { $, escapeHtml, toast } from './ui/dom.ts';
import { AudioDirector } from './audio/director.ts';
import { initSoundButton } from './audio/soundButton.ts';
import { playSfx } from './audio/audio.ts';
import { CoinShow, displayedScores } from './world/coins.ts';
import { FinaleShow, type FinaleHooks } from './world/finale.ts';
import { SuspectPicker } from './ui/suspectPicker.ts';
import { portraitImg } from './ui/portraits.ts';

/* ================= État du client ================= */
let tavern: Tavern;
let me: LocalPlayer;
let mode: 'menu' | 'tavern' = 'menu';
let camMode: CameraMode = 'menu';
let room: RoomState | null = null;
const remotes = new Map<string, RemotePlayer>();
/** Rôle secret de la soirée (reçu du serveur, à moi seul). */
let imposter = false;
let profile = loadProfile();

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('oddone-profile') ?? '{}');
    // (gabarit et objets en main ne se choisissent plus : taille normale, mains vides)
    return { name: sanitizeName(saved.name ?? ''), cfg: { ...sanitizeConfig(saved.cfg ?? DEFAULT_CONFIG), size: '1', right: 'none', left: 'none' } };
  } catch { return { name: 'Aventurier', cfg: { ...DEFAULT_CONFIG } }; }
}
function saveProfile() { try { localStorage.setItem('oddone-profile', JSON.stringify(profile)); } catch { /* stockage indisponible */ } }

/* ================= Son ================= */
const audio = new AudioDirector();
audio.onState('menu', null, '');
initSoundButton();

/* ================= Réseau ================= */
const net = new Network({
  onState: (s) => applyRoomState(s),
  onMoved: (id, t) => remotes.get(id)?.setTransform(t),
  onTick: (t) => minigames.onTick(t),
  onRole: (role) => {
    imposter = role.imposter;
    audio.onRole(role.imposter);
    roleCard.show(role.imposter, QUEST_BY_ID.get(role.quest)?.name ?? 'cette quête', RULES[role.quest]?.imposter, profile.cfg);
  },
  onHit: (h) => {
    if (h.to === net.myId || h.from === net.myId) playSfx('coup', { volume: h.kick ? 1.3 : 1 });
    minigames.onHit(h);
  },
  onSecret: (sec) => minigames.onSecret(sec),
  onConnectionChange: (ok) => {
    $('netNote').textContent = ok ? '' : 'Connexion au serveur perdue, reconnexion…';
    if (!ok && mode === 'tavern') leaveTavern('La connexion au serveur a été coupée.');
  },
});

/** Phases où le rôle de la quête en cours compte encore (jusqu'à la révélation). */
const ROLE_PHASES: Phase[] = ['roleReveal', 'mgCountdown', 'mgPlay', 'mgResults', 'debrief', 'scoreReveal', 'imposterVote', 'imposterReveal'];
/** Phases où la caméra se tourne vers les joueurs (point de vue du tavernier) : pièces d'or et vote. */
const FACING: Phase[] = ['scoreReveal', 'imposterVote', 'imposterReveal'];

function applyRoomState(s: RoomState) {
  const wasCeremony = room ? isCeremony(room.phase) : false;
  const prevPhase = room?.phase;
  room = s;
  const mine = s.players.find((p) => p.id === net.myId);
  if (mine) {
    me.setIdentity(mine.name, mine.slot);
    // le serveur a libéré mon tabouret (fin de soirée, conflit…) : je me lève
    if (mine.seat < 0 && me.seat >= 0) { me.standUp(); camMode = 'follow'; look.yaw = 0; }
  }
  const ceremony = isCeremony(s.phase);
  if (ceremony && !wasCeremony) { atelier.close(); camMode = 'barman'; tavern.npcs.barman.talkTime = 0; }
  if (!ceremony && wasCeremony) {
    if (me.seat >= 0) camMode = 'bar';
    imposter = false; roleCard.reset();
  }
  if (ROLE_PHASES.includes(s.phase)) roleCard.setVisible(true);
  else if (imposter || prevPhase === 'imposterReveal') { imposter = false; roleCard.reset(); }
  // vote de l'imposteur : la caméra se tourne vers les joueurs (point de vue du tavernier)
  if (s.phase !== prevPhase && ceremony && !isMinigamePhase(s.phase)) {
    // grand podium : la caméra passe côté porte, face au podium (cadre donné par `finaleShow`)
    const want: CameraMode = s.phase === 'finale' ? 'custom' : FACING.includes(s.phase) ? 'suspects' : 'barman';
    // changement de côté du comptoir : coupe franche (un travelling passerait à travers les têtes)
    if (want !== camMode) {
      camMode = want;
      if (want === 'custom') finaleShow.aim();
      updateCamera(camMode, simTime, 10, { position: me.root.position, yaw: me.yaw });
    }
  }
  $('hint').hidden = ceremony; // les commandes de la taverne ne servent plus pendant la soirée
  questDialog.update(s);
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
    if (info.bot && !isMinigamePhase(s.phase)) placeBot(r, info);
  }
  for (const [id, r] of remotes) {
    if (!seen.has(id)) { r.dispose(); remotes.delete(id); toast(`${r.name} a quitté la taverne`); }
  }
  minigames.onState(s);
  audio.onState(mode, s, net.myId);
  renderLobbyCard();
}

/** Les bots n'envoient pas de position : on les place d'après leur tabouret. */
const botSeats = new Map<string, number>();
function placeBot(r: RemotePlayer, info: PlayerInfo) {
  const t = info.seat >= 0
    ? (() => { const st = tavern.stools[info.seat]; return { p: [st.x + tavern.sitOffset.x, 0, st.z + tavern.sitOffset.z] as [number, number, number], r: Math.PI, a: 'Sit_Chair_Idle' }; })()
    : { p: [-3 + info.slot * 2, 0, 5.4] as [number, number, number], r: Math.PI, a: 'Idle' };
  if (botSeats.get(info.id) !== info.seat) { botSeats.set(info.id, info.seat); r.teleport(t); }
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
  botSeats.clear();
  questDialog.update(null);
  minigames.onState(null);
  imposter = false; roleCard.reset();
  mode = 'menu'; camMode = 'menu';
  audio.onState('menu', null, '');
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
  const host = room.hostId === net.myId, lobby = !isCeremony(room.phase);
  const items = room.players.map((p) => {
    const ready = p.seat >= 0, isMe = p.id === net.myId;
    const remove = p.bot && host && lobby ? `<button class="rm" data-bot="${escapeHtml(p.id)}" aria-label="Retirer ${escapeHtml(p.name)}">✕</button>` : '';
    return `<li><i class="dot" style="--c:${SLOT_COLORS[p.slot % 4]}"></i><span class="nm">${escapeHtml(p.name)}${isMe ? ' (toi)' : ''}${p.bot ? '<span class="bot">BOT</span>' : ''}</span><span class="st${ready ? ' ok' : ''}">${ready ? 'Prêt' : 'Debout'}</span>${remove}</li>`;
  });
  for (let i = room.players.length; i < 4; i++) items.push('<li><i class="dot" style="--c:rgba(42,26,16,.12)"></i><span class="nm empty">Place libre</span></li>');
  $('plist').innerHTML = items.join('');
  const addBot = $<HTMLButtonElement>('addBot');
  addBot.hidden = !host || !lobby;
  addBot.disabled = room.players.length >= MAX_PLAYERS;
}

/* ================= Pièces d'or ================= */
let coinShow: CoinShow;
let suspects: SuspectPicker;
/** Tableau des pièces d'or, pendant toute la soirée au comptoir (au rythme des pièces qui tombent). */
function renderCoinBoard() {
  const el = $('coinBoard');
  // (pas pendant le grand podium : les plaques au-dessus des joueurs donnent le compte, place par place)
  const show = !!room && mode === 'tavern' && isCeremony(room.phase) && !isMinigamePhase(room.phase) && room.game.round > 0 && room.phase !== 'finale';
  el.hidden = !show;
  if (!show || !room) return;
  const shown = displayedScores(room, net.serverNow());
  const html = [...room.players].sort((a, b) => a.slot - b.slot).map((p) => {
    const n = shown[p.id] ?? 0;
    return `<li data-id="${escapeHtml(p.id)}"><i style="--c:${SLOT_COLORS[p.slot % 4]}">${portraitImg(p.cfg, p.name)}</i><span class="nm">${escapeHtml(p.name)}${p.id === net.myId ? ' (toi)' : ''}</span><b><span class="coin" aria-hidden="true"></span>${n}</b></li>`;
  }).join('');
  if (el.dataset.k !== html) {
    // une pièce de plus ou de moins : le compteur sautille
    const before = new Map([...el.querySelectorAll<HTMLElement>('li')].map((li) => [li.dataset.id!, li.querySelector('b')!.textContent]));
    el.innerHTML = `<p>Pièces d'or</p><ul>${html}</ul>`;
    el.dataset.k = html;
    for (const li of el.querySelectorAll<HTMLElement>('li')) {
      const was = before.get(li.dataset.id!);
      if (was !== undefined && was !== li.querySelector('b')!.textContent) li.classList.add('bump');
    }
  }
}
function coinActor(id: string) { return id === net.myId ? me : remotes.get(id); }

/* ================= Grand podium de fin de soirée ================= */
let finaleShow: FinaleShow;
const finaleHooks: FinaleHooks = {
  where: (id) => coinActor(id)?.root.position ?? null,
  place: (id, x, y, z, mood) => {
    if (id === net.myId) {
      me.placeAt(x, z, 0, y);
      me.frozen = true;
      if (mood === 'last') me.playPose('Sit_Floor_Down', { hold: true }); // dernier : il s'assoit, dépité
      else me.playPose('Cheer', { once: mood !== 'win' });
      return;
    }
    // les autres humains se placent eux-mêmes ; les bots n'envoient pas de position
    const r = remotes.get(id);
    if (!r || !room?.players.find((p) => p.id === id)?.bot) return;
    r.teleport({ p: [x, y, z], r: 0, a: mood === 'win' ? 'Cheer' : mood === 'last' ? 'Sit_Floor_Idle' : 'Idle' });
    if (mood === 'ok') r.react('Cheer');
  },
  sound: (kind) => {
    if (kind === 'land') playSfx('coup', { volume: 1.3 });
    else if (kind === 'winner') playSfx('finale', { duck: 3 });
    else playSfx('annonce', { duck: 1 });
  },
  done: () => {
    me.frozen = false; me.clearPose();
    if (mode === 'tavern' && camMode === 'custom') { camMode = 'follow'; look.yaw = 0; }
  },
};

function renderBanner() {
  const b = $('banner');
  if (!room || mode !== 'tavern') { b.hidden = true; return; }
  const seated = room.players.filter((p) => p.seat >= 0).length;
  if (isCeremony(room.phase)) { b.hidden = true; return; }
  if (room.phase === 'countdown' && room.phaseEndsAt) {
    const left = Math.max(0, Math.ceil((room.phaseEndsAt - net.serverNow()) / 1000));
    b.hidden = false; b.innerHTML = `Tout le monde est prêt !<small>La taverne se tait… ${left}</small>`;
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
  if (room && isCeremony(room.phase)) return null;
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

/* ================= Soirée de quêtes ================= */
const BARMAN_STAGE = new THREE.Vector3(0, 0, -5.85);
/** Réaction du tavernier à chaque nouvelle phase. */
const BARMAN_MOOD: Partial<Record<Phase, string>> = {
  intro: 'Cheer', roundsVote: 'Interact', roundsReveal: 'Cheer', questVote: 'Interact', questReveal: 'Cheer', quest: 'Taunt', finale: 'Cheer',
  debrief: 'Cheer', scoreReveal: 'Cheer', imposterVote: 'Interact', imposterReveal: 'Taunt',
};
const questDialog = initQuestDialog({
  myId: () => net.myId,
  serverNow: () => net.serverNow(),
  vote: (id) => net.vote(id),
  onPhase: (phase) => {
    const anim = BARMAN_MOOD[phase];
    const barman = tavern.npcs.barman;
    if (anim) barman.busyTime = playAnimation(barman, anim, { once: true, fade: 0.2, restart: true }) * 0.95;
  },
});
$('plist').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bot]');
  if (b) net.removeBot(b.dataset.bot!);
});
$('addBot').onclick = () => net.addBot();

/* ================= Mini-jeux et rôle secret ================= */
const roleCard = initRoleCard();
const minigames = initMinigames({
  me: () => me,
  remotes,
  net,
  tavern: () => tavern,
  imposter: () => imposter,
  onExit: () => {
    // retour au comptoir : bots rassis, caméra face au tavernier sans travelling
    botSeats.clear();
    for (const info of room?.players ?? []) { const r = remotes.get(info.id); if (r && info.bot) placeBot(r, info); }
    camMode = room && isCeremony(room.phase) ? 'barman' : 'follow';
    updateCamera(camMode, simTime, 10, { position: me.root.position, yaw: me.yaw });
  },
});

/** Pendant la soirée, le tavernier vient au centre du comptoir ; après, il retourne à sa place. */
const barmanTmp = new THREE.Vector3();
function updateBarman(dt: number) {
  const barman = tavern.npcs.barman;
  // il rejoint le centre dès le compte à rebours, pour être en place quand il prend la parole
  const ceremony = !!room && (isCeremony(room.phase) || room.phase === 'countdown');
  // pendant le vote de l'imposteur, il s'écarte : la caméra regarde les joueurs depuis sa place
  const aside = !!room && FACING.includes(room.phase);
  const goal = ceremony && !aside ? BARMAN_STAGE : barman.home;
  const P = barman.root.position;
  barmanTmp.subVectors(goal, P);
  const dist = barmanTmp.length();
  if (dist > 0.05) {
    const step = Math.min(dist, dt * 3.2);
    P.addScaledVector(barmanTmp.normalize(), step);
    barman.root.rotation.y = Math.atan2(barmanTmp.x, barmanTmp.z);
    if (barman.busyTime <= 0) playAnimation(barman, 'Walking_A', { fade: 0.2 });
    return;
  }
  if (barman.currentName === 'Walking_A') playAnimation(barman, 'Idle', { fade: 0.3 });
  if (ceremony) barman.root.rotation.y = 0; // face aux joueurs
  else if (barman.busyTime <= 0 && mode === 'tavern') {
    barman.root.rotation.y = Math.atan2(me.root.position.x - P.x, Math.max(0.5, me.root.position.z - P.z)) * 0.6;
  }
}

/* ================= Boucle ================= */
const tmp = new THREE.Vector3();
function placeBubble(npc: Npc) {
  const el = $('bub-' + npc.id);
  // pendant la soirée, le tavernier parle dans la grande bulle de quête
  if (npc.talkTime <= 0 || mode !== 'tavern' || (room && isCeremony(room.phase))) { el.hidden = true; return; }
  tmp.copy(npc.root.position); tmp.y += 3.2 * (npc.model?.size ?? 1); tmp.project(camera);
  if (tmp.z > 1) { el.hidden = true; return; }
  el.hidden = false;
  el.style.left = `${((tmp.x + 1) / 2) * innerWidth}px`;
  el.style.top = `${((1 - tmp.y) / 2) * innerHeight}px`;
}

let simTime = 0, sendTimer = 0;
/** Pendant un mini-jeu, les positions partent plus souvent : les contacts sont jugés par le serveur. */
const ARENA_MOVE_RATE_HZ = 20;
function update(dt: number) {
  simTime += dt;
  const t = simTime;
  // dans la taverne, à pied : la caméra se dirige à la souris (curseur caché)
  setMouseLook(mode === 'tavern' && (minigames.active
    ? minigames.mouseLook // mini-jeu en 3e personne (Festin du Roi)
    : camMode === 'follow' && !atelier.isOpen && !(room && isCeremony(room.phase))));
  audio.update(room, net.serverNow());
  document.body.classList.toggle('atelier-open', atelier.isOpen);
  const inArena = mode === 'tavern' && minigames.active;
  if (inArena) {
    // mini-jeu : il gère le joueur local, l'arène et sa caméra
    minigames.update(t, dt);
    $('prompt').hidden = true; $('standBtn').hidden = true;
    sendTimer -= dt;
    if (sendTimer <= 0) { sendTimer = 1 / ARENA_MOVE_RATE_HZ; net.sendMove(me.transform()); }
  } else if (mode === 'tavern') {
    me.update(t, dt, tavern, [...remotes.values()].map((r) => r.root.position));
    const target = findTarget();
    if ((actions.act || actions.confirm) && target) act(target);
    const prompt = $('prompt');
    if (target && !atelier.isOpen && target.kind !== 'stand') { prompt.hidden = false; prompt.querySelector('span')!.textContent = target.label; }
    else prompt.hidden = true;
    $('standBtn').hidden = !(me.seat >= 0 && me.sitPhase === 'idle') || (!!room && isCeremony(room.phase));
    sendTimer -= dt;
    if (sendTimer <= 0) { sendTimer = 1 / MOVE_RATE_HZ; net.sendMove(me.transform()); }
  } else {
    me.update(t, dt, tavern, []);
  }
  consumeActions();
  for (const r of remotes.values()) r.update(t, dt);
  if (inArena) {
    questDialog.frame(); // se masque pendant les mini-jeux
    for (const id of ['banner', 'bub-barman', 'bub-tailor', 'lobbyCard', 'coinBoard']) $(id).hidden = true;
    me.tag.sprite.visible = !minigames.hideOwnTag; // (caméra tout près du dos : sa propre étiquette boucherait la vue)
    for (const r of remotes.values()) r.tag.sprite.visible = true;
    return;
  }
  const occupied = new Set(room?.players.filter((p) => p.seat >= 0).map((p) => p.seat) ?? []);
  tavern.mugs.forEach((m, i) => { m.visible = occupied.has(i); });
  tavern.update(t, dt);
  for (const npc of Object.values(tavern.npcs)) placeBubble(npc);
  renderBanner();
  updateBarman(dt);
  questDialog.frame();
  coinShow.update(room && isCeremony(room.phase) && !isMinigamePhase(room.phase) ? room : null, net.serverNow(), dt,
    (id) => coinActor(id)?.root.position ?? null,
    (id, happy) => coinActor(id)?.react(happy ? 'Cheer' : 'Hit_B'),
    () => playSfx('prendre', { volume: 0.7 }));
  renderCoinBoard();
  finaleShow.update(mode === 'tavern' ? room : null, net.serverNow(), dt, finaleHooks);
  suspects.update(room && mode === 'tavern' && !minigames.active ? room : null, net.myId, (id) => coinActor(id)?.root.position ?? null, t);
  // pendant la soirée, les étiquettes de nom s'effacent (les cartes montrent qui vote quoi),
  // sauf quand on cherche l'imposteur : il faut savoir qui est qui
  const facing = !!room && FACING.includes(room.phase);
  // (grand podium : la bulle passe en bas aussi, le tavernier est caché derrière les marches)
  const lowBubble = facing || room?.phase === 'finale';
  document.body.classList.toggle('facing', lowBubble && mode === 'tavern' && !minigames.active);
  const showTags = !(room && isCeremony(room.phase)) || facing;
  $('lobbyCard').hidden = !(room && !isCeremony(room.phase));
  // vus de près (face aux joueurs), les noms rapetissent
  for (const tag of [me.tag, ...[...remotes.values()].map((r) => r.tag)]) {
    tag.sprite.visible = showTags;
    tag.sprite.scale.set(facing ? 0.75 : 1.3, facing ? 0.19 : 0.325, 1);
  }
  if (room && isCeremony(room.phase)) {
    tmp.copy(tavern.npcs.barman.root.position); tmp.y += 3.4; tmp.project(camera);
    // tavernier hors champ (caméra tournée vers les joueurs) : bulle en haut de l'écran
    // face aux joueurs : la bulle descend en bas de l'écran, au-dessus des têtes on voit les pièces et les votes
    if (lowBubble) questDialog.anchor(innerWidth / 2, innerHeight - 40);
    else if (tmp.z > 1 || Math.abs(tmp.x) > 1.1) questDialog.anchor(innerWidth / 2, 0);
    else questDialog.anchor(((tmp.x + 1) / 2) * innerWidth, ((1 - tmp.y) / 2) * innerHeight);
  }
  updateCamera(camMode, t, dt, { position: me.root.position, yaw: me.yaw });
}

const clock = new THREE.Clock();
function loop() {
  update(Math.min(clock.getDelta(), 1 / 30));
  if (roleCard.covering) { /* écran noir du rôle : la scène est cachée */ }
  else if (mode === 'tavern' && minigames.active) minigames.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* ================= Démarrage ================= */
async function boot() {
  await loadCharacterLibrary();
  computeAnchors();
  tavern = await buildTavern();
  coinShow = new CoinShow(scene);
  finaleShow = new FinaleShow(scene, tavern);
  suspects = new SuspectPicker(scene, camera, canvas, (id) => { if (room?.phase === 'imposterVote' && id !== net.myId) net.vote(id); });
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
  Object.assign(window, { __oddone: { me, tavern, net, remotes, look, room: () => room, imposter: () => imposter, minigames, openAtelier, roleCard, finale: finaleShow,
    project: (x: number, y: number, z: number) => { const v = new THREE.Vector3(x, y, z).project(camera); return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight]; },
    fastForward: (s: number) => { for (let i = 0; i < s * 30; i++) update(1 / 30); } } });
}

boot().catch((err) => {
  console.error(err);
  $('loading').innerHTML = `Le chargement a échoué.<small>${escapeHtml(String(err?.message ?? err))}</small>`;
});
