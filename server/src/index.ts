import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, Transform } from '@oddone/shared';
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
  started: (room) => io.to(room.code).emit('game:start', { round: room.round }),
});

/** Validation légère d'une position reçue (les données client ne sont jamais fiables). */
function cleanTransform(t: unknown): Transform | null {
  if (!t || typeof t !== 'object') return null;
  const { p, r, a } = t as Partial<Transform>;
  if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100)) return null;
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
  socket.on('player:move', (t) => {
    if (!room) return;
    const clean = cleanTransform(t);
    if (clean) socket.to(room.code).volatile.emit('player:moved', socket.id, clean);
  });
  socket.on('disconnect', leave);
});

http.listen(PORT, () => {
  console.log(`OddOne server on http://localhost:${PORT}${existsSync(clientDist) ? ' (client compilé servi)' : ''}`);
});
