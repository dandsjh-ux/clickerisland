// Server-side battle simulation for one defending island during the PVP phase.
// Attackers from any player can deploy into it; defences, traps and guards fight back.
import {
  BUILDINGS, UNITS, GUARD, GRID, WMIN, WMAX, WSIZE,
  isLand, isWater, isBeach, isSeaDeploy, rectDist, buildingStats, unitStats,
} from '../shared/config.js';

export const UNIT_CODES = ['raider', 'archer', 'brute', 'sapper', 'gunboat', 'frigate', 'battleship', 'guard'];
const CODE = Object.fromEntries(UNIT_CODES.map((t, i) => [t, i]));
const DEFENSES = new Set(['cannon', 'tower', 'mortar', 'battery', 'guardpost']);
const MAX_UNITS = 220;
const WALL_COST = 8;
const BUILDING_COST = 30;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const r1 = (v) => Math.round(v * 10) / 10;

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top[1];
  }
}

const coastDist = (b) => Math.min(b.x, b.y, GRID - (b.x + b.size), GRID - (b.y + b.size)) + 0.5;

export class Battle {
  constructor(defender, hooks) {
    this.defId = defender.id;
    this.defColor = defender.colorIdx;
    this.hooks = hooks;
    this.units = [];
    this.nextId = 1;
    this.events = [];
    this.changed = new Set();
    this.pending = [];
    this.over = false;
    this.killer = null;
    this.b = defender.buildings.map((src) => {
      const def = BUILDINGS[src.type];
      const size = def.size || 1;
      const st = buildingStats(src.type, src.level);
      return {
        id: src.id, type: src.type, x: src.x, y: src.y, level: src.level, size,
        cx: src.x + size / 2, cy: src.y + size / 2, st, hp: st.hp, maxHp: st.hp, alive: true,
        cd: Math.random(), trap: !!def.trap, armed: true, rearm: 0, revealed: false,
        guardsHome: st.guards, respawn: [],
      };
    });
    this.occ = new Array(GRID * GRID).fill(null);
    for (const b of this.b) {
      if (b.trap) continue;
      for (let dx = 0; dx < b.size; dx++) {
        for (let dy = 0; dy < b.size; dy++) {
          if (isLand(b.x + dx, b.y + dy)) this.occ[(b.y + dy) * GRID + b.x + dx] = b;
        }
      }
    }
    this.traps = this.b.filter((b) => b.trap);
    this.defenses = this.b.filter((b) => !b.trap && b.st.dmg > 0);
    this.posts = this.b.filter((b) => b.type === 'guardpost');
    this.command = this.b.find((b) => b.type === 'command');
    this.scored = this.b.filter((b) => !b.trap && b.type !== 'wall');
  }

  occAt(x, y) {
    if (!isLand(x, y)) return null;
    const b = this.occ[y * GRID + x];
    return b && b.alive ? b : null;
  }

  get commandPct() { return this.command ? Math.ceil((this.command.hp / this.command.maxHp) * 100) : 0; }
  get destroyedPct() {
    if (!this.scored.length) return 0;
    return Math.round((this.scored.filter((b) => !b.alive).length / this.scored.length) * 100);
  }

  // ---------- Deployment ----------
  deploy(owner, type, tx, ty, n) {
    const def = UNITS[type];
    if (!def || this.over) return 0;
    n = Math.min(n, MAX_UNITS - this.units.length);
    if (n <= 0) return 0;
    const valid = def.domain === 'land' ? isBeach : isSeaDeploy;
    let best = null, bd = Infinity;
    for (let y = WMIN; y <= WMAX; y++) {
      for (let x = WMIN; x <= WMAX; x++) {
        if (!valid(x, y)) continue;
        const d = (x + 0.5 - tx) ** 2 + (y + 0.5 - ty) ** 2;
        if (d < bd) { bd = d; best = [x, y]; }
      }
    }
    if (!best) return 0;
    const st = unitStats(type, owner.unitLevels[type] || 1);
    for (let i = 0; i < n; i++) {
      let px = best[0] + 0.5 + (Math.random() - 0.5) * 0.7;
      let py = best[1] + 0.5 + (Math.random() - 0.5) * 0.7;
      if (i >= 3) {
        const a = Math.random() * Math.PI * 2, r = 0.7 + Math.random() * 1.2;
        const nx = px + Math.cos(a) * r, ny = py + Math.sin(a) * r;
        if (valid(Math.floor(nx), Math.floor(ny))) { px = nx; py = ny; }
      }
      this.units.push({
        id: this.nextId++, owner: owner.id, color: owner.colorIdx, type, domain: def.domain, def, st,
        side: 'atk', x: px, y: py, hp: st.hp, maxHp: st.hp, cd: Math.random() * 0.6,
        target: null, path: null, repath: 0, act: 0,
      });
    }
    return n;
  }

