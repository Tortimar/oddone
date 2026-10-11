import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, MAX_PLAYERS } from '@oddone/shared';
import { RoomManager, type Room } from '../src/rooms.ts';

const profile = (name: string) => ({ name, cfg: { ...DEFAULT_CONFIG } });
const manager = () => {
  const started: Room[] = [];
  const m = new RoomManager({ changed: () => {}, started: (r) => started.push(r) });
  return { m, started };
};

test('créer puis rejoindre avec le code', () => {
  const { m } = manager();
  const room = m.create('a', profile('Alice'));
  assert.equal(room.code.length, 4);
  const joined = m.join('b', room.code.toLowerCase(), profile('Bob'));
  assert.notEqual(typeof joined, 'string');
  assert.deepEqual(m.snapshot(room).players.map((p) => p.slot), [0, 1]);
});

test('code inconnu, mal formé, taverne pleine', () => {
  const { m } = manager();
  assert.equal(m.join('x', 'ZZZZ', profile('X')), 'room_not_found');
  assert.equal(m.join('x', 'AB', profile('X')), 'bad_code');
  const room = m.create('p0', profile('P0'));
  for (let i = 1; i < MAX_PLAYERS; i++) m.join('p' + i, room.code, profile('P' + i));
  assert.equal(m.join('late', room.code, profile('Late')), 'room_full');
});

test('un tabouret ne peut avoir qu\'un occupant', () => {
  const { m } = manager();
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  assert.equal(m.takeSeat('a', room, 2), true);
  assert.equal(m.takeSeat('b', room, 2), false);
  assert.equal(m.takeSeat('b', room, 7), false);
});

test('tout le monde assis → compte à rebours ; quelqu\'un se lève → annulé', () => {
  const { m } = manager();
  const room = m.create('a', profile('A'));
  m.join('b', room.code, profile('B'));
  m.takeSeat('a', room, 0);
  assert.equal(room.phase, 'lobby');
  m.takeSeat('b', room, 1);
  assert.equal(room.phase, 'countdown');
  m.leaveSeat('b', room);
  assert.equal(room.phase, 'lobby');
  m.leave('a', room); m.leave('b', room);
  assert.equal(m.rooms.size, 0);
});

test('les noms et tenues reçus sont nettoyés', () => {
  const { m } = manager();
  const room = m.create('a', { name: '  <b>Un pseudo bien trop long</b>  ', cfg: { body: 'dragon', hue: 999 } as never });
  const p = m.snapshot(room).players[0];
  assert.equal(p.name.length <= 12, true);
  assert.equal(p.cfg.body, DEFAULT_CONFIG.body);
  assert.equal(p.cfg.hue, null);
});
