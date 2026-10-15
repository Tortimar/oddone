import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, Transform } from '@oddone/shared';
import { QUEST_BY_ID } from '@oddone/shared';
import { RoomManager, type Room } from './rooms.ts';

const PORT = Number(process.env.PORT) || 3001;
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(here, '../../client/dist');

const app = express();
const http = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
  // En dev le client passe par le proxy Vite ; en prod il est servi par ce même serveur.
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? false },
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
}

const rooms = new RoomManager({
  changed: (room) => io.to(room.code).emit('room:state', rooms.snapshot(room)),
  // chaque joueur a un salon à son id (Socket.io) : le rôle ne part qu'à lui ; les bots n'ont pas de socket
  secret: (_room, id, role) => io.to(id).emit('role:secret', role),
  tick: (room, t) => io.to(room.code).volatile.emit('mg:tick', t),
  hit: (room, h) => io.to(room.code).emit('player:hit', h),
  mgSecret: (_room, id, s) => io.to(id).emit('mg:secret', s),
});
// ODDONE_QUEST=festin-roi npm run dev : la quête est proposée à chaque vote (tester un mini-jeu)
const askedQuest = process.env.ODDONE_QUEST?.trim() || null;
if (askedQuest && !QUEST_BY_ID.has(askedQuest)) {
  // (fichiers pas à jour, faute de frappe, espace en trop sous l'invite de commandes…)
  console.warn(`ODDONE_QUEST="${askedQuest}" : quête inconnue, ignorée. Quêtes possibles : ${[...QUEST_BY_ID.keys()].join(', ')}`);
}
rooms.forcedQuest = askedQuest && QUEST_BY_ID.has(askedQuest) ? askedQuest : null;
if (rooms.forcedQuest) console.log(`Quête imposée pour les tests : ${rooms.forcedQuest}`);
// ODDONE_FINALE=1 npm run dev : la soirée saute de l'intro au grand podium (tester la fin de soirée)
rooms.skipToFinale = process.env.ODDONE_FINALE === '1';
if (rooms.skipToFinale) console.log('Grand podium dès la fin de l\'intro (ODDONE_FINALE=1).');
// ODDONE_IMPOSTER=1 npm run dev : l'imposteur est toujours un humain (tester son avantage)
rooms.humanImposter = process.env.ODDONE_IMPOSTER === '1';
if (rooms.humanImposter) console.log('Imposteur toujours humain (ODDONE_IMPOSTER=1).');

/** Validation légère d'une position reçue (les données client ne sont jamais fiables). */
function cleanTransform(t: unknown): Transform | null {
  if (!t || typeof t !== 'object') return null;
  const { p, r, a } = t as Partial<Transform>;
  // les arènes vont jusqu'à ~105 unités du centre (l'arrivée du Pont Branlant) : large marge
  if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 500)) return null;
  if (typeof r !== 'number' || !Number.isFinite(r)) return null;
  if (typeof a !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(a)) return null;
  return { p: [p[0], p[1], p[2]], r, a };
}

io.on('connection', (socket) => {
  let room: Room | null = null;

  const enter = (r: Room) => {
    room = r;
    socket.join(r.code);
    return { ok: true as const, you: socket.id, state: rooms.snapshot(r), serverTime: Date.now() };
  };
  const leave = () => {
    if (!room) return;
    socket.leave(room.code);
    rooms.leave(socket.id, room);
    room = null;
  };

  socket.on('room:create', (req, ack) => {
    if (typeof ack !== 'function') return;
    leave();
    ack(enter(rooms.create(socket.id, req)));
  });

  socket.on('room:join', (req, ack) => {
    if (typeof ack !== 'function') return;
    leave();
    const r = rooms.join(socket.id, req?.code, req);
    if (typeof r === 'string') return ack({ ok: false, error: r });
    ack(enter(r));
  });

  socket.on('room:leave', leave);
  socket.on('player:profile', (p) => { if (room) rooms.updateProfile(socket.id, room, p); });
  socket.on('seat:take', (seat, ack) => { if (room && typeof ack === 'function') ack(rooms.takeSeat(socket.id, room, seat)); });
  socket.on('seat:leave', () => { if (room) rooms.leaveSeat(socket.id, room); });
  socket.on('vote:cast', (optionId) => { if (room) rooms.vote(socket.id, room, optionId); });
  socket.on('bot:add', () => { if (room) rooms.addBot(socket.id, room); });
  socket.on('bot:remove', (botId) => { if (room) rooms.removeBot(socket.id, room, botId); });
  socket.on('mg:ready', () => { if (room) rooms.minigameReady(socket.id, room); });
  socket.on('mg:action', (kind, arg) => { if (room) rooms.minigameAction(socket.id, room, kind, arg); });
  socket.on('mg:hit', (to, kick, dir) => { if (room) rooms.hit(socket.id, room, to, kick, dir); });
  socket.on('player:move', (t) => {
    if (!room) return;
    const clean = cleanTransform(t);
    if (!clean) return;
    rooms.playerMoved(socket.id, room, clean.p[0], clean.p[1], clean.p[2], clean.r);
    socket.to(room.code).volatile.emit('player:moved', socket.id, clean);
  });
  socket.on('disconnect', leave);
});

http.listen(PORT, () => {
  console.log(`OddOne server on http://localhost:${PORT}${existsSync(clientDist) ? ' (client compilé servi)' : ''}`);
});
