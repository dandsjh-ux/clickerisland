// Procedural low-poly models. Each model is built from primitives, coloured per vertex and
// merged into a single geometry (one draw call), then cached by type/level/colour.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLAYER_COLORS } from '/shared/config.js';

export const WATER_Y = -0.75;

export const COL = {
  stone: 0x9aa3b2, stoneDark: 0x646c7a, gold: 0xf2b636, goldDark: 0xc98d1e, wood: 0xa8743f, woodDark: 0x6e4826,
  iron: 0x3a3f4a, ironLight: 0x6a7382, white: 0xf4f1e8, skin: 0xf1c7a0, red: 0xd84a3a, glow: 0x6fe0ff, sand: 0xe9d29a,
  black: 0x24272e, leaf: 0x3f9e4a, green: 0x3f8f4a, cream: 0xfff3cf, purple: 0xa87be0, steel: 0x6c8fc7,
};
const WALL_COLORS = [0xb07b44, 0xa3a9b5, 0xf2b636, 0x6c8fc7, 0xa87be0];

export const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
export const MAT_GHOST_OK = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, color: 0x9dff9d, depthWrite: false });
export const MAT_GHOST_BAD = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, color: 0xff7070, depthWrite: false });
export const MAT_HIDDEN = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false });

const prim = new Map();
function primitive(kind, a = 0, b = 0) {
  const key = `${kind}:${a}:${b}`;
  let g = prim.get(key);
  if (!g) {
    if (kind === 'box') g = new THREE.BoxGeometry(1, 1, 1);
    else if (kind === 'cyl') g = new THREE.CylinderGeometry(a, 1, 1, b);
    else if (kind === 'cone') g = new THREE.ConeGeometry(1, 1, a);
    else if (kind === 'sph') g = new THREE.SphereGeometry(1, a, b);
    prim.set(key, g);
  }
  return g;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

class Builder {
  constructor() { this.parts = []; }
  add(g0, color, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    const g = g0.clone();
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    _c.set(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
    return this;
  }
  // Box sitting on y (bottom at y).
  box(c, x, y, z, w, h, d, ry = 0) { return this.add(primitive('box'), c, x, y + h / 2, z, w, h, d, 0, ry, 0); }
  // Box centred at (x,y,z) with full rotation.
  boxR(c, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) { return this.add(primitive('box'), c, x, y, z, w, h, d, rx, ry, rz); }
  cyl(c, x, y, z, rt, rb, h, seg = 10) { return this.add(primitive('cyl', +(rt / rb).toFixed(2), seg), c, x, y + h / 2, z, rb, h, rb); }
  cylR(c, x, y, z, r, h, rx = 0, ry = 0, rz = 0, seg = 8) { return this.add(primitive('cyl', 1, seg), c, x, y, z, r, h, r, rx, ry, rz); }
  cone(c, x, y, z, r, h, seg = 4, ry = Math.PI / 4) { return this.add(primitive('cone', seg), c, x, y + h / 2, z, r, h, r, 0, ry, 0); }
  sph(c, x, y, z, r, seg = 8) { return this.add(primitive('sph', seg, Math.max(4, seg - 2)), c, x, y, z, r, r, r); }
  build() {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const teamColor = (idx) => new THREE.Color(PLAYER_COLORS[idx % PLAYER_COLORS.length]).getHex();
const lighten = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), k).getHex();

function levelPips(B, level, z, y = 0.02) {
  for (let i = 0; i < level; i++) B.sph(COL.gold, (i - (level - 1) / 2) * 0.1, y + 0.05, z, 0.04, 6);
}

// ---------- Buildings ----------
// Returns { main, turret?, spinner? } geometries. Coordinates are relative to the footprint centre.
const BUILDERS = {
  command(B, lv, tc) {
    B.box(COL.stoneDark, 0, 0, 0, 1.9, 0.22, 1.9);
    B.box(COL.gold, 0, 0.22, 0, 1.94, 0.07, 1.94);
    B.box(COL.cream, 0, 0.29, 0, 1.15, 0.85 + lv * 0.05, 1.15);
    B.cone(tc, 0, 1.14 + lv * 0.05, 0, 0.95, 0.7);
    B.box(COL.gold, 0, 1.12 + lv * 0.05, 0, 1.22, 0.06, 1.22);
    for (const [x, z] of [[-0.72, -0.72], [0.72, -0.72], [-0.72, 0.72], [0.72, 0.72]]) {
      B.cyl(COL.stone, x, 0.29, z, 0.2, 0.23, 1.0 + lv * 0.06, 8);
      B.cyl(COL.gold, x, 1.25 + lv * 0.06, z, 0.26, 0.26, 0.06, 8);
      B.cone(tc, x, 1.31 + lv * 0.06, z, 0.27, 0.42, 8, 0);
    }
    B.box(COL.woodDark, 0, 0.29, 0.58, 0.32, 0.45, 0.04);
    B.cyl(COL.white, 0, 1.6 + lv * 0.05, 0, 0.025, 0.025, 0.7, 5);
    B.box(tc, 0.18, 2.05 + lv * 0.05, 0, 0.34, 0.22, 0.03);
    levelPips(B, lv, 0.97, 0.24);
  },
  wall(B, lv, tc, mask) {
    const c = WALL_COLORS[lv - 1];
    const dark = new THREE.Color(c).multiplyScalar(0.75).getHex();
    B.box(c, 0, 0, 0, 0.34, 0.66, 0.34);
    B.box(dark, 0, 0.66, 0, 0.4, 0.09, 0.4);
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    dirs.forEach(([dx, dz], i) => {
      if (!(mask & (1 << i))) return;
      const horiz = dx !== 0;
      B.box(c, dx * 0.33, 0.12, dz * 0.33, horiz ? 0.36 : 0.2, 0.42, horiz ? 0.2 : 0.36);
      B.box(dark, dx * 0.33, 0.54, dz * 0.33, horiz ? 0.36 : 0.24, 0.06, horiz ? 0.24 : 0.36);
    });
  },
  cannon(B, lv, tc) {
    B.cyl(COL.stone, 0, 0, 0, 0.4, 0.44, 0.3, 10);
    B.cyl(COL.gold, 0, 0.3, 0, 0.42, 0.42, 0.06, 10);
    levelPips(B, lv, 0.36, 0.36);
  },
  cannon_turret(B, lv, tc) {
    B.sph(tc, 0, 0.55, 0, 0.24, 10);
    B.cylR(COL.iron, 0, 0.6, 0.3, 0.1 + lv * 0.01, 0.55, Math.PI / 2 - 0.15, 0, 0);
    B.cylR(COL.gold, 0, 0.64, 0.55, 0.13, 0.07, Math.PI / 2 - 0.15, 0, 0);
  },
  tower(B, lv, tc) {
    const h = 0.85 + lv * 0.06;
    for (const [x, z] of [[-0.27, -0.27], [0.27, -0.27], [-0.27, 0.27], [0.27, 0.27]]) B.box(COL.wood, x, 0, z, 0.09, h, 0.09);
    B.box(COL.woodDark, 0, h * 0.45, 0, 0.62, 0.05, 0.62);
    B.box(COL.wood, 0, h, 0, 0.74, 0.1, 0.74);
    B.box(COL.cream, 0, h + 0.1, 0, 0.5, 0.32, 0.5);
    B.box(COL.gold, 0, h + 0.42, 0, 0.6, 0.05, 0.6);
    B.cone(tc, 0, h + 0.47, 0, 0.5, 0.42);
    levelPips(B, lv, 0.42);
  },
  mortar(B, lv, tc) {
    B.cyl(COL.sand, 0, 0, 0, 0.4, 0.44, 0.24, 10);
    B.cyl(COL.stoneDark, 0, 0.24, 0, 0.3, 0.3, 0.04, 10);
    B.cylR(COL.iron, 0, 0.42, 0.04, 0.17 + lv * 0.01, 0.42, 0.45, 0, 0, 10);
    B.cylR(COL.gold, 0, 0.6, 0.12, 0.2, 0.06, 0.45, 0, 0, 10);
    B.cylR(tc, 0, 0.33, -0.05, 0.19, 0.08, 0.45, 0, 0, 10);
    levelPips(B, lv, 0.44);
  },
  battery(B, lv, tc) {
    B.box(COL.stone, 0, 0, 0, 0.86, 0.36, 0.86);
    B.box(COL.gold, 0, 0.36, 0, 0.9, 0.05, 0.9);
    B.box(tc, 0, 0.18, 0.44, 0.6, 0.08, 0.02);
    levelPips(B, lv, 0.46);
  },
  battery_turret(B, lv, tc) {
    B.box(COL.stoneDark, 0, 0.41, 0, 0.46, 0.26, 0.5);
    B.cylR(COL.iron, -0.09, 0.56, 0.42, 0.06, 0.62, Math.PI / 2, 0, 0);
    B.cylR(COL.iron, 0.09, 0.56, 0.42, 0.06, 0.62, Math.PI / 2, 0, 0);
    B.box(tc, 0, 0.67, 0, 0.3, 0.04, 0.3);
  },
  guardpost(B, lv, tc) {
    B.box(COL.stoneDark, 0, 0, 0, 0.8, 0.1, 0.8);
    B.box(COL.wood, 0, 0.1, 0, 0.66, 0.46, 0.66);
    B.box(COL.gold, 0, 0.56, 0, 0.72, 0.05, 0.72);
    B.cone(tc, 0, 0.61, 0, 0.56, 0.42);
    B.cylR(COL.gold, 0, 0.36, 0.35, 0.15, 0.04, Math.PI / 2, 0, 0, 10);
    B.cylR(tc, 0, 0.36, 0.37, 0.09, 0.02, Math.PI / 2, 0, 0, 10);
    B.box(COL.woodDark, -0.38, 0.1, 0.38, 0.04, 0.75, 0.04);
    B.cone(COL.ironLight, -0.38, 0.85, 0.38, 0.05, 0.14, 4, 0);
    levelPips(B, lv, 0.42);
  },
  spike(B) {
    B.box(COL.stoneDark, 0, 0, 0, 0.66, 0.04, 0.66);
    for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18], [0, 0]]) B.cone(COL.ironLight, x, 0.04, z, 0.07, 0.2, 4, 0);
  },
  bomb(B) {
    B.sph(COL.black, 0, 0.16, 0, 0.17, 10);
    B.cyl(COL.wood, 0.05, 0.3, 0, 0.02, 0.02, 0.1, 4);
    B.sph(COL.red, 0.05, 0.42, 0, 0.035, 5);
  },
  seamine(B) {
    B.sph(COL.iron, 0, 0.05, 0, 0.24, 10);
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) B.cylR(COL.ironLight, x * 0.26, 0.05 + y * 0.26, z * 0.26, 0.03, 0.12, z ? Math.PI / 2 : 0, 0, x ? Math.PI / 2 : 0, 5);
    B.cyl(COL.red, 0, 0.3, 0, 0.04, 0.04, 0.04, 6);
  },
  mint(B, lv, tc) {
    B.box(COL.stoneDark, 0, 0, 0, 0.8, 0.1, 0.8);
    B.box(COL.cream, 0, 0.1, 0, 0.62, 0.42, 0.62);
    B.box(COL.goldDark, 0, 0.1, 0.32, 0.22, 0.28, 0.02);
    B.box(COL.gold, 0, 0.52, 0, 0.7, 0.06, 0.7);
    B.cone(COL.gold, 0, 0.58, 0, 0.5, 0.26);
    B.box(tc, 0, 0.3, -0.32, 0.4, 0.06, 0.02);
    levelPips(B, lv, 0.42);
  },
  mint_spinner(B) {
    B.cylR(COL.gold, 0, 0, 0, 0.2, 0.05, Math.PI / 2, 0, 0, 14);
    B.cylR(COL.goldDark, 0, 0, 0, 0.12, 0.06, Math.PI / 2, 0, 0, 14);
  },
  barracks(B, lv, tc) {
    B.box(COL.stoneDark, 0, 0, 0, 0.86, 0.1, 0.8);
    B.box(COL.cream, 0, 0.1, 0, 0.78, 0.36, 0.62);
    B.add(primitive('cyl', 1, 3), tc, 0, 0.66, 0, 0.44, 0.7, 0.44, -Math.PI / 2, 0, 0);
    B.box(COL.woodDark, 0, 0.1, 0.31, 0.2, 0.26, 0.03);
    B.cyl(COL.white, 0.36, 0.1, 0.36, 0.02, 0.02, 0.9, 5);
    B.box(tc, 0.48, 0.82, 0.36, 0.22, 0.14, 0.02);
    levelPips(B, lv, 0.42);
  },
  shipyard(B, lv, tc) {
    B.box(COL.wood, 0, 0, 0, 0.9, 0.12, 0.9);
    for (let i = -2; i <= 2; i++) B.box(COL.woodDark, i * 0.18, 0.12, 0, 0.02, 0.01, 0.88);
    B.box(COL.woodDark, -0.32, 0.12, -0.32, 0.08, 0.95, 0.08);
    B.box(COL.woodDark, -0.05, 1.0, -0.32, 0.62, 0.07, 0.07);
    B.cyl(COL.ironLight, 0.22, 0.55, -0.32, 0.01, 0.01, 0.45, 4);
    B.box(tc, 0.12, 0.12, 0.12, 0.3, 0.16, 0.56);
    B.cone(tc, 0.12, 0.12, 0.42, 0.15, 0.16, 4);
    B.box(COL.white, 0.12, 0.28, 0.08, 0.16, 0.12, 0.18);
    levelPips(B, lv, 0.44, 0.12);
  },
  library(B, lv, tc) {
    B.cyl(COL.gold, 0, 0, 0, 0.44, 0.46, 0.06, 16);
    B.cyl(COL.glow, 0, 0.06, 0, 0.38, 0.38, 0.03, 16);
    B.boxR(COL.steel, -0.17, 0.42, 0, 0.32, 0.03, 0.46, 0, 0, 0.35);
    B.boxR(COL.steel, 0.17, 0.42, 0, 0.32, 0.03, 0.46, 0, 0, -0.35);
    B.boxR(COL.white, -0.16, 0.45, 0, 0.29, 0.03, 0.42, 0, 0, 0.35);
    B.boxR(COL.white, 0.16, 0.45, 0, 0.29, 0.03, 0.42, 0, 0, -0.35);
    B.box(tc, 0, 0.3, 0, 0.04, 0.1, 0.46);
    levelPips(B, lv, 0.42, 0.06);
  },
};

