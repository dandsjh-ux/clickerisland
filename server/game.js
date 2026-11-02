// Rooms, players, phases and every player action. The server is authoritative:
// clients only send intents (tap, answer, build, deploy...) and render what comes back.
import crypto from 'crypto';
import * as C from '../shared/config.js';
import { QUESTIONS } from './questions.js';
import { Battle } from './battle.js';
import { botTick } from './bot.js';

const TICK_MS = 100;
const BOT_NAMES = ['Captain Coral', 'Admiral Kelp', 'Pirate Pebble', 'Commodore Conch', 'Skipper Squid', 'Bosun Barnacle'];

export const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const toInt = (v, min, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

export function cleanName(name) {
  const s = String(name || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
  return s || 'Islander';
}

export function cleanSettings(s = {}) {
  const out = { ...C.DEFAULT_SETTINGS };
  for (const k of Object.keys(C.SETTING_OPTIONS)) {
    const v = Number(s[k]);
    if (C.SETTING_OPTIONS[k].includes(v)) out[k] = v;
  }
  return out;
}

export class Player {
  constructor(id, name, isBot = false) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.token = isBot ? null : crypto.randomUUID();
    this.socket = null;
    this.connected = isBot;
    this.disconnectedAt = 0;
    this.colorIdx = 0;
    this.watching = id;
    this.reset();
  }

  reset() {
    this.coins = C.START.coins;
    this.tapLevel = 1;
    this.tapBucket = C.MAX_TAPS_PER_SEC;
    this.tapAt = Date.now();
    this.nextBid = 1;
    this.buildings = C.START.buildings.map((b) => ({
      id: this.nextBid++, type: b.type, x: b.x, y: b.y, level: 1, spent: C.BUILDINGS[b.type].cost, stored: 0,
    }));
    this.army = Object.fromEntries(C.UNIT_TYPES.map((t) => [t, C.START.army[t] || 0]));
    this.unitLevels = Object.fromEntries(C.UNIT_TYPES.map((t) => [t, 1]));
    this.quiz = { decks: {}, current: null, streak: 0, best: 0, correct: 0, answered: 0, cooldownUntil: 0, earned: 0 };
    this.alive = true;
    this.score = 0;
    this.roundStats = Player.blankStats();
    this.dirty = true;
    this.layoutDirty = true;
    this.bot = null;
  }

  static blankStats() { return { loot: 0, destroyed: 0, kills: 0, bounty: 0, lost: 0, deployed: 0 }; }

  get command() { return this.buildings.find((b) => b.type === 'command'); }
  get cmdLevel() { return this.command ? this.command.level : 1; }
  count(type) { return this.buildings.reduce((n, b) => n + (b.type === type), 0); }
  maxLevelOf(type) { return this.buildings.reduce((m, b) => (b.type === type ? Math.max(m, b.level) : m), 0); }

  caps() {
    let land = 0, sea = 0, landUsed = 0, seaUsed = 0;
    for (const b of this.buildings) {
      const st = C.buildingStats(b.type, b.level);
      land += st.landCap;
      sea += st.seaCap;
    }
    for (const t of C.UNIT_TYPES) {
      const u = C.UNITS[t];
      if (u.domain === 'land') landUsed += this.army[t] * u.space;
      else seaUsed += this.army[t] * u.space;
    }
    return { land, sea, landUsed, seaUsed };
  }

  quizBonus() {
    return this.buildings.reduce((s, b) => s + (b.type === 'library' ? C.buildingStats('library', b.level).quizBonus : 0), 0);
  }

  privateState() {
    return {
      id: this.id, name: this.name, colorIdx: this.colorIdx, coins: Math.floor(this.coins), tapLevel: this.tapLevel,
      buildings: this.buildings.map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, level: b.level, stored: Math.floor(b.stored), spent: b.spent })),
      army: this.army, unitLevels: this.unitLevels, caps: this.caps(), cmdLevel: this.cmdLevel,
      streak: this.quiz.streak, correct: this.quiz.correct, answered: this.quiz.answered, quizBonus: this.quizBonus(),
      alive: this.alive, score: this.score,
    };
  }

  // What other players can see: no hidden traps.
  publicIsland() {
    return {
      id: this.id, name: this.name, colorIdx: this.colorIdx,
      buildings: this.buildings.filter((b) => !C.BUILDINGS[b.type].trap).map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, level: b.level })),
    };
  }
}

