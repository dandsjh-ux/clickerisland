// Shared game rules for Clicker Island Wars.
// Imported by the Node server and served to the browser at /shared/config.js.

// ---------- Island geometry (tile coordinates) ----------
// Land is GRID x GRID tiles. The outer ring of land is beach (no building, land troops deploy there).
// Water surrounds the island WATER tiles deep; the outer water band is where warships deploy.
export const GRID = 18;
export const WATER = 7;
export const WMIN = -WATER;
export const WMAX = GRID + WATER - 1;
export const WSIZE = WMAX - WMIN + 1;

export const isLand = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID;
export const isBeach = (x, y) => isLand(x, y) && (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1);
export const isBuildable = (x, y) => x >= 1 && y >= 1 && x <= GRID - 2 && y <= GRID - 2;
export const inWorld = (x, y) => x >= WMIN && y >= WMIN && x <= WMAX && y <= WMAX;
export const isWater = (x, y) => inWorld(x, y) && !isLand(x, y);
export const isShallow = (x, y) => isWater(x, y) && x >= -2 && y >= -2 && x <= GRID + 1 && y <= GRID + 1;
export const isSeaDeploy = (x, y) => isWater(x, y) && (x < -3 || y < -3 || x > GRID + 2 || y > GRID + 2);

// Distance from point (px,py) to the footprint rectangle of a building.
export function rectDist(px, py, b) {
  const s = b.size || 1;
  const dx = Math.max(b.x - px, 0, px - (b.x + s));
  const dy = Math.max(b.y - py, 0, py - (b.y + s));
  return Math.hypot(dx, dy);
}

export const PLAYER_COLORS = ['#3c7fd8', '#e04848', '#3fb950', '#a55ee0', '#f0883e', '#1fb5b5'];
export const MAX_LEVEL = 5;

// ---------- Buildings ----------
export const BUILDINGS = {
  command:   { name: 'Central Command', icon: '🏰', cat: 'core', size: 2, cost: 1000, hp: 3000, dmg: 24, rate: 1.0, range: 5, targets: ['land', 'sea'],
               desc: 'Your headquarters, with a small built-in cannon. If it is destroyed you are out! Upgrade it to unlock more buildings and higher levels.' },
  mint:      { name: 'Coin Mint', icon: '🪙', cat: 'economy', cost: 200, hp: 450, income: 1, store: 150,
               desc: 'Mints coins every second. Tap it to collect what it has stored.' },
  library:   { name: 'Island Library', icon: '📘', cat: 'economy', cost: 400, hp: 500, quizBonus: 0.15,
               desc: 'Boosts coins earned from quiz answers by 15% per level.' },
  barracks:  { name: 'Barracks', icon: '⛺', cat: 'army', cost: 300, hp: 650, landCap: 12,
               desc: 'Houses land troops. Higher levels add space and allow stronger troop upgrades.' },
  shipyard:  { name: 'Shipyard', icon: '⚓', cat: 'army', cost: 350, hp: 650, seaCap: 8,
               desc: 'Docks warships. Higher levels add space and allow stronger ship upgrades.' },
  wall:      { name: 'Wall', icon: '🧱', cat: 'defense', cost: 25, hp: 450,
               desc: 'Blocks land troops. They must smash through or find a way around.' },
  cannon:    { name: 'Cannon', icon: '💣', cat: 'defense', cost: 250, hp: 650, dmg: 34, rate: 1.0, range: 5.5, targets: ['land', 'sea'],
               desc: 'Sturdy all-rounder. Fires at troops and ships.' },
  tower:     { name: 'Archer Tower', icon: '🏹', cat: 'defense', cost: 300, hp: 520, dmg: 15, rate: 2.0, range: 6.5, targets: ['land', 'sea'],
               desc: 'Fast arrows with long reach. Hits troops and ships.' },
  mortar:    { name: 'Mortar', icon: '🎯', cat: 'defense', cost: 550, hp: 600, dmg: 48, rate: 0.35, range: 8, minRange: 2.5, splash: 1.4, targets: ['land'],
               desc: 'Lobs explosive shells that splash groups of land troops. Cannot hit close targets.' },
  battery:   { name: 'Coastal Battery', icon: '🗼', cat: 'defense', cost: 450, hp: 750, dmg: 75, rate: 0.5, range: 9.5, splash: 0.8, targets: ['sea'],
               desc: 'Heavy guns that only target ships, from very long range.' },
  guardpost: { name: 'Guard Post', icon: '💂', cat: 'defense', cost: 450, hp: 650, guards: 2, trigger: 6,
               desc: 'Sends island guards out to fight land invaders. Guards return and respawn.' },
  spike:     { name: 'Spike Trap', icon: '📌', cat: 'trap', cost: 60, hp: 1, dmg: 90, rearm: 3, trap: true, targets: ['land'],
               desc: 'Hidden spikes stab land troops. Re-arms after 3 seconds.' },
  bomb:      { name: 'Bomb Trap', icon: '💥', cat: 'trap', cost: 120, hp: 1, dmg: 260, splash: 1.6, trap: true, once: true, targets: ['land'],
               desc: 'Hidden bomb that blasts a group of land troops once.' },
  seamine:   { name: 'Sea Mine', icon: '🌀', cat: 'trap', cost: 150, hp: 1, dmg: 450, splash: 1.8, trap: true, once: true, water: true, targets: ['sea'],
               desc: 'Hidden mine in the shallows. Blows up warships once. Place it in the water near your beach.' },
};