const geoCache = new Map();
function cachedGeo(key, fn) {
  let g = geoCache.get(key);
  if (!g) {
    const B = new Builder();
    fn(B);
    g = B.build();
    geoCache.set(key, g);
  }
  return g;
}

const BUILDING_HEIGHT = { command: 2.2, wall: 0.75, cannon: 0.9, tower: 1.7, mortar: 0.8, battery: 0.9, guardpost: 1.1, spike: 0.3, bomb: 0.5, seamine: 0.4, mint: 1.2, barracks: 1.0, shipyard: 1.1, library: 0.7 };
export const buildingHeight = (type) => BUILDING_HEIGHT[type] || 1;

export function createBuilding(type, level, colorIdx, wallMask = 0, material = MAT) {
  const tc = teamColor(colorIdx);
  const group = new THREE.Group();
  const key = `${type}:${level}:${colorIdx}:${wallMask}`;
  const main = new THREE.Mesh(cachedGeo(key, (B) => BUILDERS[type](B, level, tc, wallMask)), material);
  main.castShadow = true;
  main.receiveShadow = true;
  group.add(main);
  if (BUILDERS[`${type}_turret`]) {
    const t = new THREE.Mesh(cachedGeo(`${key}:t`, (B) => BUILDERS[`${type}_turret`](B, level, tc)), material);
    t.castShadow = true;
    t.rotation.y = Math.random() * Math.PI * 2;
    group.add(t);
    group.userData.turret = t;
  }
  if (type === 'mint') {
    const s = new THREE.Mesh(cachedGeo('mint_spinner', (B) => BUILDERS.mint_spinner(B)), material);
    s.position.y = 1.05;
    group.add(s);
    group.userData.spinner = s;
  }
  return group;
}

