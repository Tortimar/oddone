import type * as THREE from 'three';
import type { MinigameSecret, Hit, MinigameState, MinigameTick, Phase, RoomState } from '@oddone/shared';
import type { CameraMode } from '../game/cameraRig.ts';
import type { LocalPlayer, RemotePlayer } from '../game/players.ts';
import type { Network } from '../net/network.ts';
import type { World } from '../world/tavern.ts';
import type { Particles, PodiumView } from './effects.ts';

/**
 * Ce que chaque mini-jeu fournit au contrôleur (minigame.ts). Le contrôleur s'occupe de tout ce
 * qui est commun : écran des règles, entrée et sortie de l'arène, compte à rebours, podium,
 * coups, HUD ; le mini-jeu, de sa scène et de ses règles propres.
 */

/** Tout ce qu'un mini-jeu peut consulter à chaque image. */
export interface Frame {
  phase: Phase;
  state: RoomState;
  mg: MinigameState;
  me: LocalPlayer;
  myId: string;
  remotes: Map<string, RemotePlayer>;
  /** Heure du serveur (ms). */
  now: number;
  /** ms depuis le début de mgPlay (0 avant). */
  playMs: number;
  /** Temps local écoulé (s), pour les minuteries purement visuelles. */
  simTime: number;
  imposter: boolean;
  /** Pour envoyer une action au serveur (prendre, livrer…). */
  net: Network;
  /** Texte qui jaillit au-dessus d'un joueur (« +1 », « 1er »…), dans le style commun. */
  float(id: string, text: string, color: string): void;
}

export interface HudInfo {
  /** Deux encadrés en haut au centre. */
  boxes: { label: string; value: string; cls?: string }[];
  /** Statut de chaque joueur dans la liste en haut à gauche. */
  chip(id: string): { text: string; cls?: string };
  /** Message en bas de l'écran. */
  status: { text: string; cls?: string } | null;
  /** Panneau propre au mini-jeu (HTML), en bas à droite. */
  extra?: string;
  /** Halo vert sur les bords de l'écran (maudit…). */
  vignette?: boolean;
}

export interface GameView {
  readonly scene: THREE.Scene;
  readonly world: World;
  readonly particles: Particles;
  readonly podium: PodiumView;
  readonly cameras: { training: CameraMode; play: CameraMode };
  /** Pendant la partie, E pousse les autres joueurs (sinon E ne fait rien). */
  readonly pushCooldownMs?: number;
  /** Portée de la poussée (sinon celle du Pont Branlant). */
  readonly pushReach?: number;
  /** Les autres joueurs bloquent le passage (collisions entre joueurs). */
  readonly solidPlayers?: boolean;
  /**
   * Caméra à la 3e personne dirigée à la souris, comme dans la taverne (caméras `thirdPerson`) :
   * on se déplace par rapport à la caméra. Sinon, les caméras sont fixes et « haut » = le fond.
   */
  readonly thirdPerson?: boolean;
  /** Rayon autour du centre que la caméra ne dépasse pas (devant les façades). */
  readonly cameraRadius?: number;
  /** Hauteur que la caméra ne dépasse pas (salle à plafond). */
  readonly cameraCeiling?: number;
  /** Objet mis dans la main droite de tous les joueurs pendant le mini-jeu (« classe:Mesh »). */
  readonly weapon?: string;
  /** Cacher l'étiquette de nom du joueur local (caméra tout près de son dos). */
  readonly hideOwnTag?: boolean;
  /** Caméra fixe : sens des commandes (0 : « haut » = vers le fond ; π : « haut » = vers la caméra). */
  readonly controlYaw?: number;
  /** Orientation de départ d'un joueur placé en (x, z) (sinon : face à la caméra). */
  startYaw?(x: number, z: number): number;

  startTraining(f: Frame): void;
  stopTraining(): void;
  onPhase(f: Frame): void;
  /** Avant le déplacement du joueur local : vitesse, commandes, gel… */
  beforeMove(f: Frame, dt: number): void;
  /** Après : chutes, contacts d'entraînement. Renvoie un texte à flasher sur l'entraînement. */
  afterMove(f: Frame, dt: number): string | null;
  /** Positions envoyées par le serveur pendant la partie (bots, ennemis). */
  applyTick(tick: MinigameTick, f: Frame): void;
  /**
   * Touche E (et R) pendant la partie ou l'entraînement : le mini-jeu peut s'en servir (prendre,
   * livrer…). Renvoie true s'il l'a utilisée (sinon E pousse, si le jeu le permet).
   */
  onAct?(f: Frame, special: boolean): boolean;
  /** Un coup reçu ou porté (en partie ou sur le podium). */
  onHit?(h: Hit, f: Frame): void;
  /** Information secrète reçue du serveur (pour moi seul). */
  onSecret?(s: MinigameSecret, f: Frame): void;
  update(t: number, dt: number, f: Frame): void;
  hud(f: Frame): HudInfo;
  /** Retour à la taverne : enlever ce qu'on a accroché aux personnages, rétablir le joueur. */
  exit(): void;
}
