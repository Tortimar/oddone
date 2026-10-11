# OddOne

*Un héros de trop.*

Party game multijoueur dans le navigateur : jusqu'à 4 aventuriers façon RPG enchaînent des mini-jeux, et à chaque manche il faut démasquer l'imposteur.

Cette première version contient le **lobby** :

- écran d'accueil : ouvrir une taverne (code de 4 lettres) ou en rejoindre une ;
- la taverne en 3e personne (Three.js), avec cheminée, comptoir, PNJ ;
- **Mirabelle, la couturière** : personnalisation complète du personnage (tenue, tête, couleurs, accessoires, objets en main), synchronisée avec les autres joueurs ;
- **le comptoir** : s'asseoir sur un tabouret = être prêt ; la caméra passe sur la vue du tavernier, face aux 4 tabourets ;
- quand tout le monde est assis : compte à rebours, puis une manche factice (les mini-jeux restent à brancher).

## Démarrer

Prérequis : Node.js 20 ou plus.

```bash
npm install
npm run dev
```

Puis ouvre http://localhost:5173. Pour tester à plusieurs en local, ouvre un deuxième onglet et entre le code affiché.

| Commande | Rôle |
| --- | --- |
| `npm run dev` | serveur (port 3001, rechargement auto) + client Vite (port 5173) |
| `npm run build` | vérifie les types et compile le client dans `client/dist` |
| `npm start` | lance le serveur, qui sert aussi `client/dist` (production) |
| `npm run typecheck` | vérifie les types des trois paquets |
| `npm test` | tests de la logique du lobby (serveur) |

## Mettre en ligne

Un seul processus Node suffit : `npm install && npm run build && npm start`. Le port vient de la variable `PORT`. Ça tourne tel quel sur Render, Railway, Fly.io ou un VPS. Les WebSockets doivent être autorisés par l'hébergeur.

## Structure

```
shared/   types et règles communs (catalogue de personnalisation, protocole réseau)
server/   Express + Socket.io : tavernes, codes, tabourets, compte à rebours
client/   Vite + TypeScript + Three.js : rendu, personnages, taverne, interface
tools/    pipeline d'assets (téléchargement et allègement des packs KayKit)
```

Les détails d'architecture sont dans [CLAUDE.md](CLAUDE.md).

## Crédits

Personnages, décor et animations : packs **KayKit** de Kay Lousberg (Adventurers, Dungeon Remastered, Furniture Bits), licence **CC0**. Créditer n'est pas obligatoire, mais c'est apprécié : www.kaylousberg.com