// ---------- Units ----------
const UNIT_BUILDERS = {
  raider(B, tc) {
    B.cyl(tc, 0, 0, 0, 0.09, 0.11, 0.22, 8);
    B.sph(COL.skin, 0, 0.3, 0, 0.08, 8);
    B.cone(COL.ironLight, 0, 0.33, 0, 0.09, 0.1, 8, 0);
    B.box(COL.white, 0.12, 0.08, 0.06, 0.03, 0.22, 0.03);
    B.box(COL.gold, 0.12, 0.12, 0.06, 0.08, 0.02, 0.03);
  },
  archer(B, tc) {
    B.cyl(COL.green, 0, 0, 0, 0.08, 0.1, 0.22, 8);
    B.boxR(tc, 0, 0.13, 0, 0.21, 0.04, 0.21, 0, 0, 0.5);
    B.sph(COL.skin, 0, 0.29, 0, 0.075, 8);
    B.cone(COL.green, 0, 0.33, 0, 0.09, 0.14, 6, 0);
    B.boxR(COL.wood, 0.12, 0.17, 0.05, 0.025, 0.3, 0.025, 0, 0, 0);
  },
  brute(B, tc) {
    B.box(tc, 0, 0, 0, 0.3, 0.34, 0.24);
    B.box(COL.skin, -0.21, 0.08, 0, 0.1, 0.24, 0.1);
    B.box(COL.skin, 0.21, 0.08, 0, 0.1, 0.24, 0.1);
    B.sph(COL.skin, 0, 0.44, 0, 0.11, 8);
    B.box(COL.woodDark, 0.25, 0.1, 0.12, 0.07, 0.07, 0.4);
    B.box(COL.gold, 0, 0.3, 0, 0.32, 0.04, 0.26);
  },
  sapper(B, tc) {
    B.cyl(tc, 0, 0, 0, 0.08, 0.1, 0.2, 8);
    B.sph(COL.skin, 0, 0.27, 0, 0.07, 8);
    B.sph(COL.black, 0, 0.17, -0.12, 0.1, 8);
    B.cyl(COL.red, 0, 0.26, -0.12, 0.02, 0.02, 0.08, 4);
  },
  guard(B, tc) {
    B.cyl(tc, 0, 0, 0, 0.09, 0.11, 0.24, 8);
    B.sph(COL.skin, 0, 0.32, 0, 0.08, 8);
    B.cyl(COL.gold, 0, 0.37, 0, 0.09, 0.09, 0.05, 8);
    B.cylR(COL.gold, 0, 0.14, 0.12, 0.1, 0.03, Math.PI / 2, 0, 0, 8);
    B.box(COL.woodDark, 0.13, 0, 0, 0.025, 0.5, 0.025);
    B.cone(COL.ironLight, 0.13, 0.5, 0, 0.035, 0.1, 4, 0);
  },
  gunboat(B, tc) {
    B.box(tc, 0, 0, -0.05, 0.3, 0.12, 0.5);
    B.cone(tc, 0, 0, 0.3, 0.15, 0.12, 4);
    B.box(COL.white, 0, 0.12, -0.1, 0.18, 0.12, 0.18);
    B.cylR(COL.iron, 0, 0.17, 0.15, 0.03, 0.22, Math.PI / 2, 0, 0, 6);
  },
  frigate(B, tc) {
    B.box(COL.wood, 0, 0, 0, 0.38, 0.16, 0.8);
    B.cone(COL.wood, 0, 0, 0.48, 0.19, 0.16, 4);
    B.box(tc, 0, 0.16, 0, 0.4, 0.04, 0.82);
    B.cyl(COL.woodDark, 0, 0.16, 0.05, 0.025, 0.03, 0.9, 5);
    B.boxR(COL.white, 0, 0.62, 0.05, 0.44, 0.34, 0.03, 0, 0, 0);
    B.boxR(tc, 0, 0.84, 0.05, 0.3, 0.08, 0.035, 0, 0, 0);
    B.boxR(COL.white, 0, 0.45, 0.32, 0.03, 0.26, 0.24, 0, 0, 0);
  },
  battleship(B, tc) {
    B.box(COL.ironLight, 0, 0, 0, 0.5, 0.22, 1.1);
    B.cone(COL.ironLight, 0, 0, 0.65, 0.25, 0.22, 4);
    B.box(tc, 0, 0.22, 0, 0.52, 0.04, 1.12);
    B.box(COL.stone, 0, 0.26, -0.15, 0.3, 0.24, 0.3);
    B.cyl(tc, 0, 0.5, -0.2, 0.06, 0.07, 0.25, 8);
    B.box(COL.iron, 0, 0.26, 0.3, 0.22, 0.12, 0.22);
    B.cylR(COL.iron, 0, 0.33, 0.48, 0.035, 0.3, Math.PI / 2, 0, 0, 6);
    B.box(COL.iron, 0, 0.26, -0.45, 0.2, 0.1, 0.18);
  },
};

