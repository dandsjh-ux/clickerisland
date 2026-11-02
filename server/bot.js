// Simple AI opponent: answers quizzes (imperfectly), builds a walled base, trains an army and raids during PVP.
import * as C from '../shared/config.js';

const DEFENSE_TYPES = ['cannon', 'tower', 'mortar', 'battery', 'guardpost'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ring = (x, y) => Math.max(Math.abs(x + 0.5 - 9), Math.abs(y + 0.5 - 9));

export function botTick(room, p, now) {
  const bot = (p.bot ||= { nextAnswer: now + 2000, nextDeploy: 0, target: null, side: 0, phaseKey: '', acc: 0.65 + Math.random() * 0.2 });
  const phaseKey = `${room.round}:${room.phase}`;
  if (bot.phaseKey !== phaseKey) {
    bot.phaseKey = phaseKey;
    bot.target = null;
    bot.nextDeploy = now + (room.round === 1 ? 15000 : 5000) + Math.random() * 10000; // gentler opening round
  }

  // Earn coins the same ways a player does.
  if (now >= bot.nextAnswer) {
    const year = pick([4, 5, 5, 6, 6, 7]);
    if (Math.random() < bot.acc) {
      const reward = room.quizReward(p, year);
      p.coins += reward;
      p.quiz.streak++;
      p.quiz.correct++;
    } else p.quiz.streak = 0;
    p.quiz.answered++;
    bot.nextAnswer = now + 5000 + Math.random() * 5000;
  }
  p.coins += p.tapLevel * 2;
  for (const b of p.buildings) {
    if (b.type === 'mint' && b.stored >= C.buildingStats('mint', b.level).store * 0.5) {
      p.coins += Math.floor(b.stored);
      b.stored = 0;
    }
  }

  if (room.phase === 'build') botBuild(room, p, now);
  else if (room.phase === 'pvp') botAttack(room, p, now);
}

function candidates(room, p, progress) {
  const L = p.cmdLevel;
  const lim = (t) => C.LIMITS[t][L - 1];
  const out = [];
  const add = (prio, cost, run) => out.push({ prio, cost, run });

  const caps = p.caps();
  const trainPrio = progress > 0.7 ? 95 : 35;
  if (caps.landUsed < caps.land) {
    const t = pick(['raider', 'raider', 'archer', 'archer', 'brute', 'sapper']);
    add(trainPrio, C.UNITS[t].cost, () => room.train(p, t, 3));
  }
  if (caps.seaUsed + 2 <= caps.sea) {
    const t = pick(['gunboat', 'gunboat', 'frigate', 'battleship']);
    add(trainPrio - 1, C.UNITS[t].cost, () => room.train(p, t, 1));
  }

  if (L < C.MAX_LEVEL) {
    const allowed = DEFENSE_TYPES.reduce((s, t) => s + lim(t), 0);
    const built = DEFENSE_TYPES.reduce((s, t) => s + p.count(t), 0);
    if (built >= allowed * 0.6) add(90, C.upgradeCost('command', L), () => room.upgrade(p, p.command.id));
  }

  const wanted = [['cannon', 80], ['tower', 79], ['battery', 78], ['mint', 77], ['mortar', 74], ['library', 72], ['guardpost', 70], ['barracks', 60], ['shipyard', 58]];
  for (const [t, prio] of wanted) if (p.count(t) < lim(t)) add(prio, C.BUILDINGS[t].cost, () => placeBuilding(room, p, t));
  if (p.count('wall') < lim('wall')) add(55, C.BUILDINGS.wall.cost, () => placeBuilding(room, p, 'wall'));
  for (const t of ['spike', 'bomb', 'seamine']) if (p.count(t) < lim(t)) add(45, C.BUILDINGS[t].cost, () => placeBuilding(room, p, t));

  const upg = p.buildings
    .filter((b) => b.type !== 'command' && !C.BUILDINGS[b.type].trap && b.level < L)
    .sort((a, b) => a.level - b.level || (DEFENSE_TYPES.includes(b.type) - DEFENSE_TYPES.includes(a.type)));
  if (upg.length) {
    const b = upg[0];
    add(DEFENSE_TYPES.includes(b.type) ? 50 : 40, C.upgradeCost(b.type, b.level), () => room.upgrade(p, b.id));
  }
  for (const t of C.UNIT_TYPES) {
    const cap = p.maxLevelOf(C.UNITS[t].domain === 'land' ? 'barracks' : 'shipyard');
    if (p.unitLevels[t] < cap) add(30, C.unitUpgradeCost(t, p.unitLevels[t]), () => room.unitUpgrade(p, t));
  }
  if (p.tapLevel < 5) add(25, C.tapUpgradeCost(p.tapLevel), () => room.tapUpgrade(p));
  return out.sort((a, b) => b.prio - a.prio);
}

function botBuild(room, p, now) {
  const total = room.settings.buildMin * 60000;
  const progress = 1 - Math.max(0, room.endsAt - now) / total;
  for (let n = 0; n < 4; n++) {
    let acted = false, saving = false;
    for (const c of candidates(room, p, progress)) {
      if (saving && c.prio < 70) break; // saving up: only essentials until then
      if (c.cost > p.coins) {
        if (c.prio >= 90) saving = true;
        continue;
      }
      if (!c.run()) { acted = true; break; }
    }
    if (!acted) return;
  }
}

function placeBuilding(room, p, type) {
  const spots = [];
  if (type === 'seamine') {
    for (let y = -2; y <= C.GRID + 1; y++) for (let x = -2; x <= C.GRID + 1; x++) if (C.isShallow(x, y)) spots.push([x, y, Math.random()]);
  } else {
    for (let y = 1; y <= C.GRID - 2; y++) {
      for (let x = 1; x <= C.GRID - 2; x++) {
        const r = ring(x, y);
        let score;
        if (type === 'wall') {
          // Fill the inner ring first, then the outer ring. Angle keeps the ring contiguous.
          const ang = (Math.atan2(y - 8.5, x - 8.5) + Math.PI) / (Math.PI * 2);
          score = r === 5.5 ? ang : r === 7.5 ? 2 + ang : 99;
        } else if (DEFENSE_TYPES.includes(type)) score = Math.abs(r - 3) + Math.random() * 1.5;
        else if (type === 'spike' || type === 'bomb') score = Math.abs(r - 6.5) + Math.random() * 2;
        else score = Math.abs(r - 6.5) + Math.random() * 2.5;
        if (score < 99) spots.push([x, y, score]);
      }
    }
  }
  spots.sort((a, b) => a[2] - b[2]);
  for (const [x, y] of spots) if (room.canPlace(p, type, x, y)) return room.build(p, type, x, y);
  return 'No room';
}

function botAttack(room, p, now) {
  if (now < p.bot.nextDeploy) return;
  const bot = p.bot;
  if (!bot.target || !bot.target.alive || !room.battles.get(bot.target.id) || room.battles.get(bot.target.id).over) {
    const foes = room.players.filter((o) => o.alive && o !== p && room.battles.get(o.id) && !room.battles.get(o.id).over);
    if (!foes.length) return;
    const humans = foes.filter((o) => !o.isBot);
    bot.target = pick(humans.length && Math.random() < 0.7 ? humans : foes);
    bot.side = Math.floor(Math.random() * 4);
  }
  const sea = C.UNIT_TYPES.filter((t) => C.UNITS[t].domain === 'sea' && p.army[t] > 0);
  const land = C.UNIT_TYPES.filter((t) => C.UNITS[t].domain === 'land' && p.army[t] > 0);
  const along = 2 + Math.random() * 14;
  const at = (off) => [[along, off], [C.GRID - off, along], [along, C.GRID - off], [off, along]][bot.side];
  let type, n, pos;
  if (sea.length) {
    type = pick(sea);
    n = p.army[type];
    pos = at(-5.5);
  } else if (land.length) {
    type = land.includes('brute') ? 'brute' : land.includes('sapper') && Math.random() < 0.5 ? 'sapper' : pick(land);
    n = Math.min(p.army[type], 6);
    pos = at(0.5);
  } else return;
  room.deploy(p, bot.target.id, type, pos[0], pos[1], n);
  bot.nextDeploy = now + 1500 + Math.random() * 2500;
}
