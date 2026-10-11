# OddOne — notes pour Claude Code

Party game web multijoueur (4 joueurs max) : héros RPG, mini-jeux, un imposteur à démasquer par manche. Langue du jeu et des commentaires : **français**.

## Commandes

- `npm run dev` : serveur (:3001, `tsx watch`) + client Vite (:5173, proxy `/socket.io` → :3001)
- `npm run typecheck` : `tsc --noEmit` sur shared, server, client (à lancer après chaque modification)
- `npm test` : tests `node:test` de `server/test/*.test.ts`
- `npm run build` puis `npm start` : production (le serveur sert `client/dist`)

## Architecture

npm workspaces, TypeScript strict partout, modules ES. Les imports internes gardent l'extension `.ts`.

### `shared/` (`@oddone/shared`)
- `catalog.ts` : toutes les options de personnalisation, `CharacterConfig`, `sanitizeConfig` et `sanitizeName`. **Toute nouvelle option passe d'abord par ici** : le serveur rejette les valeurs inconnues.
- `protocol.ts` : constantes du lobby (`MAX_PLAYERS`, `SEAT_COUNT`, `COUNTDOWN_MS`…), types des événements Socket.io (`ClientToServerEvents` / `ServerToClientEvents`), `RoomState`.

### `server/`
- `rooms.ts` : `RoomManager`, logique pure et testable. Gère création et jonction par code, places J1 à J4, tabourets (être assis = être prêt), compte à rebours, manche.
- `index.ts` : branche Socket.io sur `RoomManager`. Il diffuse `room:state` après chaque changement et relaie `player:move` en *volatile* (positions non autoritatives, simplement validées).
- Le serveur fait autorité sur le lobby, pas sur les déplacements.

### `client/src/`
- `engine/render.ts` : renderer, scène, caméra, matériaux toon (`toon`, `part`, contour `OUTLINE`), `canvasTexture`.
- `characters/library.ts` : charge les 5 `.glb` KayKit. Toutes les classes partagent **le même squelette**, ce qui permet de mélanger les pièces. Contient aussi `kitMaterials()` (recoloration des atlas de dégradés : teinte de tenue et peau) et `ANCHORS` (mesures des têtes et du torse pour placer les accessoires).
- `characters/character.ts` : `composeCharacter(cfg)` (clone du squelette, pièces skinnées re-liées par nom d'os, objets sur `handslot.*`, accessoires sur les os `head`/`chest`). Contient aussi `playAnimation` (fondus) et `measureSitPose`.
- `characters/accessories.ts` : accessoires modélisés en code, positionnés en pose de repos puis rattachés à un os.
- `world/tavern.ts` : construit la taverne (props KayKit + comptoir et cheminée en code), collisions (boîtes et cercles), tabourets, PNJ, lumières. La hauteur des tabourets est calculée d'après l'animation `Sit_Chair_Idle`.
- `game/players.ts` : `LocalPlayer` (contrôles relatifs à la caméra, saut, assise) et `RemotePlayer` (interpolation, animation reçue).
- `game/cameraRig.ts` : caméras `menu`, `follow`, `bar` (vue du tavernier) et `tailor` ; masque le mur entre la caméra et la salle.
- `net/network.ts` : client Socket.io typé.
- `ui/` : atelier de personnalisation, utilitaires DOM. Le balisage est dans `client/index.html`, les styles dans `client/src/styles.css` (jetons de couleur dans `:root`).
- `main.ts` : orchestration (accueil, entrée/sortie de taverne, interactions PNJ et tabourets, boucle de jeu).
- `window.__oddone.fastForward(secondes)` avance la simulation sans rendu (tests automatisés).

### Assets
- `client/public/assets/characters/*.glb` et `props/tavern-props.glb` sont générés par `tools/prepare-assets.mjs` (`cd tools && npm install && npm run assets`). Le script clone les dépôts KayKit (CC0), garde la liste `KEEP_ANIMATIONS` et fusionne les props.
- Pour ajouter une animation ou un prop : l'ajouter à la liste du script et relancer. Les noms de props sont les noms de fichiers KayKit.
- Unités : celles de KayKit (un mur = 4 × 4, un personnage ≈ 2,5 de haut). Le modèle regarde vers +z.

## Conventions

- Ne jamais faire confiance aux données client côté serveur (noms, tenues, positions sont nettoyés).
- Couleurs : `THREE.ColorManagement` actif. On passe des hex sRGB directement, et les `CanvasTexture` ont `colorSpace = SRGBColorSpace`.
- Three.js 0.169 : lumières physiques. Les intensités des `PointLight` sont donc élevées (3 à 9).
- Interface en français, texte des boutons = l'action (« S'asseoir au comptoir »).

## Prochaines étapes (TODO)

1. **Mini-jeux** : remplacer la manche factice (`PLACEHOLDER_ROUND_MS` dans `rooms.ts` → `start`/`endRound`) par une boucle de manche. Le serveur choisit l'imposteur et le mini-jeu, les clients changent de scène. Une piste : une interface `MiniGame` côté client (`enter`, `update`, `exit`) et côté serveur (règles, score).
2. **Imposteur** : rôle secret envoyé uniquement à l'intéressé (`socket.emit` ciblé, jamais dans `room:state`), phase de vote au comptoir après chaque mini-jeu.
3. Combat poing/pied (déjà prototypé dans une démo précédente : animations `Unarmed_Melee_Attack_*`, `Hit_*`, `Death_A`, `Lie_StandUp` déjà présentes dans les assets).
4. Reconnexion (garder la place d'un joueur quelques secondes après une déconnexion).
5. Découper le bundle (le chunk Three.js fait environ 670 ko) avec `manualChunks` si besoin.