// How many of each building you may own, by Central Command level (index 0 = level 1).
export const LIMITS = {
  mint:      [2, 3, 4, 5, 6],
  library:   [1, 1, 1, 1, 1],
  barracks:  [1, 2, 2, 3, 3],
  shipyard:  [1, 1, 2, 2, 3],
  wall:      [24, 36, 50, 66, 84],
  cannon:    [2, 3, 4, 5, 6],
  tower:     [1, 2, 3, 4, 5],
  mortar:    [0, 1, 2, 2, 3],
  battery:   [1, 1, 2, 3, 3],
  guardpost: [1, 1, 2, 2, 3],
  spike:     [2, 4, 6, 8, 10],
  bomb:      [1, 2, 3, 4, 6],
  seamine:   [2, 3, 4, 6, 8],
};

const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);

export const COMMAND_UPGRADE = [0, 1500, 3500, 7000, 12000]; // cost to go from level i to i+1

export function upgradeCost(type, level) {
  if (type === 'command') return COMMAND_UPGRADE[level] || Infinity;
  return round5(BUILDINGS[type].cost * Math.pow(1.75, level));
}

export function buildingStats(type, level) {
  const d = BUILDINGS[type];
  const k = level - 1;
  return {
    hp: Math.round(d.hp * (1 + 0.35 * k)),
    dmg: d.dmg ? Math.round(d.dmg * (1 + 0.3 * k)) : 0,
    rate: d.rate || 0,
    range: d.range ? d.range + 0.25 * k : 0,
    minRange: d.minRange || 0,
    splash: d.splash || 0,
    targets: d.targets || [],
    income: d.income ? d.income * level : 0,
    store: d.store ? d.store * level : 0,
    landCap: d.landCap ? d.landCap + 6 * k : 0,
    seaCap: d.seaCap ? d.seaCap + 4 * k : 0,
    quizBonus: d.quizBonus ? d.quizBonus * level : 0,
    guards: d.guards ? 1 + level : 0,
    trigger: d.trigger || 0,
    rearm: d.rearm || 0,
  };
}

