// Clicker Island Wars - web server (Express static files + Socket.IO multiplayer).
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { Room, cleanName } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/three/build', express.static(path.join(ROOT, 'node_modules/three/build'), { maxAge: '7d' }));
app.use('/vendor/three/examples/jsm', express.static(path.join(ROOT, 'node_modules/three/examples/jsm'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom(opts) {
  const room = new Room(io, newCode(), opts, (r) => rooms.delete(r.code));
  rooms.set(room.code, room);
  return room;
}

function context(socket) {
  const room = rooms.get(socket.data.code);
  const p = room?.get(socket.data.pid);
  return room && p ? { room, p } : null;
}

function leaveCurrent(socket) {
  const ctx = context(socket);
  if (ctx) ctx.room.removePlayer(ctx.p);
  socket.data.code = null;
  socket.data.pid = null;
}

function joinRoom(socket, room, name, ack) {
  leaveCurrent(socket);
  if (room.phase !== 'lobby') return ack?.({ error: 'That game has already started.' });
  const p = room.addPlayer(cleanName(name));
  if (!p) return ack?.({ error: 'That room is full.' });
  room.attach(p, socket);
  ack?.({ ok: true, code: room.code, token: p.token });
}

const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('hello', (d = {}, ack) => {
    ack = safeAck(ack);
    for (const room of rooms.values()) {
      const p = room.players.find((o) => o.token && o.token === d.token);
      if (p) {
        room.attach(p, socket);
        return ack({ ok: true, rejoined: true, code: room.code });
      }
    }
    ack({ ok: true, rejoined: false, rooms: rooms.size });
  });

  socket.on('create', (d = {}, ack) => {
    ack = safeAck(ack);
    const room = createRoom({ isPublic: !!d.isPublic, settings: d.settings });
    joinRoom(socket, room, d.name, ack);
    if (d.bots) for (let i = 0; i < Math.min(5, Number(d.bots) || 0); i++) room.addBot();
    room.broadcastRoom();
  });

  socket.on('join', (d = {}, ack) => {
    ack = safeAck(ack);
    const room = rooms.get(String(d.code || '').toUpperCase().trim());
    if (!room) return ack({ error: 'Room not found. Check the code!' });
    joinRoom(socket, room, d.name, ack);
  });

  socket.on('quick', (d = {}, ack) => {
    ack = safeAck(ack);
    let room = [...rooms.values()].find((r) => r.isPublic && r.phase === 'lobby' && r.players.length < r.settings.maxPlayers);
    if (!room) room = createRoom({ isPublic: true });
    joinRoom(socket, room, d.name, ack);
  });

  socket.on('leave', () => leaveCurrent(socket));

  socket.on('act', (type, data, ack) => {
    ack = safeAck(ack);
    const ctx = context(socket);
    if (!ctx) return ack({ error: 'You are not in a game.' });
    try {
      ack(ctx.room.act(ctx.p, String(type), data || {}));
    } catch (err) {
      console.error('action failed', type, err);
      ack({ error: 'Something went wrong.' });
    }
  });

  socket.on('disconnect', () => {
    const ctx = context(socket);
    if (ctx && ctx.p.socket === socket) ctx.room.detach(ctx.p);
  });
});

server.listen(PORT, () => console.log(`Clicker Island Wars running on http://localhost:${PORT}`));