  // ---------- Simulation ----------
  step(dt) {
    if (this.over) return;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (u.side === 'def') this.updateGuard(u, dt);
      else if (u.domain === 'land') this.updateLand(u, dt);
      else this.updateSea(u, dt);
    }
    if (this.over) return;
    this.updateDefenses(dt);
    this.updateTraps(dt);
    this.updatePosts(dt);
    this.updatePending(dt);
    this.separate();
    this.units = this.units.filter((u) => u.hp > 0);
  }

  damageUnit(u, dmg) {
    if (u.hp <= 0) return;
    u.hp -= dmg;
    if (u.hp > 0) return;
    u.hp = 0;
    this.events.push(['d', u.id, r1(u.x), r1(u.y)]);
    if (u.side === 'atk') this.hooks.onUnitKilled?.(this, u);
    else if (u.post) u.post.respawn.push(15);
  }

  damageBuilding(b, dmg, ownerId) {
    if (!b.alive || b.trap || this.over) return;
    b.hp -= dmg;
    this.changed.add(b);
    if (b.hp > 0) return;
    b.hp = 0;
    b.alive = false;
    this.events.push(['x', b.id]);
    this.hooks.onBuildingDestroyed?.(this, b, ownerId);
    if (b.type === 'command') { this.over = true; this.killer = ownerId; }
  }

  splashUnits(x, y, r, dmg, domain) {
    for (const u of this.units) {
      if (u.hp <= 0 || u.side !== 'atk' || u.domain !== domain) continue;
      if (Math.hypot(u.x - x, u.y - y) <= r) this.damageUnit(u, dmg);
    }
  }

  splashBuildings(x, y, r, dmg, ownerId, wallMult = 1) {
    for (const b of this.b) {
      if (!b.alive || b.trap) continue;
      if (rectDist(x, y, b) <= r) this.damageBuilding(b, dmg * (b.type === 'wall' ? wallMult : 1), ownerId);
    }
  }

  nearestUnit(x, y, r, filter) {
    let best = null, bd = r;
    for (const u of this.units) {
      if (u.hp <= 0 || !filter(u)) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d <= bd) { bd = d; best = u; }
    }
    return best;
  }

  moveToward(u, x, y, dt) {
    const dx = x - u.x, dy = y - u.y, d = Math.hypot(dx, dy);
    if (d < 0.01) return;
    const s = Math.min(u.st.speed * dt, d);
    u.x += (dx / d) * s;
    u.y += (dy / d) * s;
  }

  attackBuilding(u, b) {
    u.act = 1;
    if (u.cd > 0) return;
    u.cd = 1 / u.st.rate;
    if (u.def.suicide) {
      this.splashBuildings(u.x, u.y, u.st.splash, u.st.dmg, u.owner, u.st.wallMult);
      this.events.push(['b', r1(u.x), r1(u.y), u.st.splash]);
      u.hp = 0;
      return;
    }
    if (u.st.splash) {
      this.pending.push({ t: 0.9, x: b.cx, y: b.cy, r: u.st.splash, dmg: u.st.dmg, owner: u.owner, hits: 'buildings' });
      this.events.push(['m', r1(u.x), r1(u.y), r1(b.cx), r1(b.cy), 0.9]);
      return;
    }
    this.damageBuilding(b, u.st.dmg, u.owner);
    this.events.push(['u', u.id, r1(b.cx), r1(b.cy)]);
  }

  pickLandTarget(u) {
    const pref = u.def.prefer;
    let list = null;
    if (pref === 'wall') list = this.b.filter((b) => b.alive && b.type === 'wall');
    else if (pref === 'defense') list = this.b.filter((b) => b.alive && DEFENSES.has(b.type));
    if (!list || !list.length) list = this.b.filter((b) => b.alive && !b.trap && b.type !== 'wall');
    if (!list.length) list = this.b.filter((b) => b.alive && !b.trap);
    let best = null, bd = Infinity;
    for (const b of list) {
      const d = rectDist(u.x, u.y, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  tileCost(x, y, target) {
    const b = this.occAt(x, y);
    if (!b) return 1;
    if (b === target) return Infinity;
    return 1 + (b.type === 'wall' ? WALL_COST : BUILDING_COST);
  }

  // A* over land tiles. Walls and buildings are passable at a cost (troops smash through them).
  landPath(u, target) {
    const range = Math.max(u.st.range, 0.6);
    const sx = Math.min(GRID - 1, Math.max(0, Math.floor(u.x)));
    const sy = Math.min(GRID - 1, Math.max(0, Math.floor(u.y)));
    const N = GRID * GRID;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int16Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const h = (x, y) => Math.max(0, rectDist(x + 0.5, y + 0.5, target) - range);
    const heap = new Heap();
    const start = sy * GRID + sx;
    g[start] = 0;
    heap.push(h(sx, sy), start);
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % GRID, cy = (cur / GRID) | 0;
      if (rectDist(cx + 0.5, cy + 0.5, target) <= range) {
        const path = [];
        for (let i = cur; i !== start; i = came[i]) path.push([i % GRID, (i / GRID) | 0]);
        return path.reverse();
      }
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!isLand(nx, ny)) continue;
        const ni = ny * GRID + nx;
        if (closed[ni]) continue;
        const cost = this.tileCost(nx, ny, target);
        if (cost === Infinity) continue;
        const diag = dx !== 0 && dy !== 0;
        if (diag && (this.occAt(cx + dx, cy) || this.occAt(cx, cy + dy))) continue;
        const ng = g[cur] + cost * (diag ? 1.414 : 1);
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = cur;
          heap.push(ng + h(nx, ny), ni);
        }
      }
    }
    return null;
  }

  updateLand(u, dt) {
    u.cd -= dt;
    u.repath -= dt;
    u.act = 0;
    const st = u.st;
    if (!u.def.suicide) {
      const g = this.nearestUnit(u.x, u.y, Math.max(st.range, 1.2) + 0.3, (v) => v.side === 'def');
      if (g) {
        u.act = 1;
        if (u.cd <= 0) {
          u.cd = 1 / st.rate;
          this.damageUnit(g, st.dmg);
          this.events.push(['u', u.id, r1(g.x), r1(g.y)]);
        }
        return;
      }
    }
    if (!u.target || !u.target.alive) {
      u.target = this.pickLandTarget(u);
      u.path = null;
      if (!u.target) return;
    }
    const t = u.target;
    if (rectDist(u.x, u.y, t) <= st.range) { this.attackBuilding(u, t); return; }
    if (!u.path || u.repath <= 0) {
      u.path = this.landPath(u, t);
      u.repath = 2 + Math.random();
      if (!u.path) { u.target = null; return; }
    }
    while (u.path.length) {
      const [nx, ny] = u.path[0];
      const blk = this.occAt(nx, ny);
      if (blk && blk !== t && rectDist(u.x, u.y, blk) <= Math.max(st.range, 0.75)) {
        this.attackBuilding(u, blk);
        return;
      }
      const tx = nx + 0.5, ty = ny + 0.5;
      if (Math.hypot(tx - u.x, ty - u.y) < 0.08) { u.path.shift(); continue; }
      this.moveToward(u, tx, ty, dt);
      return;
    }
    // Path exhausted but still out of range: walk to the closest point of the target.
    const px = Math.max(t.x, Math.min(u.x, t.x + t.size));
    const py = Math.max(t.y, Math.min(u.y, t.y + t.size));
    this.moveToward(u, px, py, dt);
  }

  pickSeaTarget(u) {
    const reach = u.st.range - 0.3;
    let list = this.b.filter((b) => b.alive && !b.trap && b.type !== 'wall' && coastDist(b) <= reach);
    if (!list.length) list = this.b.filter((b) => b.alive && b.type === 'wall' && coastDist(b) <= reach);
    let best = null, bd = Infinity;
    for (const b of list) {
      const d = rectDist(u.x, u.y, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // Breadth-first search over water tiles to a spot within firing range.
  seaPath(u, t) {
    const idx = (x, y) => (x - WMIN) + (y - WMIN) * WSIZE;
    const sx = Math.min(WMAX, Math.max(WMIN, Math.floor(u.x)));
    const sy = Math.min(WMAX, Math.max(WMIN, Math.floor(u.y)));
    const prev = new Int32Array(WSIZE * WSIZE).fill(-2);
    const start = idx(sx, sy);
    prev[start] = -1;
    const q = [start];
    const range = u.st.range - 0.3;
    for (let head = 0; head < q.length; head++) {
      const cur = q[head];
      const cx = (cur % WSIZE) + WMIN, cy = Math.floor(cur / WSIZE) + WMIN;
      if (rectDist(cx + 0.5, cy + 0.5, t) <= range) {
        const path = [];
        for (let i = cur; i !== start; i = prev[i]) path.push([(i % WSIZE) + WMIN, Math.floor(i / WSIZE) + WMIN]);
        return path.reverse();
      }
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!isWater(nx, ny)) continue;
        if (dx && dy && (!isWater(cx + dx, cy) || !isWater(cx, cy + dy))) continue;
        const ni = idx(nx, ny);
        if (prev[ni] !== -2) continue;
        prev[ni] = cur;
        q.push(ni);
      }
    }
    return null;
  }

  updateSea(u, dt) {
    u.cd -= dt;
    u.repath -= dt;
    u.act = 0;
    if (!u.target || !u.target.alive) {
      u.target = this.pickSeaTarget(u);
      u.path = null;
      if (!u.target) return;
    }
    const t = u.target;
    if (rectDist(u.x, u.y, t) <= u.st.range) { this.attackBuilding(u, t); return; }
    if (!u.path || u.repath <= 0) {
      u.path = this.seaPath(u, t);
      u.repath = 3;
      if (!u.path) { u.target = null; return; }
    }
    while (u.path.length) {
      const [nx, ny] = u.path[0];
      const tx = nx + 0.5, ty = ny + 0.5;
      if (Math.hypot(tx - u.x, ty - u.y) < 0.1) { u.path.shift(); continue; }
      this.moveToward(u, tx, ty, dt);
      return;
    }
  }

  updateGuard(u, dt) {
    u.cd -= dt;
    u.act = 0;
    const p = u.post;
    const e = this.nearestUnit(u.x, u.y, 7, (v) => v.side === 'atk' && v.domain === 'land' && (!p || Math.hypot(v.x - p.cx, v.y - p.cy) < 8));
    if (e) {
      if (Math.hypot(e.x - u.x, e.y - u.y) <= u.st.range) {
        u.act = 1;
        if (u.cd <= 0) {
          u.cd = 1 / u.st.rate;
          this.damageUnit(e, u.st.dmg);
          this.events.push(['u', u.id, r1(e.x), r1(e.y)]);
        }
      } else this.moveToward(u, e.x, e.y, dt);
      return;
    }
    if (p && p.alive) {
      if (Math.hypot(p.cx - u.x, p.cy - u.y) < 0.9) { u.hp = 0; p.guardsHome++; return; }
      this.moveToward(u, p.cx, p.cy, dt);
    }
  }

  updateDefenses(dt) {
    for (const b of this.defenses) {
      if (!b.alive) continue;
      b.cd -= dt;
      if (b.cd > 0) continue;
      const st = b.st;
      let best = null, bd = Infinity;
      for (const u of this.units) {
        if (u.hp <= 0 || u.side !== 'atk' || !st.targets.includes(u.domain)) continue;
        const d = Math.hypot(u.x - b.cx, u.y - b.cy);
        if (d > st.range || d < st.minRange) continue;
        if (d < bd) { bd = d; best = u; }
      }
      if (!best) { b.cd = 0.2; continue; }
      b.cd = 1 / st.rate;
      if (b.type === 'mortar') {
        this.pending.push({ t: 1.1, x: best.x, y: best.y, r: st.splash, dmg: st.dmg, hits: 'land' });
        this.events.push(['m', r1(b.cx), r1(b.cy), r1(best.x), r1(best.y), 1.1]);
        continue;
      }
      if (st.splash) {
        this.splashUnits(best.x, best.y, st.splash, st.dmg, best.domain);
        this.events.push(['b', r1(best.x), r1(best.y), st.splash]);
      } else this.damageUnit(best, st.dmg);
      this.events.push(['s', b.id, r1(best.x), r1(best.y)]);
    }
  }

  updateTraps(dt) {
    for (const b of this.traps) {
      if (!b.alive) continue;
      if (!b.armed) {
        b.rearm -= dt;
        if (b.rearm <= 0) b.armed = true;
        continue;
      }
      const dom = b.st.targets[0];
      const u = this.nearestUnit(b.cx, b.cy, b.type === 'seamine' ? 0.9 : 0.65, (v) => v.side === 'atk' && v.domain === dom);
      if (!u) continue;
      b.revealed = true;
      this.events.push(['t', b.id, b.type, b.x, b.y]);
      if (b.type === 'spike') {
        this.damageUnit(u, b.st.dmg);
        b.armed = false;
        b.rearm = b.st.rearm;
      } else {
        this.splashUnits(b.cx, b.cy, b.st.splash, b.st.dmg, dom);
        this.events.push(['b', r1(b.cx), r1(b.cy), b.st.splash]);
        b.alive = false;
        b.hp = 0;
        this.changed.add(b);
      }
    }
  }

  updatePosts(dt) {
    for (const p of this.posts) {
      for (let i = p.respawn.length - 1; i >= 0; i--) {
        p.respawn[i] -= dt;
        if (p.respawn[i] <= 0) { p.respawn.splice(i, 1); p.guardsHome++; }
      }
      if (!p.alive || p.guardsHome <= 0) continue;
      if (!this.nearestUnit(p.cx, p.cy, p.st.trigger, (v) => v.side === 'atk' && v.domain === 'land')) continue;
      const st = unitStats('guard', p.level);
      for (let i = 0; i < p.guardsHome; i++) {
        const a = Math.random() * Math.PI * 2;
        this.units.push({
          id: this.nextId++, owner: this.defId, color: this.defColor, type: 'guard', domain: 'land', def: GUARD, st,
          side: 'def', post: p, x: p.cx + Math.cos(a) * 0.8, y: p.cy + Math.sin(a) * 0.8, hp: st.hp, maxHp: st.hp, cd: 0.3, act: 0,
        });
      }
      p.guardsHome = 0;
    }
  }

  updatePending(dt) {
    for (const s of this.pending) {
      s.t -= dt;
      if (s.t > 0) continue;
      if (s.hits === 'buildings') this.splashBuildings(s.x, s.y, s.r, s.dmg, s.owner);
      else this.splashUnits(s.x, s.y, s.r, s.dmg, s.hits);
      this.events.push(['b', r1(s.x), r1(s.y), s.r]);
    }
    this.pending = this.pending.filter((s) => s.t > 0);
  }

  // Keep units from stacking on one spot.
  separate() {
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i];
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j];
        if (b.hp <= 0 || (a.domain === 'sea') !== (b.domain === 'sea')) continue;
        const min = a.domain === 'sea' ? 0.7 : 0.32;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (min - d) / 2;
        const ux = d2 ? dx / d : Math.random() - 0.5, uy = d2 ? dy / d : Math.random() - 0.5;
        this.nudge(a, -ux * push, -uy * push);
        this.nudge(b, ux * push, uy * push);
      }
    }
  }

  nudge(u, dx, dy) {
    const nx = u.x + dx, ny = u.y + dy;
    const tx = Math.floor(nx), ty = Math.floor(ny);
    if (u.domain === 'sea') { if (!isWater(tx, ty)) return; }
    else if (!isLand(tx, ty) || (this.occAt(tx, ty) && this.occAt(tx, ty) !== this.occAt(Math.floor(u.x), Math.floor(u.y)))) return;
    u.x = nx;
    u.y = ny;
  }

  // Attacking units still alive, grouped by owner, so they can return home.
  takeSurvivors() {
    const out = {};
    for (const u of this.units) {
      if (u.side !== 'atk' || u.hp <= 0) continue;
      out[u.owner] ||= {};
      out[u.owner][u.type] = (out[u.owner][u.type] || 0) + 1;
    }
    this.units = this.units.filter((u) => u.side !== 'atk');
    return out;
  }

  snapshot(full) {
    const u = [];
    for (const x of this.units) {
      if (x.hp > 0) u.push([x.id, CODE[x.type], r1(x.x), r1(x.y), Math.ceil((x.hp / x.maxHp) * 100), x.color, x.act]);
    }
    const src = full ? this.b.filter((b) => !b.trap && (b.hp < b.maxHp || !b.alive)) : [...this.changed].filter((b) => !b.trap);
    const snap = {
      d: this.defId, full: full ? 1 : 0, u,
      b: src.map((x) => [x.id, Math.ceil((x.hp / x.maxHp) * 100), x.alive ? 1 : 0]),
      ev: full ? [] : this.events,
      cmd: this.commandPct, pct: this.destroyedPct,
    };
    if (full) snap.tr = this.traps.filter((t) => t.revealed).map((t) => [t.id, t.type, t.x, t.y, t.alive ? 1 : 0]);
    return snap;
  }

  flush() {
    const s = this.snapshot(false);
    this.events = [];
    this.changed.clear();
    return s;
  }
}