// ---------- Units ----------
export const UNITS = {
  raider:     { name: 'Raider', icon: '🗡️', domain: 'land', cost: 25, space: 1, hp: 150, dmg: 16, rate: 1.0, range: 0.9, speed: 1.7, prefer: 'any',
                desc: 'Cheap, brave melee fighters. Attack the nearest building.' },
  archer:     { name: 'Archer', icon: '🏹', domain: 'land', cost: 40, space: 1, hp: 85, dmg: 14, rate: 1.1, range: 3.5, speed: 1.6, prefer: 'any',
                desc: 'Shoot over walls from range. Fragile.' },
  brute:      { name: 'Brute', icon: '🪨', domain: 'land', cost: 160, space: 5, hp: 950, dmg: 36, rate: 0.8, range: 0.9, speed: 1.0, prefer: 'defense',
                desc: 'Huge tank that marches straight for defences.' },
  sapper:     { name: 'Sapper', icon: '🧨', domain: 'land', cost: 70, space: 2, hp: 75, dmg: 70, wallMult: 8, splash: 1.3, rate: 1, range: 0.7, speed: 2.3, prefer: 'wall', suicide: true,
                desc: 'Runs at walls and explodes, dealing massive wall damage.' },
  gunboat:    { name: 'Gunboat', icon: '🚤', domain: 'sea', cost: 70, space: 2, hp: 280, dmg: 20, rate: 1.2, range: 4.5, speed: 2.2, prefer: 'any',
                desc: 'Fast little boat that shells coastal buildings.' },
  frigate:    { name: 'Frigate', icon: '⛵', domain: 'sea', cost: 170, space: 4, hp: 650, dmg: 40, rate: 0.9, range: 5.5, speed: 1.5, prefer: 'any',
                desc: 'Balanced warship with solid cannons.' },
  battleship: { name: 'Battleship', icon: '🚢', domain: 'sea', cost: 380, space: 8, hp: 1500, dmg: 85, rate: 0.5, range: 7, splash: 1.0, speed: 0.9, prefer: 'any',
                desc: 'Slow floating fortress. Long-range splash shells reach deep inland.' },
};
export const UNIT_TYPES = Object.keys(UNITS);
export const GUARD = { name: 'Guard', hp: 200, dmg: 18, rate: 1.0, range: 0.9, speed: 1.9 };

export function unitStats(type, level) {
  const d = type === 'guard' ? GUARD : UNITS[type];
  const k = level - 1;
  return {
    hp: Math.round(d.hp * (1 + 0.25 * k)),
    dmg: Math.round(d.dmg * (1 + 0.25 * k)),
    rate: d.rate || 1,
    range: d.range,
    speed: d.speed,
    splash: d.splash || 0,
    wallMult: d.wallMult || 1,
  };
}

export const unitUpgradeCost = (type, level) => round5(UNITS[type].cost * 6 * Math.pow(1.7, level - 1));

// ---------- Economy ----------
export const QUIZ_YEARS = [3, 4, 5, 6, 7];
export const QUIZ_REWARD = { 3: 40, 4: 60, 5: 85, 6: 115, 7: 150 };
export const STREAK_BONUS = 0.1;   // +10% per correct answer in a row
export const STREAK_MAX = 5;       // up to +50%
export const WRONG_COOLDOWN_MS = 2500;

export const TAP_MAX_LEVEL = 10;
export const tapUpgradeCost = (level) => round5(80 * Math.pow(1.7, level - 1));
export const MAX_TAPS_PER_SEC = 15;

export const lootValue = (type, level) => type === 'command' ? 1500 : Math.round(Math.max(20, BUILDINGS[type].cost) * 0.4 * level);
export const bountyValue = (type) => Math.round(UNITS[type].cost * 0.3);

export const START = {
  coins: 400,
  army: { raider: 8, archer: 4, gunboat: 2 },
  buildings: [
    { type: 'command', x: 8, y: 8 },
    { type: 'cannon', x: 6, y: 7 },
    { type: 'barracks', x: 4, y: 12 },
    { type: 'shipyard', x: 13, y: 4 },
    { type: 'mint', x: 12, y: 12 },
  ],
};

export const DEFAULT_SETTINGS = { buildMin: 10, pvpMin: 3, rounds: 3, maxPlayers: 4 };
export const SETTING_OPTIONS = {
  buildMin: [1, 2, 3, 5, 8, 10, 15],
  pvpMin: [1, 2, 3, 4, 5],
  rounds: [1, 2, 3, 4, 5],
  maxPlayers: [2, 3, 4, 5, 6],
};
