/**
 * Textes des écrans de règles, par id de quête (voir shared/src/quests.ts).
 * Le texte entre ** ** est mis en valeur.
 */

export interface Control {
  /** Touches affichées (une pastille par touche). */
  keys: string[];
  label: string;
}

export interface MinigameRules {
  title: string;
  /** Une phrase d'accroche sous le titre. */
  tagline: string;
  rules: string[];
  controls: Control[];
  /**
   * Avantage de l'imposteur. `text` est affiché à tout le monde sur l'écran des règles
   * (on peut le repérer !) ; `secret` est ce que lit l'imposteur sur sa carte de rôle.
   */
  imposter: { name: string; text: string; secret: string };
  /** Indice glissé par le tavernier pendant le débrief. */
  debriefHint: string;
  /** Barème affiché sous les règles. */
  points: string;
}

export const RULES: Record<string, MinigameRules> = {
  'festival-bombes': {
    title: 'Le Festival des Bombes',
    tagline: 'Trier vite, trier bien… ou tout faire sauter.',
    rules: [
      "La machine envoie des **bombes de toutes les couleurs** sur ton plateau, **de plus en plus vite**. Range chacune dans la **boîte de sa couleur** !",
      "Une bombe pas rangée **3 secondes** après son arrivée **explose** (l'anneau sous elle se vide, puis elle clignote) : ton plateau saute, tu as perdu.",
      "Une boîte **pleine (5 bombes)** les envoie **au joueur de cette couleur** ! Ta propre couleur, elle, part un peu chez tout le monde.",
      "Le **dernier debout** gagne : 4 pièces d'or, puis 3, 2, 1 dans l'ordre inverse des explosions.",
    ],
    controls: [
      { keys: ['Clic'], label: 'Attraper une bombe (garder le bouton enfoncé)' },
      { keys: ['Souris'], label: 'La glisser jusqu’à la boîte de sa couleur, puis lâcher' },
    ],
    imposter: {
      name: 'Bombes caméléons',
      text: "Les bombes **de sa couleur** vont dans **n'importe quelle boîte** (elles en prennent la couleur). Celui qui range tout à la va-vite sans jamais se tromper est suspect !",
      secret: "Les bombes de ta couleur entrent dans n'importe quelle boîte et en prennent la couleur : range-les au plus près, et remplis les boîtes des autres pour leur en envoyer !",
    },
    debriefHint: "Bizarre… certaines bombes changeaient de couleur en tombant dans les boîtes. Quelqu'un trichait-il ?",
    points: 'Dernier debout : 4 pièces d’or, puis 3 · 2 · 1 dans l’ordre inverse des explosions',
  },
  'course-moutons': {
    title: 'La Course des Moutons',
    tagline: 'Un chemin, un troupeau, et pas question de bousculer les bêtes.',
    rules: [
      "Une **course tout droit** sur le chemin du village… mais un **troupeau de moutons** se promène en plein milieu !",
      "Les moutons vont **où ils veulent** : ils marchent, s'arrêtent pour brouter, repartent. On **ne peut pas les pousser** : contourne-les !",
      "Les premiers à franchir la **banderole d'arrivée** gagnent : 4 pièces d'or, puis 3, 2, 1.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Se déplacer (ou les flèches)' },
      { keys: ['S', '↓'], label: 'Courir vers l’arrivée (vers la caméra)' },
    ],
    imposter: {
      name: 'Odeur de loup',
      text: "Les moutons **s'écartent sur son passage**. Celui devant qui le troupeau s'ouvre comme par magie est suspect !",
      secret: "Les moutons s'écartent de toi : fonce, le troupeau s'ouvre devant toi… mais ne gagne pas toujours trop facilement !",
    },
    debriefHint: "Drôle de course… Le troupeau s'écartait devant l'un de vous comme s'il avait vu un loup.",
    points: 'Arrivée : 4 · 3 · 2 · 1 pièces d’or',
  },
  'regard-gorgone': {
    title: 'Le Regard de la Gorgone',
    tagline: 'Un, deux, trois… pierre !',
    rules: [
      "Au fond du cimetière, la **Gorgone** vous tourne le dos. Avancez vers elle et franchissez la **ligne d'arrivée** à ses pieds !",
      "Elle se **retourne** sans prévenir (après 1 à 5 secondes). Si tu **bouges** pendant qu'elle regarde, tu es **pétrifié** !",
      "**Collé** juste derrière une tombe, une statue ou un autre joueur, elle ne te voit pas : là, tu peux bouger (une tombe au loin ne cache rien). Et tu peux **pousser** les autres (E)… même quand elle regarde.",
      "Les premiers arrivés gagnent. Le **premier pétrifié** finit dernier, le deuxième avant-dernier… Pièces d'or : 4, 3, 2, 1.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Avancer (ou les flèches)' },
      { keys: ['Souris'], label: 'Regarder autour' },
      { keys: ['E'], label: 'Pousser un joueur (recharge 2,5 s)' },
    ],
    imposter: {
      name: 'Sang de serpent',
      text: "Il **sent quand elle va se retourner**. Celui qui s'arrête toujours pile au bon moment est suspect !",
      secret: "Un compte à rebours te dit quand la Gorgone va se retourner. Arrête-toi juste avant… mais pas toujours parfaitement, sinon on te démasquera !",
    },
    debriefHint: "Vous avez remarqué ? Quelqu'un s'arrêtait toujours une seconde avant elle. Comme s'il savait…",
    points: 'Arrivée : 4 · 3 · 2 · 1 pièces d’or — premier pétrifié : dernier',
  },
  'bombe-labyrinthe': {
    title: 'La Bombe du Labyrinthe',
    tagline: 'Un labyrinthe, une bombe, et personne ne veut la garder.',
    rules: [
      "Vous voilà perdus dans un **labyrinthe** de donjon. L'un de vous commence avec une **bombe** au-dessus de la tête.",
      "**Touche un autre joueur** pour lui passer la bombe ! Celui qui la reçoit est **étourdi 1 seconde** : file pendant ce temps.",
      "La mèche a **sa propre durée**, secrète. Quand la bombe **clignote en rouge** et fait tic-tac, elle va sauter ! Celui qui la tient est **éliminé**.",
      "Une manche par éliminé, jusqu'à ce qu'il **ne reste qu'un survivant** (3 manches au plus). Le dernier debout gagne : 4 pièces d'or, puis 3, 2, 1.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Courir (ou les flèches)' },
      { keys: ['Souris'], label: 'Regarder autour' },
      { keys: ['Contact'], label: 'Passer la bombe (il suffit de toucher quelqu’un)' },
    ],
    imposter: {
      name: 'Vue à travers les murs',
      text: "Il voit **les autres joueurs à travers les murs**. Celui qui ne se fait jamais surprendre au détour d'un couloir est suspect !",
      secret: "Tu vois les silhouettes des autres joueurs (et la bombe) à travers les murs. Évite le porteur, piège les autres… mais fais-toi surprendre de temps en temps pour ne pas te trahir !",
    },
    debriefHint: "Curieux… quelqu'un savait toujours par où passait la bombe. Comme s'il voyait à travers les murs.",
    points: 'Dernier debout : 4 pièces d’or, puis 3 · 2 · 1 dans l’ordre inverse des explosions',
  },
  'festin-roi': {
    title: 'Le Festin du Roi',
    tagline: 'Le roi a faim, et il a des goûts… très précis.',
    rules: [
      "Au début de chaque manche, la **recette du roi** (3 ingrédients) apparaît au-dessus de la marmite… puis **disparaît**. Retiens-la bien !",
      "Trouve ces ingrédients sur les **échoppes** (ils changent de place à chaque manche) et verse-les dans la marmite. **1er servi : 5 points**, puis 3, 2, 1. Mauvaise recette : ton panier est vidé.",
      "**5 manches**. À la fin, le meilleur cuisinier gagne : 4 pièces d'or, puis 3, 2, 1.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Courir (ou les flèches)' },
      { keys: ['Souris'], label: 'Regarder autour (comme dans la taverne)' },
      { keys: ['E'], label: 'Prendre un ingrédient / verser dans la marmite' },
      { keys: ['R'], label: 'Transformer (imposteur seulement)' },
    ],
    imposter: {
      name: 'Tour de passe-passe',
      text: "Une fois par manche, il peut prendre **n'importe quel produit** et le changer en un ingrédient de la recette. Celui qui est servi sans avoir fait le tour des échoppes est suspect !",
      secret: "Touche R près d'une échoppe : tu prends n'importe quel produit et il devient un ingrédient de la recette qui te manque. Une fois par manche, et pense à te promener un peu pour ne pas te trahir !",
    },
    debriefHint: "Mais dites-moi… quelqu'un a trouvé ses ingrédients bien vite. Un peu trop vite, non ?",
    points: 'Par manche : 5 · 3 · 2 · 1 points — Pièces d’or : 4 · 3 · 2 · 1',
  },
  'horde-gobelins': {
    title: 'La Horde de Gobelins',
    tagline: "Une clairière, une épée, et des gobelins qui sortent de partout.",
    rules: [
      "Les **gobelins** sortent de la forêt et foncent sur vous. **Un coup d'épée** suffit : **1 point** par gobelin.",
      "Les **gobelins dorés** sont plus rares (et plus rapides) : **3 points** ! Attention, un gobelin au contact te frappe : **étourdi 1 seconde**.",
      "Tu peux aussi **frapper les autres joueurs** pour les étourdir et leur voler leurs gobelins.",
      "**60 secondes**. Le meilleur chasseur gagne : 4 pièces d'or, puis 3, 2, 1.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Courir (ou les flèches)' },
      { keys: ['Souris'], label: 'Regarder autour' },
      { keys: ['E', 'Clic'], label: "Coup d'épée" },
    ],
    imposter: {
      name: 'Appât doré',
      text: "Les **gobelins dorés** sortent surtout **du côté de la clairière où se trouve l'imposteur**. Celui qui en a toujours plein autour de lui est suspect !",
      secret: "Les gobelins dorés apparaissent surtout de ton côté de la clairière. Profites-en… sans trop rester au même endroit, ça se verrait !",
    },
    debriefHint: "Les dorés sortaient toujours du même côté du bois… comme s'ils suivaient quelqu'un. Qui donc était par là ?",
    points: '1 point par gobelin, 3 par doré — Pièces d’or : 4 · 3 · 2 · 1',
  },
  'coffres-pieges': {
    title: 'Les Coffres Piégés',
    tagline: 'Un donjon, des coffres… et une mimique qui a faim.',
    rules: [
      "Au milieu de la salle, **un coffre de plus que de joueurs**. Un seul est une **mimique** : celui qui l'ouvre est **éliminé**.",
      "**Chacun son tour**, on va ouvrir un coffre (les autres attendent dans leur coin). Après chaque morsure, nouvelle manche avec **un coffre de moins**.",
      "À ton tour, tu peux aussi **inspecter** un coffre avant d'en ouvrir un : penche-toi dessus, prends ton temps… fais durer le suspense !",
      "Le **dernier survivant** gagne. Trop lent (15 s) ? Le donjon ouvre un coffre pour toi.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Marcher (à ton tour)' },
      { keys: ['Souris'], label: 'Regarder autour' },
      { keys: ['E', 'Clic'], label: 'Ouvrir le coffre' },
      { keys: ['R'], label: 'Inspecter le coffre' },
    ],
    imposter: {
      name: 'Œil du voleur',
      text: "Tout le monde peut inspecter un coffre, mais **seul l'imposteur voit ce qu'il contient**, et **une seule fois** dans la partie. Méfiez-vous de celui qui inspecte puis change d'avis…",
      secret: "Ta première inspection est la vraie : tu verras si le coffre est la mimique. Les autres inspectent pour faire semblant… fais comme eux pour ne pas te trahir !",
    },
    debriefHint: "Quelqu'un s'est penché sur un coffre… puis en a ouvert un autre, l'air de rien. Il savait quelque chose ?",
    points: 'Pièces d’or : 4 · 3 · 2 · 1 selon l’ordre d’élimination',
  },
  'wagonnets-mine': {
    title: 'Les Wagonnets de la Mine',
    tagline: 'Quatre voies, un seul coup d’œil… et un wagon maudit.',
    rules: [
      "**3 manches.** À chaque manche, **quatre voies** partent du quai et serpentent jusqu'à la sortie : elles tournent, reviennent en arrière, se croisent… et n'ont **pas la même longueur**.",
      "La caméra les survole **une seule fois** (5 secondes) : **mémorise** laquelle est la plus courte !",
      "Puis chacun **saute dans un wagon libre** (premier arrivé, premier servi). Tous roulent à la même vitesse : le plus court chemin gagne.",
      "Arrivée : **4 · 3 · 2 · 1 points de manche**. Le total des trois manches fait le classement.",
    ],
    controls: [
      { keys: ['1', '2', '3', '4'], label: 'Choisir un wagon' },
      { keys: ['Clic'], label: 'Choisir un wagon (sur le wagon ou son numéro)' },
    ],
    imposter: {
      name: 'Malédiction du mineur',
      text: "Avant le choix des wagons, **l'imposteur maudit un wagon en secret** : il roulera **beaucoup moins vite**. On ne découvre lequel qu'au départ… Qui a soigneusement évité ce wagon-là ?",
      secret: "Après le survol, choisis le wagon à maudire (clic ou 1 à 4) : il roulera bien moins vite. Maudis celui que les autres vont vouloir… et ne monte pas dedans !",
    },
    debriefHint: "Le wagon maudit était souvent le plus tentant… Quelqu'un l'a laissé filer alors qu'il était juste devant lui ?",
    points: 'Pièces d’or : 4 · 3 · 2 · 1 selon le total des points de manche',
  },
  'tonneaux-fous': {
    title: 'Les Tonneaux Fous',
    tagline: 'Un squelette, une montagne de tonneaux, et une seule rampe pour monter.',
    rules: [
      "Grimpe jusqu'en haut de la **rampe en zigzag**. Un squelette lance des **tonneaux** du sommet : ils dévalent la pente, **rebondissent** entre eux et contre les **deux parois**.",
      "Un tonneau te roule dessus ? **Écrasé !** Tu repars du **début du tronçon** (montée ou virage). Saute par-dessus (**Espace**) ou change de côté au bon moment.",
      "**Pousse** les autres sous les tonneaux (touche E, recharge 1,4 s). **1er en haut : 4 pièces d'or**, puis 3, 2, 1. La partie s'arrête quand **3 joueurs** sont arrivés.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Courir (ou les flèches)' },
      { keys: ['Espace'], label: 'Sauter par-dessus un tonneau' },
      { keys: ['E'], label: 'Pousser un joueur' },
    ],
    imposter: {
      name: 'Œil de lynx',
      text: "L'imposteur voit des **flèches** sur le sol : la **trajectoire** de chaque tonneau, rebonds compris. Celui qui se faufile toujours au bon endroit sans hésiter est suspect !",
      secret: "Des flèches au sol te montrent où vont rouler les tonneaux (rebonds compris). Passe entre eux… mais fais-toi écraser de temps en temps, sinon tu vas te trahir !",
    },
    debriefHint: "Il y en a un qui esquivait les tonneaux comme s'il savait d'avance où ils allaient… Curieux, non ?",
    points: 'Pièces d’or : 4 au 1er en haut · 3 · 2 · 1',
  },
  'pont-branlant': {
    title: 'Le Pont Branlant',
    tagline: "Un gouffre, des chemins étroits comme un fil… et pas de garde-fou.",
    rules: [
      "Traverse le gouffre jusqu'à l'arrivée. Les chemins ne font **qu'une case de large** et zigzaguent : on ne se déplace que **dans 4 directions**.",
      "Chaque **pont** est un point de passage : si tu tombes, tu repars du dernier pont atteint. Mais en y arrivant, une **tornade** te fait tourner… et **mélange tes commandes** (haut, bas, gauche, droite : une de chaque).",
      "**Pousse** les autres pour les faire tomber (touche E, recharge 1,5 s). **1er arrivé : 4 pièces d'or**, puis 3, 2, 1. La course s'arrête quand **3 joueurs** ont franchi l'arrivée.",
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Avancer (4 directions, ou les flèches)' },
      { keys: ['E'], label: 'Pousser (recharge 1,5 s)' },
    ],
    imposter: {
      name: 'Pied sûr',
      text: "Les tornades le font tourner comme tout le monde, mais **ses commandes ne sont jamais mélangées**. Celui qui file droit après un pont est suspect !",
      secret: "Après chaque pont, la tornade te fait tourner comme les autres, mais tes commandes restent normales. Pense à hésiter un peu pour ne pas te faire repérer !",
    },
    debriefHint: "Mais l'un de vous n'a jamais eu l'air perdu en sortant d'un pont… Curieux, non ?",
    points: 'Pièces d’or : 4 au 1er · 3 au 2e · 2 au 3e · 1 au 4e',
  },
  'bal-squelettes': {
    title: 'Le Bal des Squelettes',
    tagline: 'Les morts se lèvent… et ils ont envie de danser avec vous.',
    rules: [
      'Des squelettes sortent des tombes : **1, puis 2, puis 3…** un de plus toutes les 6 secondes. Ils te pourchassent, mais ils sont **plus lents que toi**.',
      'Un aventurier touché est **maudit** : il devient chasseur à son tour (un peu plus lent) et peut toucher les autres.',
      'Sers-toi des tombes pour semer tes poursuivants. **Le dernier à se faire toucher gagne !**',
    ],
    controls: [
      { keys: ['Z', 'Q', 'S', 'D'], label: 'Courir (ou les flèches)' },
      { keys: ['Espace'], label: 'Sauter' },
    ],
    imposter: {
      name: 'Odeur de tombe',
      text: "Les squelettes le trouvent moins appétissant : ils s'en prennent **d'abord aux autres**. Celui que les squelettes ignorent est suspect !",
      secret: "Les squelettes te délaissent : ils chassent toujours quelqu'un d'autre, sauf si tu es vraiment tout près. Attention, un contact reste un contact !",
    },
    debriefHint: "Mais dites-moi… les squelettes ont semblé bouder l'un d'entre vous. Étrange, non ?",
    points: 'Pièces d’or : 4 au 1er · 3 au 2e · 2 au 3e · 1 au 4e',
  },
};