export function createUnit(type, colorIdx) {
  const tc = teamColor(colorIdx);
  const g = cachedGeo(`u:${type}:${colorIdx}`, (B) => UNIT_BUILDERS[type](B, tc));
  const m = new THREE.Mesh(g, MAT);
  m.castShadow = true;
  m.scale.setScalar(type === 'brute' ? 1.35 : ['gunboat', 'frigate', 'battleship'].includes(type) ? 1.3 : 1.55);
  return m;
}

// ---------- Scenery ----------
export function createTree(scale = 1) {
  const g = cachedGeo('tree', (B) => {
    B.cyl(COL.woodDark, 0, 0, 0, 0.06, 0.08, 0.4, 6);
    B.cone(COL.leaf, 0, 0.3, 0, 0.32, 0.5, 7, 0);
    B.cone(lighten(COL.leaf, 0.12), 0, 0.6, 0, 0.25, 0.42, 7, 0);
    B.cone(lighten(COL.leaf, 0.2), 0, 0.85, 0, 0.16, 0.34, 7, 0);
  });
  const m = new THREE.Mesh(g, MAT);
  m.castShadow = true;
  m.scale.setScalar(scale);
  return m;
}

export function createPalm(scale = 1) {
  const g = cachedGeo('palm', (B) => {
    for (let i = 0; i < 5; i++) B.cylR(COL.wood, i * 0.025, 0.1 + i * 0.18, 0, 0.05 - i * 0.004, 0.2, 0, 0, -0.12, 6);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      B.boxR(COL.leaf, 0.12 + Math.cos(a) * 0.22, 0.98, Math.sin(a) * 0.22, 0.42, 0.03, 0.12, 0, -a, -0.35);
    }
    B.sph(COL.woodDark, 0.12, 0.92, 0.05, 0.05, 5);
  });
  const m = new THREE.Mesh(g, MAT);
  m.castShadow = true;
  m.scale.setScalar(scale);
  return m;
}

export function createRock(scale = 1) {
  const g = cachedGeo('rock', (B) => {
    B.sph(COL.stoneDark, 0, 0.1, 0, 0.35, 5);
    B.sph(COL.stone, 0.22, 0.05, 0.1, 0.22, 5);
  });
  const m = new THREE.Mesh(g, MAT);
  m.scale.setScalar(scale);
  return m;
}