export class Room {
  constructor(io, code, { isPublic = false, settings = {} } = {}, onClose) {
    this.io = io;
    this.code = code;
    this.isPublic = isPublic;
    this.settings = cleanSettings(settings);
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.round = 0;
    this.endsAt = 0;
    this.battles = new Map();
    this.result = null;
    this.nextPid = 1;
    this.lastSecond = Date.now();
    this.emptySince = 0;
    this.onClose = onClose;
    this.hooks = {
      onBuildingDestroyed: (bt, b, attackerId) => {
        const a = this.get(attackerId);
        if (!a) return;
        const loot = C.lootValue(b.type, b.level);
        a.coins += loot;
        a.roundStats.loot += loot;
        a.roundStats.destroyed++;
        a.score += b.type === 'wall' ? 1 : b.type === 'command' ? 50 : 10;
        a.dirty = true;
      },
      onUnitKilled: (bt, u) => {
        const d = this.get(bt.defId);
        if (d) {
          const bounty = C.bountyValue(u.type);
          d.coins += bounty;
          d.roundStats.bounty += bounty;
          d.roundStats.kills++;
          d.score += 1;
          d.dirty = true;
        }
        const o = this.get(u.owner);
        if (o) o.roundStats.lost++;
      },
    };
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  get(id) { return this.players.find((p) => p.id === id); }
  ch(pid) { return `w:${this.code}:${pid}`; }
  get humans() { return this.players.filter((p) => !p.isBot); }

  emitTo(p, ev, data) { if (p.socket) p.socket.emit(ev, data); }
  toast(msg, kind = 'info') { this.io.to(`r:${this.code}`).emit('toast', { msg, kind }); }

  info() {
    return {
      code: this.code, isPublic: this.isPublic, hostId: this.hostId, phase: this.phase, round: this.round,
      settings: this.settings, endsAt: this.endsAt, now: Date.now(),
      players: this.players.map((p) => {
        const bt = this.battles.get(p.id);
        return {
          id: p.id, name: p.name, colorIdx: p.colorIdx, isBot: p.isBot, connected: p.connected, alive: p.alive,
          score: p.score, cmdLevel: p.cmdLevel, cmdHp: bt ? bt.commandPct : (p.alive ? 100 : 0), destroyed: bt ? bt.destroyedPct : 0,
        };
      }),
    };
  }

  broadcastRoom() { this.io.to(`r:${this.code}`).emit('room', this.info()); }

  // ---------- Membership ----------
  addPlayer(name, isBot = false) {
    if (this.players.length >= this.settings.maxPlayers) return null;
    const p = new Player(`p${this.nextPid++}`, name, isBot);
    const used = new Set(this.players.map((o) => o.colorIdx));
    p.colorIdx = [0, 1, 2, 3, 4, 5].find((i) => !used.has(i)) ?? 0;
    this.players.push(p);
    if (!isBot && !this.hostId) this.hostId = p.id;
    return p;
  }

  addBot() {
    const used = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${this.nextPid}`;
    return this.addPlayer(name, true);
  }

  attach(p, socket) {
    if (p.socket && p.socket !== socket) p.socket.disconnect(true);
    p.socket = socket;
    p.connected = true;
    p.disconnectedAt = 0;
    p.watching = p.id;
    socket.data.code = this.code;
    socket.data.pid = p.id;
    socket.join(`r:${this.code}`);
    socket.join(this.ch(p.id));
    socket.emit('joined', { pid: p.id, code: this.code, token: p.token });
    socket.emit('room', this.info());
    socket.emit('me', p.privateState());
    const bt = this.battles.get(p.id);
    if (bt) socket.emit('battle', bt.snapshot(true));
    if (this.phase === 'over' && this.result) socket.emit('over', this.result);
    this.broadcastRoom();
  }

  detach(p) {
    p.socket = null;
    p.connected = false;
    p.disconnectedAt = Date.now();
    this.broadcastRoom();
  }

  removePlayer(p) {
    this.players = this.players.filter((o) => o !== p);
    if (p.socket) {
      p.socket.leave(`r:${this.code}`);
      p.socket.leave(this.ch(p.watching));
      p.socket.data.code = null;
    }
    p.socket = null;
    if (this.phase !== 'lobby' && this.phase !== 'over' && p.alive) {
      p.alive = false;
      this.battles.delete(p.id);
      this.toast(`${p.name} left the war.`);
      this.checkWinner();
    }
    if (this.hostId === p.id) this.hostId = this.humans[0]?.id || null;
    this.broadcastRoom();
  }

  close() {
    clearInterval(this.timer);
    this.onClose?.(this);
  }

  // ---------- Phases ----------
  start() {
    if (this.players.length < 2) return 'You need at least 2 players. Add a bot!';
    for (const p of this.players) p.reset();
    this.result = null;
    this.round = 1;
    this.toBuild();
    return null;
  }

  toBuild() {
    this.phase = 'build';
    this.endsAt = Date.now() + this.settings.buildMin * 60000;
    this.battles.clear();
    this.broadcastRoom();
    for (const p of this.players) { p.dirty = true; p.layoutDirty = true; }
  }

  toPvp() {
    this.phase = 'pvp';
    this.endsAt = Date.now() + this.settings.pvpMin * 60000;
    this.battles.clear();
    for (const p of this.players) {
      p.roundStats = Player.blankStats();
      if (p.alive) this.battles.set(p.id, new Battle(p, this.hooks));
    }
    for (const [id, bt] of this.battles) this.io.to(this.ch(id)).emit('battle', bt.snapshot(true));
    this.broadcastRoom();
  }

  returnSurvivors(bt) {
    const back = bt.takeSurvivors();
    for (const [owner, units] of Object.entries(back)) {
      const p = this.get(owner);
      if (!p) continue;
      for (const [t, n] of Object.entries(units)) p.army[t] += n;
      p.dirty = true;
    }
  }

  endPvp() {
    for (const bt of this.battles.values()) this.returnSurvivors(bt);
    for (const p of this.players) this.emitTo(p, 'report', { round: this.round, ...p.roundStats });
    this.battles.clear();
    if (this.round >= this.settings.rounds) {
      this.finish(null, 'rounds');
      return;
    }
    this.round++;
    this.toBuild();
  }

  onCommandDestroyed(bt) {
    const def = this.get(bt.defId);
    const killer = this.get(bt.killer);
    this.returnSurvivors(bt);
    if (def) {
      def.alive = false;
      def.dirty = true;
      this.toast(`💥 ${killer ? killer.name : 'Someone'} destroyed ${def.name}'s Central Command!`, 'big');
    }
    this.checkWinner(killer);
  }

