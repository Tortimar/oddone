import type { Phase, RoomState } from '@oddone/shared';
import { playMusic, playSfx, type MusicId } from './audio.ts';

/**
 * Chef d'orchestre : choisit la musique et déclenche les jingles d'après l'état de la taverne.
 * Il ne fait que lire `RoomState` (et l'heure du serveur pour les décomptes) : aucun module du jeu
 * n'a besoin de connaître l'audio, sauf pour les quelques bruitages propres au joueur local.
 */

/** Musique du mini-jeu, par id de quête. */
const GAME_MUSIC: Record<string, MusicId> = {
  'festin-roi': 'festin',
  'bal-squelettes': 'squelettes',
  'pont-branlant': 'pont',
  'tonneaux-fous': 'tonneaux',
  'horde-gobelins': 'horde',
  'coffres-pieges': 'coffres',
  'wagonnets-mine': 'tonneaux', // (« Tha'el Mines » : c'est une mine aussi)
  'bombe-labyrinthe': 'coffres', // (un donjon aussi)
  'regard-gorgone': 'squelettes', // (un cimetière aussi)
  'course-moutons': 'pont', // (une course aussi)
  'festival-bombes': 'horde', // (ça s'emballe)
};

function musicFor(mode: 'menu' | 'tavern', s: RoomState | null): MusicId | null {
  if (mode === 'menu' || !s) return 'taverne';
  switch (s.phase) {
    case 'lobby': case 'countdown': return 'taverne';
    case 'rules': return 'regles';
    // écran noir du rôle : silence, la musique de révélation joue seule
    case 'roleReveal': return null;
    // silence pendant « 3, 2, 1 » : la musique du jeu part avec « Partez ! »
    case 'mgCountdown': return null;
    case 'mgPlay': return GAME_MUSIC[s.mg?.id ?? ''] ?? 'regles';
    case 'mgResults': case 'finale': return 'podium';
    case 'debrief': case 'scoreReveal': case 'imposterVote': return 'vote';
    case 'imposterReveal': return 'revelation';
    default: return 'soiree'; // intro, votes du nombre de quêtes et de la quête, quête sans mini-jeu
  }
}

/** Phases où l'on entend le tic-tac des dernières secondes. */
const TICKING: Partial<Record<Phase, number>> = { countdown: 3, mgCountdown: 3 };

export class AudioDirector {
  private phase: Phase | null = null;
  private lastTick = -1;
  private myVoted = false;
  private myReady = false;
  private myCarry = 0;
  private myDelivered = 0;
  private marketRound = 0;
  private caught = false;
  private crushedAt: number | null = null;
  private hordePoints = 0;
  private chestKey = '';

  /** À chaque nouvel état reçu du serveur. */
  onState(mode: 'menu' | 'tavern', s: RoomState | null, myId: string): void {
    playMusic(musicFor(mode, s));
    if (!s) { this.phase = null; return; }
    const prev = this.phase;
    this.phase = s.phase;
    if (s.phase !== prev) this.onPhase(s, prev);

    // mon vote est enregistré (nombre de quêtes, quête, imposteur)
    const voted = !!s.game.votes[myId];
    if (voted && !this.myVoted) playSfx('valider');
    this.myVoted = voted;

    const mg = s.mg;
    const ready = !!mg && s.phase === 'rules' && mg.ready.includes(myId);
    if (ready && !this.myReady) playSfx('valider');
    this.myReady = ready;

    // Horde de Gobelins : j'ai tué un gobelin (doré : un petit jingle)
    const pts = s.phase === 'mgPlay' ? mg?.horde?.points[myId] ?? 0 : 0;
    if (pts > this.hordePoints) playSfx(pts - this.hordePoints >= 3 ? 'annonce' : 'coup', { volume: 1.2 });
    this.hordePoints = pts;

    // Coffres Piégés : à moi de jouer ; un coffre s'ouvre (trésor ou mimique)
    const c = s.phase === 'mgPlay' ? mg?.chests : null;
    const key = c ? `${c.round}|${c.stage}|${c.turn}|${c.opened.length}` : '';
    if (c && key !== this.chestKey) {
      if (c.stage === 'turn' && c.turn === myId) playSfx('annonce');
      else if (c.stage === 'out') playSfx('erreur', { volume: 1.3 });
      else if (c.stage === 'turn' && c.opened.length && this.chestKey.includes('|opening|')) playSfx('prendre', { volume: 1.2 });
    }
    this.chestKey = key;

    // Tonneaux Fous : je viens d'être écrasé
    const crushed = s.phase === 'mgPlay' ? mg?.ramp?.[myId]?.crushedAt ?? null : null;
    if (crushed !== null && crushed !== this.crushedAt) playSfx('coup', { volume: 1.4 });
    this.crushedAt = crushed;

    // Bal des Squelettes : je viens d'être attrapé
    const caught = !!mg && s.phase === 'mgPlay' && myId in mg.caught;
    if (caught && !this.caught) playSfx('erreur', { volume: 1.2 });
    this.caught = caught;

    // Festin du Roi : nouvelle recette, ingrédient pris, plat versé
    const market = s.phase === 'mgPlay' ? mg?.market : null;
    if (market) {
      const newRound = market.round !== this.marketRound;
      // (la première recette arrive avec « Partez ! » : pas de deuxième jingle par-dessus)
      if (newRound && market.round > 1 && market.stage === 'show') playSfx('annonce', { duck: 1.5 });
      this.marketRound = market.round;
      const carry = market.carry[myId]?.length ?? 0;
      const delivered = market.delivered.includes(myId) ? 1 : 0;
      if (!newRound) {
        if (delivered > this.myDelivered) playSfx('verser', { duck: 0.8 });
        else if (carry > this.myCarry) playSfx('prendre');
        else if (carry < this.myCarry && !delivered) playSfx('erreur'); // mauvaise recette : panier vidé
      }
      this.myCarry = carry; this.myDelivered = delivered;
    } else { this.myCarry = 0; this.myDelivered = 0; this.marketRound = 0; }
  }

  private onPhase(s: RoomState, prev: Phase | null): void {
    this.lastTick = -1;
    switch (s.phase) {
      case 'roundsReveal': case 'questReveal': playSfx('annonce', { duck: 2 }); break;
      case 'mgPlay': if (prev === 'mgCountdown') playSfx('go', { duck: 1 }); break;
      case 'mgResults': playSfx('fin', { duck: 2.5 }); break;
      case 'imposterReveal': playSfx(s.game.reveal?.found ? 'trouve' : 'rate', { duck: 3 }); break;
      // (la fanfare attend le vainqueur : elle part du grand podium, voir main.ts)
      case 'finale': playSfx('annonce', { duck: 2 }); break;
    }
  }

  /** Carte du rôle secret (reçue à part, à moi seul). */
  onRole(imposter: boolean): void {
    playSfx(imposter ? 'revealImposteur' : 'revealHeros', { duck: 5 });
  }

  /** À chaque image : tic-tac des décomptes. */
  update(s: RoomState | null, serverNow: number): void {
    const from = s ? TICKING[s.phase] : undefined;
    if (!s || from === undefined || !s.phaseEndsAt) return;
    const left = Math.ceil((s.phaseEndsAt - serverNow) / 1000);
    if (left !== this.lastTick && left >= 1 && left <= from) playSfx('tick', { volume: left === 1 ? 1.3 : 1 });
    this.lastTick = left;
  }
}