  checkWinner(killer) {
    if (this.phase !== 'build' && this.phase !== 'pvp') return;
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) this.finish(alive[0] || killer || null, 'command');
  }

  finish(winner, reason) {
    const ranking = [...this.players].sort((a, b) => (b.alive - a.alive) || (b.score - a.score));
    if (!winner) winner = ranking[0];
    this.phase = 'over';
    this.battles.clear();
    this.result = {
      winnerId: winner?.id, winnerName: winner?.name, reason,
      ranking: ranking.map((p) => ({ id: p.id, name: p.name, colorIdx: p.colorIdx, score: p.score, alive: p.alive, isBot: p.isBot, correct: p.quiz.correct, answered: p.quiz.answered })),
    };
    this.io.to(`r:${this.code}`).emit('over', this.result);
    this.broadcastRoom();
  }

  rematch() {
    for (const p of [...this.players]) if (!p.isBot && !p.connected) this.removePlayer(p);
    for (const p of this.players) p.reset();
    this.phase = 'lobby';
    this.round = 0;
    this.result = null;
    this.battles.clear();
    this.broadcastRoom();
  }

  // ---------- Loop ----------
  tick() {
    const now = Date.now();
    if (this.phase === 'build' && now >= this.endsAt) this.toPvp();
    else if (this.phase === 'pvp' && now >= this.endsAt) this.endPvp();

    if (this.phase === 'pvp') {
      for (const bt of this.battles.values()) {
        if (bt.reported) continue;
        bt.step(TICK_MS / 1000);
        this.io.to(this.ch(bt.defId)).emit('battle', bt.flush());
        if (bt.over) {
          bt.reported = true;
          this.onCommandDestroyed(bt);
          if (this.phase !== 'pvp') break;
        }
      }
    }

    if (now - this.lastSecond >= 1000) {
      this.lastSecond = now;
      this.everySecond(now);
    }

    for (const p of this.players) {
      if (p.isBot) continue;
      if (p.dirty) { p.dirty = false; this.emitTo(p, 'me', p.privateState()); }
    }
    for (const p of this.players) {
      if (p.layoutDirty && now - (p.layoutAt || 0) > 500) {
        p.layoutDirty = false;
        p.layoutAt = now;
        this.io.to(this.ch(p.id)).emit('island', p.publicIsland());
      }
    }
  }

  everySecond(now) {
    if (this.phase === 'build' || this.phase === 'pvp') {
      for (const p of this.players) {
        if (!p.alive) continue;
        for (const b of p.buildings) {
          if (b.type !== 'mint') continue;
          const st = C.buildingStats('mint', b.level);
          if (b.stored < st.store) { b.stored = Math.min(st.store, b.stored + st.income); p.dirty = true; }
        }
        if (p.isBot) botTick(this, p, now);
      }
      this.broadcastRoom();
    }
    if (this.phase === 'lobby') {
      for (const p of [...this.players]) {
        if (!p.isBot && !p.connected && now - p.disconnectedAt > 15000) this.removePlayer(p);
      }
    }
    const anyone = this.humans.some((p) => p.connected);
    if (anyone) this.emptySince = 0;
    else if (!this.emptySince) this.emptySince = now;
    else if (now - this.emptySince > (this.phase === 'lobby' ? 15000 : 120000)) this.close();
  }

  // ---------- Actions ----------
  act(p, type, d = {}) {
    const hostOnly = ['addBot', 'kick', 'start', 'settings', 'rematch'];
    if (hostOnly.includes(type) && p.id !== this.hostId) return { error: 'Only the host can do that.' };
    switch (type) {
      case 'addBot':
        if (this.phase !== 'lobby') return { error: 'The game has already started.' };
        if (!this.addBot()) return { error: 'The room is full.' };
        this.broadcastRoom();
        return {};
      case 'kick': {
        const t = this.get(d.id);
        if (this.phase !== 'lobby' || !t || t === p) return { error: 'Cannot remove that player.' };
        this.removePlayer(t);
        return {};
      }
      case 'settings':
        if (this.phase !== 'lobby') return { error: 'The game has already started.' };
        this.settings = cleanSettings({ ...this.settings, ...d });
        while (this.players.length > this.settings.maxPlayers) {
          const bot = [...this.players].reverse().find((o) => o.isBot);
          if (!bot) { this.settings.maxPlayers = this.players.length; break; }
          this.removePlayer(bot);
        }
        this.broadcastRoom();
        return {};
      case 'start': {
        if (this.phase !== 'lobby') return { error: 'Already started.' };
        const err = this.start();
        return err ? { error: err } : {};
      }
      case 'rematch':
        if (this.phase !== 'over') return { error: 'The game is not over yet.' };
        this.rematch();
        return {};
      case 'watch': return this.watch(p, d.id);
    }
    if (this.phase !== 'build' && this.phase !== 'pvp') return { error: 'The game is not running.' };
    if (!p.alive) return { error: 'Your Central Command was destroyed. You can still watch!' };
    switch (type) {
      case 'tap': return this.tap(p, d.n);
      case 'collect': return this.collect(p, d.id);
      case 'quiz': return this.quizGet(p, d.year);
      case 'answer': return this.quizAnswer(p, d.qid, d.choice);
      case 'build': return this.result$(this.build(p, d.type, d.x, d.y));
      case 'upgrade': return this.result$(this.upgrade(p, d.id));
      case 'move': return this.result$(this.move(p, d.id, d.x, d.y));
      case 'sell': return this.result$(this.sell(p, d.id));
      case 'train': return this.result$(this.train(p, d.type, d.n));
      case 'unitUpgrade': return this.result$(this.unitUpgrade(p, d.type));
      case 'tapUpgrade': return this.result$(this.tapUpgrade(p));
      case 'deploy': return this.result$(this.deploy(p, d.target, d.type, d.x, d.y, d.n));
      default: return { error: 'Unknown action.' };
    }
  }

  result$(err) { return err ? { error: err } : { ok: true }; }

  watch(p, id) {
    const t = this.get(id);
    if (!t || !p.socket) return { error: 'No such island.' };
    p.socket.leave(this.ch(p.watching));
    p.watching = t.id;
    p.socket.join(this.ch(t.id));
    const bt = this.battles.get(t.id);
    return { island: t.publicIsland(), battle: bt ? bt.snapshot(true) : null };
  }

  tap(p, n) {
    n = toInt(n, 0, 60);
    const now = Date.now();
    p.tapBucket = Math.min(C.MAX_TAPS_PER_SEC * 2, p.tapBucket + ((now - p.tapAt) / 1000) * C.MAX_TAPS_PER_SEC);
    p.tapAt = now;
    const ok = Math.min(n, Math.floor(p.tapBucket));
    p.tapBucket -= ok;
    p.coins += ok * p.tapLevel;
    p.dirty = true;
    return { ok: true, gained: ok * p.tapLevel };
  }

  collect(p, id) {
    const b = p.buildings.find((x) => x.id === id && x.type === 'mint');
    if (!b) return { error: 'Nothing to collect.' };
    const amount = Math.floor(b.stored);
    b.stored -= amount;
    p.coins += amount;
    p.dirty = true;
    return { ok: true, amount };
  }

  quizReward(p, year) {
    const streak = Math.min(p.quiz.streak, C.STREAK_MAX);
    return Math.round(C.QUIZ_REWARD[year] * (1 + p.quizBonus()) * (1 + streak * C.STREAK_BONUS));
  }

  quizGet(p, year) {
    year = Number(year);
    const bank = QUESTIONS[year];
    if (!bank) return { error: 'Pick a year group.' };
    const now = Date.now();
    if (now < p.quiz.cooldownUntil) return { error: 'wait', wait: p.quiz.cooldownUntil - now };
    let deck = p.quiz.decks[year];
    if (!deck || !deck.length) deck = p.quiz.decks[year] = shuffle([...bank.keys()]);
    const idx = deck.pop();
    const q = bank[idx];
    const order = shuffle([0, 1, 2, 3]);
    const qid = crypto.randomBytes(6).toString('hex');
    p.quiz.current = { qid, year, idx, correct: order.indexOf(0) };
    return { qid, year, text: q.q, options: order.map((i) => q.a[i]), reward: this.quizReward(p, year), streak: p.quiz.streak, left: deck.length };
  }

  quizAnswer(p, qid, choice) {
    const cur = p.quiz.current;
    if (!cur || cur.qid !== qid) return { error: 'That question has expired.' };
    p.quiz.current = null;
    const q = QUESTIONS[cur.year][cur.idx];
    const correct = Number(choice) === cur.correct;
    p.quiz.answered++;
    let reward = 0;
    if (correct) {
      reward = this.quizReward(p, cur.year);
      p.coins += reward;
      p.quiz.streak++;
      p.quiz.best = Math.max(p.quiz.best, p.quiz.streak);
      p.quiz.correct++;
      p.quiz.earned += reward;
    } else {
      p.quiz.streak = 0;
      p.quiz.cooldownUntil = Date.now() + C.WRONG_COOLDOWN_MS;
    }
    p.dirty = true;
    return { qid, correct, correctIndex: cur.correct, explanation: q.e, reward, streak: p.quiz.streak, cooldown: correct ? 0 : C.WRONG_COOLDOWN_MS };
  }

  canPlace(p, type, x, y, ignoreId) {
    const def = C.BUILDINGS[type];
    const size = def.size || 1;
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        if (def.water ? !C.isShallow(x + dx, y + dy) : !C.isBuildable(x + dx, y + dy)) return false;
      }
    }
    for (const b of p.buildings) {
      if (b.id === ignoreId) continue;
      const bs = C.BUILDINGS[b.type].size || 1;
      if (x < b.x + bs && x + size > b.x && y < b.y + bs && y + size > b.y) return false;
    }
    return true;
  }

  build(p, type, x, y) {
    if (this.phase !== 'build') return 'You can only build during the build phase.';
    const def = C.BUILDINGS[type];
    if (!def || type === 'command') return 'Unknown building.';
    x = toInt(x, C.WMIN, C.WMAX);
    y = toInt(y, C.WMIN, C.WMAX);
    const limit = C.LIMITS[type][p.cmdLevel - 1];
    if (p.count(type) >= limit) return limit ? `Limit reached (${limit}). Upgrade your Central Command for more.` : 'Upgrade your Central Command to unlock this.';
    if (p.coins < def.cost) return 'Not enough coins - answer quiz questions to earn more!';
    if (!this.canPlace(p, type, x, y)) return "You can't build there.";
    p.coins -= def.cost;
    p.buildings.push({ id: p.nextBid++, type, x, y, level: 1, spent: def.cost, stored: 0 });
    p.dirty = p.layoutDirty = true;
    return null;
  }

  upgrade(p, id) {
    if (this.phase !== 'build') return 'Upgrades are only possible during the build phase.';
    const b = p.buildings.find((x) => x.id === id);
    if (!b) return 'Building not found.';
    if (b.level >= C.MAX_LEVEL) return 'Already at max level.';
    if (b.type !== 'command' && b.level >= p.cmdLevel) return 'Upgrade your Central Command first.';
    const cost = C.upgradeCost(b.type, b.level);
    if (p.coins < cost) return 'Not enough coins - answer quiz questions to earn more!';
    p.coins -= cost;
    b.level++;
    b.spent += cost;
    p.dirty = p.layoutDirty = true;
    return null;
  }

  move(p, id, x, y) {
    if (this.phase !== 'build') return 'You can only move buildings during the build phase.';
    const b = p.buildings.find((o) => o.id === id);
    if (!b) return 'Building not found.';
    if (b.type === 'command') return 'The Central Command cannot be moved.';
    x = toInt(x, C.WMIN, C.WMAX);
    y = toInt(y, C.WMIN, C.WMAX);
    if (!this.canPlace(p, b.type, x, y, b.id)) return "You can't move it there.";
    b.x = x;
    b.y = y;
    p.dirty = p.layoutDirty = true;
    return null;
  }

  sell(p, id) {
    if (this.phase !== 'build') return 'You can only demolish during the build phase.';
    const b = p.buildings.find((o) => o.id === id);
    if (!b || b.type === 'command') return 'That cannot be demolished.';
    p.coins += Math.floor(b.spent * 0.5);
    p.buildings = p.buildings.filter((o) => o !== b);
    p.dirty = p.layoutDirty = true;
    return null;
  }

  train(p, type, n) {
    const def = C.UNITS[type];
    if (!def) return 'Unknown unit.';
    n = toInt(n, 1, 50);
    const home = def.domain === 'land' ? 'barracks' : 'shipyard';
    if (!p.count(home)) return `Build a ${C.BUILDINGS[home].name} first.`;
    const caps = p.caps();
    const free = def.domain === 'land' ? caps.land - caps.landUsed : caps.sea - caps.seaUsed;
    n = Math.min(n, Math.floor(free / def.space));
    if (n <= 0) return `No space left. Build or upgrade a ${C.BUILDINGS[home].name}.`;
    n = Math.min(n, Math.floor(p.coins / def.cost));
    if (n <= 0) return 'Not enough coins - answer quiz questions to earn more!';
    p.coins -= n * def.cost;
    p.army[type] += n;
    p.dirty = true;
    return null;
  }

  unitUpgrade(p, type) {
    if (this.phase !== 'build') return 'Upgrades are only possible during the build phase.';
    const def = C.UNITS[type];
    if (!def) return 'Unknown unit.';
    const lv = p.unitLevels[type];
    if (lv >= C.MAX_LEVEL) return 'Already at max level.';
    const home = def.domain === 'land' ? 'barracks' : 'shipyard';
    if (lv >= p.maxLevelOf(home)) return `Upgrade your ${C.BUILDINGS[home].name} first.`;
    const cost = C.unitUpgradeCost(type, lv);
    if (p.coins < cost) return 'Not enough coins.';
    p.coins -= cost;
    p.unitLevels[type]++;
    p.dirty = true;
    return null;
  }

  tapUpgrade(p) {
    if (p.tapLevel >= C.TAP_MAX_LEVEL) return 'Tap power is maxed.';
    const cost = C.tapUpgradeCost(p.tapLevel);
    if (p.coins < cost) return 'Not enough coins.';
    p.coins -= cost;
    p.tapLevel++;
    p.dirty = true;
    return null;
  }

  deploy(p, targetId, type, x, y, n) {
    if (this.phase !== 'pvp') return 'Strikes can only be launched during PVP.';
    const target = this.get(targetId);
    if (!target || target === p || !target.alive) return 'Pick a living enemy island.';
    const bt = this.battles.get(target.id);
    if (!bt || bt.over) return 'That island has already fallen.';
    if (!C.UNITS[type]) return 'Unknown unit.';
    n = Math.min(toInt(n, 1, 50), p.army[type]);
    if (n <= 0) return `No ${C.UNITS[type].name}s left. Train more in the Army menu.`;
    const placed = bt.deploy(p, type, Number(x) || 0, Number(y) || 0, n);
    if (!placed) return 'Too many units on that island right now.';
    p.army[type] -= placed;
    p.roundStats.deployed += placed;
    p.dirty = true;
    return null;
  }
}
