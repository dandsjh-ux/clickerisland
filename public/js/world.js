// three.js scene: island terrain, water, buildings, battle units, effects, camera and picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as C from '/shared/config.js';
import * as M from './models.js';

const HALF = C.GRID / 2;
const UNIT_TYPES = ['raider', 'archer', 'brute', 'sapper', 'gunboat', 'frigate', 'battleship', 'guard'];
const SEA = new Set(['gunboat', 'frigate', 'battleship']);
const RANGED = new Set(['archer', 'gunboat', 'frigate']);

const wx = (tx) => tx - HALF;
const wz = (ty) => ty - HALF;

// Shared effect resources
const GEO = {
  ball: new THREE.SphereGeometry(0.07, 6, 4),
  bigBall: new THREE.SphereGeometry(0.11, 6, 4),
  arrow: new THREE.BoxGeometry(0.025, 0.025, 0.32),
  blast: new THREE.SphereGeometry(1, 12, 8),
  chunk: new THREE.BoxGeometry(0.09, 0.09, 0.09),
  ring: new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2),
  disc: new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
};
const FXMAT = {
  ball: new THREE.MeshBasicMaterial({ color: 0x222222 }),
  arrow: new THREE.MeshBasicMaterial({ color: 0x6e4826 }),
  shell: new THREE.MeshBasicMaterial({ color: 0x111111 }),
  chunk: new THREE.MeshLambertMaterial({ color: 0x7a6a58 }),
  spark: new THREE.MeshBasicMaterial({ color: 0xffe08a }),
};
const BAR = {
  bg: new THREE.SpriteMaterial({ color: 0x111111, depthTest: false, depthWrite: false, transparent: true, opacity: 0.75 }),
  green: new THREE.SpriteMaterial({ color: 0x4ade80, depthTest: false, depthWrite: false }),
  yellow: new THREE.SpriteMaterial({ color: 0xfacc15, depthTest: false, depthWrite: false }),
  red: new THREE.SpriteMaterial({ color: 0xef4444, depthTest: false, depthWrite: false }),
};

function emojiTexture(emoji, bg) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#fff';
  g.stroke();
  g.font = '72px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeBar(width) {
  const g = new THREE.Group();
  const bg = new THREE.Sprite(BAR.bg);
  bg.scale.set(width + 0.04, 0.11, 1);
  const fg = new THREE.Sprite(BAR.green);
  fg.scale.set(width, 0.07, 1);
  bg.renderOrder = 10;
  fg.renderOrder = 11;
  g.add(bg, fg);
  g.userData = { fg, width };
  return g;
}

function setBar(bar, pct) {
  const { fg, width } = bar.userData;
  const k = Math.max(0.01, pct / 100);
  fg.scale.x = width * k;
  fg.center.x = 0.5 / k;
  fg.material = pct > 60 ? BAR.green : pct > 30 ? BAR.yellow : BAR.red;
}

const WATER_VERT = `
uniform float uTime;
varying vec2 vXZ;
varying float vH;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float h = sin(wp.x * 0.55 + uTime * 1.1) * 0.05 + cos(wp.z * 0.47 + uTime * 0.9) * 0.05 + sin((wp.x + wp.z) * 1.3 + uTime * 2.0) * 0.02;
  wp.y += h;
  vH = h;
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const WATER_FRAG = `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
varying vec2 vXZ;
varying float vH;
void main() {
  float d = max(abs(vXZ.x), abs(vXZ.y)) - 9.15;
  float sh = smoothstep(5.0, 0.0, d);
  vec3 col = mix(uDeep, uShallow, sh * 0.85);
  float wob = sin(uTime * 1.8 + vXZ.x * 1.7 + vXZ.y * 1.3) * 0.12;
  float foam = smoothstep(0.55, 0.0, d + wob) * step(-0.3, d);
  float ring2 = smoothstep(0.12, 0.0, abs(d - 1.2 - sin(uTime * 0.8) * 0.35)) * 0.35;
  col = mix(col, uFoam, clamp(foam * 0.85 + ring2, 0.0, 1.0));
  col += vH * 0.9;
  float far = smoothstep(30.0, 70.0, length(vXZ));
  col = mix(col, uDeep * 0.85, far);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class World {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
    this.mobile = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.mobile || devicePixelRatio < 2, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.mobile ? 1.75 : 2));
    this.renderer.shadowMap.enabled = !this.mobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ad8f5);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.12, screenSpacePanning: false,
      minDistance: 9, maxDistance: 62, minPolarAngle: 0.2, maxPolarAngle: 1.2, zoomSpeed: 1.1, rotateSpeed: 0.6,
    });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.resetCamera();

    const hemi = new THREE.HemisphereLight(0xdff3ff, 0x5b7d3a, 1.6);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
    sun.position.set(-14, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 70 });
    sun.shadow.bias = -0.0008;
    this.scene.add(hemi, sun);

    this.buildTerrain();
    this.buildWater();
    this.buildZones();
    this.buildScenery();

    this.buildingsRoot = new THREE.Group();
    this.unitsRoot = new THREE.Group();
    this.fxRoot = new THREE.Group();
    this.scene.add(this.buildingsRoot, this.unitsRoot, this.fxRoot);

    this.bmap = new Map();
    this.umap = new Map();
    this.fx = [];
    this.island = null;
    this.own = false;
    this.shake = 0;
    this.time = 0;
    this.coinTex = emojiTexture('🪙', '#f2b636');

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -M.WATER_Y);
    this.selRing = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, depthWrite: false }));
    this.selRing.visible = false;
    this.rangeDisc = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }));
    this.rangeRing = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }));
    this.minRing = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.6, depthWrite: false }));
    this.rangeDisc.visible = this.rangeRing.visible = this.minRing.visible = false;
    this.scene.add(this.selRing, this.rangeDisc, this.rangeRing, this.minRing);
    this.ghost = null;

    this.bindInput();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- Scene construction ----------
  buildTerrain() {
    const tileGeo = new THREE.BoxGeometry(0.94, 0.3, 0.94);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inner = (C.GRID - 2) ** 2;
    const grass = new THREE.InstancedMesh(tileGeo, mat, inner);
    const sand = new THREE.InstancedMesh(tileGeo, mat, C.GRID * C.GRID - inner);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    let gi = 0, si = 0;
    for (let y = 0; y < C.GRID; y++) {
      for (let x = 0; x < C.GRID; x++) {
        const alt = (x + y) % 2;
        if (C.isBeach(x, y)) {
          m.makeTranslation(wx(x + 0.5), -0.2, wz(y + 0.5));
          sand.setMatrixAt(si, m);
          sand.setColorAt(si++, col.set(alt ? 0xf0dca4 : 0xe8d195));
        } else {
          m.makeTranslation(wx(x + 0.5), -0.15, wz(y + 0.5));
          grass.setMatrixAt(gi, m);
          grass.setColorAt(gi++, col.set(alt ? 0x93d96c : 0x84cd5e));
        }
      }
    }
    grass.receiveShadow = sand.receiveShadow = true;
    const fill = new THREE.Mesh(new THREE.BoxGeometry(C.GRID - 2, 0.3, C.GRID - 2), new THREE.MeshLambertMaterial({ color: 0x5fae48 }));
    fill.position.y = -0.18;
    fill.receiveShadow = true;
    const sandFill = new THREE.Mesh(new THREE.BoxGeometry(C.GRID, 0.3, C.GRID), new THREE.MeshLambertMaterial({ color: 0xcdb27a }));
    sandFill.position.y = -0.24;
    const cliff = new THREE.Mesh(new THREE.BoxGeometry(C.GRID + 0.3, 2.6, C.GRID + 0.3), new THREE.MeshLambertMaterial({ color: 0x7c8494 }));
    cliff.position.y = -1.6;
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(C.GRID + 1.4, 1.2, C.GRID + 1.4), new THREE.MeshLambertMaterial({ color: 0x5d6575 }));
    ledge.position.y = -1.9;
    this.scene.add(grass, sand, fill, sandFill, cliff, ledge);
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(220, 220, 140, 140).rotateX(-Math.PI / 2);
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x1f7fc4) },
        uShallow: { value: new THREE.Color(0x4fd0e8) },
        uFoam: { value: new THREE.Color(0xffffff) },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
    });
    const water = new THREE.Mesh(geo, this.waterMat);
    water.position.y = M.WATER_Y;
    this.scene.add(water);
  }

  zoneMesh(pred, y, color, opacity) {
    const parts = [];
    for (let ty = C.WMIN; ty <= C.WMAX; ty++) {
      for (let tx = C.WMIN; tx <= C.WMAX; tx++) {
        if (!pred(tx, ty)) continue;
        parts.push(new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2).translate(wx(tx + 0.5), 0, wz(ty + 0.5)));
      }
    }
    const geo = parts.length ? mergeAll(parts) : new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    mesh.position.y = y;
    mesh.visible = false;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    return mesh;
  }

  buildZones() {
    this.zones = {
      land: this.zoneMesh(C.isBeach, 0.0, 0x4ade80, 0.45),
      sea: this.zoneMesh(C.isSeaDeploy, M.WATER_Y + 0.14, 0x4ade80, 0.3),
      shallow: this.zoneMesh(C.isShallow, M.WATER_Y + 0.14, 0xffffff, 0.3),
      build: this.zoneMesh(C.isBuildable, 0.012, 0xffffff, 0.12),
    };
  }

  buildScenery() {
    const g = new THREE.Group();
    const islets = [[-3.2, -2.6], [C.GRID + 2.4, -2.2], [-2.4, C.GRID + 2.8], [C.GRID + 3, C.GRID + 2.2], [C.GRID / 2, -4.2], [-4.4, C.GRID / 2 + 3]];
    for (const [x, y] of islets) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 1.3, 7), new THREE.MeshLambertMaterial({ color: 0x7c8494, flatShading: true }));
      base.position.set(wx(x), M.WATER_Y - 0.3, wz(y));
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.2, 7), new THREE.MeshLambertMaterial({ color: 0x84cd5e, flatShading: true }));
      top.position.set(wx(x), M.WATER_Y + 0.42, wz(y));
      g.add(base, top);
      for (let i = 0; i < 3; i++) {
        const t = M.createTree(0.9 + Math.random() * 0.6);
        t.position.set(wx(x) + (Math.random() - 0.5) * 1.1, M.WATER_Y + 0.5, wz(y) + (Math.random() - 0.5) * 1.1);
        g.add(t);
      }
    }
    for (const [x, y] of [[0.5, 0.5], [C.GRID - 0.5, 0.5], [0.5, C.GRID - 0.5], [C.GRID - 0.5, C.GRID - 0.5]]) {
      const p = M.createPalm(1.1);
      p.position.set(wx(x), -0.05, wz(y));
      p.rotation.y = Math.random() * 6;
      g.add(p);
    }
    for (let i = 0; i < 14; i++) {
      const side = i % 4, t = Math.random() * C.GRID;
      const pos = [[t, -0.7], [C.GRID + 0.7, t], [t, C.GRID + 0.7], [-0.7, t]][side];
      const r = M.createRock(0.6 + Math.random() * 0.6);
      r.position.set(wx(pos[0]), M.WATER_Y - 0.05, wz(pos[1]));
      g.add(r);
    }
    this.scene.add(g);
  }

  // ---------- Camera ----------
  resetCamera() {
    const portrait = innerWidth < innerHeight;
    const dist = portrait ? 43 : 26;
    this.controls.target.set(0, 0, 0.5);
    this.camera.position.set(0, dist * 0.68, dist * 0.74);
    this.controls.update();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 55 : 45;
    this.camera.updateProjectionMatrix();
  }

  setDemo(on) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.enabled = !on;
  }

  project(tx, ty, h = 1) {
    const v = new THREE.Vector3(wx(tx), h, wz(ty)).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  }

  // ---------- Islands & buildings ----------
  setIsland(island, own) {
    if (!this.island || this.island.id !== island.id) {
      for (const v of this.bmap.values()) this.disposeBuildingView(v);
      this.bmap.clear();
      this.clearBattle();
      this.select(null);
    }
    this.island = island;
    this.own = own;
    const walls = new Set(island.buildings.filter((b) => b.type === 'wall').map((b) => `${b.x},${b.y}`));
    const seen = new Set();
    for (const b of island.buildings) {
      seen.add(b.id);
      let mask = 0;
      if (b.type === 'wall') {
        [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy], i) => { if (walls.has(`${b.x + dx},${b.y + dy}`)) mask |= 1 << i; });
      }
      const sig = `${b.type}|${b.level}|${b.x}|${b.y}|${mask}|${island.colorIdx}`;
      let v = this.bmap.get(b.id);
      if (v && v.sig === sig) { v.data = b; this.updateBubble(v); continue; }
      const prev = v;
      v = this.makeBuildingView(b, mask, island.colorIdx);
      if (prev) {
        v.hp = prev.hp;
        this.disposeBuildingView(prev);
        if (!prev.alive) this.setBuildingHp(v, 0, false);
      }
      v.sig = sig;
      this.bmap.set(b.id, v);
      this.updateBubble(v);
    }
    for (const [id, v] of this.bmap) {
      if (!seen.has(id) && !v.revealed) { this.disposeBuildingView(v); this.bmap.delete(id); }
    }
    if (this.selected && !this.bmap.has(this.selected)) this.select(null);
    else if (this.selected) this.select(this.selected);
  }

  makeBuildingView(b, mask, colorIdx, revealed = false) {
    const def = C.BUILDINGS[b.type];
    const size = def.size || 1;
    const hidden = def.trap && !revealed;
    const g = M.createBuilding(b.type, b.level, colorIdx, mask, hidden ? M.MAT_HIDDEN : M.MAT);
    g.position.set(wx(b.x + size / 2), def.water ? M.WATER_Y : 0, wz(b.y + size / 2));
    g.userData.bid = b.id;
    this.buildingsRoot.add(g);
    const v = { id: b.id, data: b, type: b.type, size, group: g, hp: 100, alive: true, bar: null, rubble: null, revealed };
    if (b.type === 'mint') {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.coinTex, depthTest: false }));
      s.scale.set(0.55, 0.55, 1);
      s.position.y = 1.65;
      s.renderOrder = 12;
      s.visible = false;
      g.add(s);
      v.bubble = s;
    }
    return v;
  }

  disposeBuildingView(v) {
    this.buildingsRoot.remove(v.group);
    if (v.rubble) this.fxRoot.remove(v.rubble);
    if (v.bar) this.scene.remove(v.bar);
    v.bubble?.material.dispose();
  }

  updateBubble(v) {
    if (!v.bubble) return;
    const store = C.buildingStats('mint', v.data.level).store;
    v.bubble.visible = this.own && v.alive && (v.data.stored || 0) >= store * 0.2;
  }

  buildingCenter(v) {
    return [v.data.x + v.size / 2, v.data.y + v.size / 2];
  }

  select(bid) {
    this.selected = bid;
    const v = bid != null && this.bmap.get(bid);
    this.selRing.visible = !!v;
    this.rangeDisc.visible = this.rangeRing.visible = this.minRing.visible = false;
    if (!v) return;
    const [cx, cy] = this.buildingCenter(v);
    const y = (C.BUILDINGS[v.type].water ? M.WATER_Y : 0) + 0.03;
    this.selRing.position.set(wx(cx), y, wz(cy));
    this.selRing.scale.setScalar(v.size * 0.75);
    const st = C.buildingStats(v.type, v.data.level);
    if (st.range || st.trigger) this.showRange(cx, cy, st.range || st.trigger, st.minRange);
  }

  showRange(cx, cy, r, minR = 0) {
    for (const m of [this.rangeDisc, this.rangeRing]) {
      m.visible = true;
      m.position.set(wx(cx), 0.04, wz(cy));
      m.scale.setScalar(r);
    }
    this.minRing.visible = minR > 0;
    this.minRing.position.set(wx(cx), 0.05, wz(cy));
    this.minRing.scale.setScalar(Math.max(0.01, minR));
  }

  hideRange() { this.rangeDisc.visible = this.rangeRing.visible = this.minRing.visible = false; }

  showZone(name) {
    for (const [k, m] of Object.entries(this.zones)) m.visible = k === name;
  }

  showGhost(type, tx, ty, ok, colorIdx) {
    const key = `${type}:${colorIdx}`;
    if (!this.ghost || this.ghost.userData.key !== key) {
      this.hideGhost();
      this.ghost = M.createBuilding(type, 1, colorIdx, 0, M.MAT_GHOST_OK);
      this.ghost.userData.key = key;
      this.scene.add(this.ghost);
    }
    const def = C.BUILDINGS[type];
    const size = def.size || 1;
    this.ghost.position.set(wx(tx + size / 2), def.water ? M.WATER_Y : 0, wz(ty + size / 2));
    this.ghost.traverse((o) => { if (o.isMesh) o.material = ok ? M.MAT_GHOST_OK : M.MAT_GHOST_BAD; });
    this.ghost.visible = true;
    const st = C.buildingStats(type, 1);
    if (st.range || st.trigger) this.showRange(tx + size / 2, ty + size / 2, st.range || st.trigger, st.minRange);
  }

  hideGhost() {
    if (this.ghost) this.scene.remove(this.ghost);
    this.ghost = null;
    if (!this.selected) this.hideRange();
  }

  // ---------- Battle ----------
  setBuildingHp(v, pct, alive) {
    v.hp = pct;
    if (!alive && v.alive) {
      v.alive = false;
      v.group.visible = false;
      v.rubble = this.makeRubble(v);
      if (v.bar) { this.scene.remove(v.bar); v.bar = null; }
      this.updateBubble(v);
    } else if (alive && !v.alive) {
      v.alive = true;
      v.group.visible = true;
      if (v.rubble) { this.fxRoot.remove(v.rubble); v.rubble = null; }
    }
    if (!v.alive) return;
    if (pct < 100) {
      if (!v.bar) {
        v.bar = makeBar(Math.min(1.4, 0.6 * v.size + 0.2));
        const [cx, cy] = this.buildingCenter(v);
        v.bar.position.set(wx(cx), M.buildingHeight(v.type) + 0.25, wz(cy));
        this.scene.add(v.bar);
      }
      setBar(v.bar, pct);
    } else if (v.bar) { this.scene.remove(v.bar); v.bar = null; }
  }

  makeRubble(v) {
    const g = new THREE.Group();
    const [cx, cy] = this.buildingCenter(v);
    const n = 4 + v.size * 3;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(GEO.chunk, FXMAT.chunk);
      m.position.set((Math.random() - 0.5) * 0.7 * v.size, 0.04, (Math.random() - 0.5) * 0.7 * v.size);
      m.scale.set(1 + Math.random() * 2, 0.6 + Math.random(), 1 + Math.random() * 2);
      m.rotation.y = Math.random() * 3;
      g.add(m);
    }
    const scorch = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ color: 0x2b2b2b, transparent: true, opacity: 0.45, depthWrite: false }));
    scorch.scale.setScalar(0.45 * v.size);
    scorch.position.y = 0.015;
    g.add(scorch);
    g.position.set(wx(cx), C.BUILDINGS[v.type].water ? M.WATER_Y : 0, wz(cy));
    this.fxRoot.add(g);
    return g;
  }

  clearBattle() {
    for (const u of this.umap.values()) this.removeUnit(u);
    this.umap.clear();
    for (const [id, v] of this.bmap) {
      if (v.revealed) { this.disposeBuildingView(v); this.bmap.delete(id); continue; }
      this.setBuildingHp(v, 100, true);
      if (v.bar) { this.scene.remove(v.bar); v.bar = null; }
    }
    for (const f of this.fx) f.remove?.();
    this.fx = [];
    this.fxRoot.clear();
    for (const v of this.bmap.values()) v.rubble = null;
  }

  applyBattle(snap) {
    if (!this.island || snap.d !== this.island.id) return;
    const now = performance.now();
    if (snap.full) {
      for (const v of this.bmap.values()) this.setBuildingHp(v, 100, true);
      for (const [id, type, x, y, alive] of snap.tr || []) if (alive) this.revealTrap(id, type, x, y);
    }
    for (const [id, pct, alive] of snap.b) {
      const v = this.bmap.get(id);
      if (v) this.setBuildingHp(v, pct, !!alive);
    }
    const seen = new Set();
    for (const [id, code, x, y, hp, color, act] of snap.u) {
      seen.add(id);
      let u = this.umap.get(id);
      if (!u) {
        u = this.makeUnit(UNIT_TYPES[code], color, x, y);
        this.umap.set(id, u);
      }
      u.from.copy(u.cur);
      u.to.set(x, y);
      u.t0 = now;
      u.act = act;
      if (hp < 100) {
        if (!u.bar) { u.bar = makeBar(u.sea ? 0.6 : 0.4); this.unitsRoot.add(u.bar); }
        setBar(u.bar, hp);
      }
    }
    for (const [id, u] of this.umap) if (!seen.has(id)) { this.removeUnit(u); this.umap.delete(id); }
    for (const e of snap.ev) this.onEvent(e);
  }

  makeUnit(type, color, x, y) {
    const mesh = M.createUnit(type, color);
    this.unitsRoot.add(mesh);
    const u = {
      type, mesh, sea: SEA.has(type), bar: null, act: 0, heading: Math.random() * 6, lunge: 0, phase: Math.random() * 6,
      from: new THREE.Vector2(x, y), to: new THREE.Vector2(x, y), cur: new THREE.Vector2(x, y), t0: performance.now(),
    };
    this.placeUnit(u, 0);
    return u;
  }

  removeUnit(u) {
    this.unitsRoot.remove(u.mesh);
    if (u.bar) this.unitsRoot.remove(u.bar);
  }

  revealTrap(id, type, x, y) {
    if (this.bmap.has(id)) return this.bmap.get(id);
    const v = this.makeBuildingView({ id, type, x, y, level: 1 }, 0, this.island?.colorIdx || 0, true);
    v.sig = 'revealed';
    this.bmap.set(id, v);
    return v;
  }

  onEvent(e) {
    const kind = e[0];
    if (kind === 's') {
      const v = this.bmap.get(e[1]);
      if (!v) return;
      const [cx, cy] = this.buildingCenter(v);
      const t = v.group.userData.turret;
      if (t) t.rotation.y = Math.atan2(e[2] - cx, e[3] - cy);
      const targetY = this.heightAt(e[2], e[3]) + 0.2;
      if (v.type === 'tower') this.projectile('arrow', cx, cy, M.buildingHeight('tower') - 0.3, e[2], e[3], targetY, 0.22, 0.25);
      else this.projectile(v.type === 'battery' ? 'big' : 'ball', cx, cy, v.type === 'command' ? 1.3 : 0.62, e[2], e[3], targetY, 0.2, 0.1);
      this.handlers.sound?.('shot');
    } else if (kind === 'u') {
      const u = this.umap.get(e[1]);
      if (!u) return;
      u.heading = Math.atan2(e[2] - u.cur.x, e[3] - u.cur.y);
      u.lunge = 1;
      const y0 = u.sea ? M.WATER_Y + 0.25 : 0.25;
      if (RANGED.has(u.type)) this.projectile(u.type === 'archer' ? 'arrow' : 'ball', u.cur.x, u.cur.y, y0, e[2], e[3], 0.5, u.sea ? 0.3 : 0.25, 0.4);
      else this.spark(e[2], e[3]);
    } else if (kind === 'm') {
      const fromLand = C.isLand(Math.floor(e[1]), Math.floor(e[2]));
      this.projectile('big', e[1], e[2], fromLand ? 0.6 : M.WATER_Y + 0.4, e[3], e[4], this.heightAt(e[3], e[4]), e[5], 3.2);
      this.handlers.sound?.('mortar');
    } else if (kind === 'b') {
      this.explosion(e[1], e[2], e[3]);
    } else if (kind === 't') {
      const v = this.revealTrap(e[1], e[2], e[3], e[4]);
      v.group.scale.set(1.3, 1.6, 1.3);
      v.pop = 1;
      if (e[2] !== 'spike') setTimeout(() => { if (this.bmap.get(e[1]) === v) { this.disposeBuildingView(v); this.bmap.delete(e[1]); } }, 350);
      this.handlers.sound?.('trap');
    } else if (kind === 'x') {
      const v = this.bmap.get(e[1]);
      if (!v) return;
      this.setBuildingHp(v, 0, false);
      const [cx, cy] = this.buildingCenter(v);
      this.explosion(cx, cy, 0.8 + v.size * 0.3, true);
      this.shake = Math.max(this.shake, v.type === 'command' ? 0.6 : 0.15);
    } else if (kind === 'd') {
      this.puff(e[2], e[3]);
    }
  }

  heightAt(tx, ty) { return C.isLand(Math.floor(tx), Math.floor(ty)) ? 0 : M.WATER_Y; }

  // ---------- Effects ----------
  projectile(kind, fx, fy, fh, tx, ty, th, dur, arc) {
    const geo = kind === 'arrow' ? GEO.arrow : kind === 'big' ? GEO.bigBall : GEO.ball;
    const mesh = new THREE.Mesh(geo, kind === 'arrow' ? FXMAT.arrow : FXMAT.ball);
    const a = new THREE.Vector3(wx(fx), fh, wz(fy));
    const b = new THREE.Vector3(wx(tx), th, wz(ty));
    mesh.position.copy(a);
    this.fxRoot.add(mesh);
    let t = 0;
    const prev = new THREE.Vector3();
    this.fx.push({
      update: (dt) => {
        t += dt / dur;
        prev.copy(mesh.position);
        mesh.position.lerpVectors(a, b, Math.min(1, t));
        mesh.position.y += Math.sin(Math.min(1, t) * Math.PI) * arc;
        if (kind === 'arrow') mesh.lookAt(mesh.position.clone().add(mesh.position.clone().sub(prev)));
        if (t >= 1) { this.fxRoot.remove(mesh); return false; }
        return true;
      },
      remove: () => this.fxRoot.remove(mesh),
    });
  }

  spark(tx, ty) {
    const m = new THREE.Mesh(GEO.blast, FXMAT.spark);
    m.position.set(wx(tx) + (Math.random() - 0.5) * 0.3, this.heightAt(tx, ty) + 0.35, wz(ty) + (Math.random() - 0.5) * 0.3);
    m.scale.setScalar(0.06);
    this.fxRoot.add(m);
    let t = 0;
    this.fx.push({ update: (dt) => { t += dt; m.scale.setScalar(0.06 + t * 0.5); if (t > 0.15) { this.fxRoot.remove(m); return false; } return true; } });
  }

  explosion(tx, ty, r = 1, big = false) {
    const y = this.heightAt(tx, ty) + 0.1;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa630, transparent: true, opacity: 0.9, depthWrite: false });
    const ball = new THREE.Mesh(GEO.blast, mat);
    ball.position.set(wx(tx), y, wz(ty));
    this.fxRoot.add(ball);
    const chunks = [];
    for (let i = 0; i < (big ? 10 : 5); i++) {
      const c = new THREE.Mesh(GEO.chunk, big ? FXMAT.chunk : FXMAT.shell);
      c.position.copy(ball.position);
      c.userData.v = new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4);
      this.fxRoot.add(c);
      chunks.push(c);
    }
    let t = 0;
    const dur = big ? 0.7 : 0.45;
    this.fx.push({
      update: (dt) => {
        t += dt;
        const k = t / dur;
        ball.scale.setScalar(Math.max(0.01, r * (0.3 + k * 0.8)));
        mat.opacity = Math.max(0, 0.9 * (1 - k));
        mat.color.setHSL(0.08 - k * 0.07, 1, 0.55 - k * 0.25);
        for (const c of chunks) {
          c.userData.v.y -= 9.8 * dt;
          c.position.addScaledVector(c.userData.v, dt);
          c.rotation.x += dt * 8;
        }
        if (k >= 1) {
          this.fxRoot.remove(ball);
          for (const c of chunks) this.fxRoot.remove(c);
          mat.dispose();
          return false;
        }
        return true;
      },
    });
    this.shake = Math.max(this.shake, big ? 0.12 : 0.04);
    this.handlers.sound?.('boom');
  }

  puff(tx, ty) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.8, depthWrite: false });
    const m = new THREE.Mesh(GEO.blast, mat);
    m.position.set(wx(tx), this.heightAt(tx, ty) + 0.2, wz(ty));
    this.fxRoot.add(m);
    let t = 0;
    this.fx.push({
      update: (dt) => {
        t += dt / 0.5;
        m.scale.setScalar(0.12 + t * 0.35);
        m.position.y += dt * 0.6;
        mat.opacity = 0.8 * (1 - t);
        if (t >= 1) { this.fxRoot.remove(m); mat.dispose(); return false; }
        return true;
      },
    });
  }

  // Little bounce on a building when tapped.
  bump(bid) {
    const v = this.bmap.get(bid);
    if (v) v.pop = 1;
  }

  // ---------- Input ----------
  bindInput() {
    const el = this.canvas;
    this.pointers = new Map();
    this.tapStart = null;
    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, true);
      this.tapStart = this.pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.tapStart && Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y) > 10) this.tapStart = null;
      if (e.pointerType === 'mouse' && this.handlers.onHover) this.handlers.onHover(this.pick(e.clientX, e.clientY));
    });
    const end = (e) => {
      const s = this.tapStart;
      this.pointers.delete(e.pointerId);
      if (e.type === 'pointerup' && s && s.id === e.pointerId && performance.now() - s.t < 500) {
        this.handlers.onTap?.(this.pick(e.clientX, e.clientY), e);
      }
      if (this.pointers.size === 0) this.tapStart = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pick(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    let bid = null;
    const hits = this.raycaster.intersectObjects(this.buildingsRoot.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.bid === undefined) o = o.parent;
      if (o && o.visible) { bid = o.userData.bid; break; }
    }
    const p = new THREE.Vector3();
    let tx = 0, ty = 0;
    if (this.raycaster.ray.intersectPlane(this.groundPlane, p)) { tx = p.x + HALF; ty = p.z + HALF; }
    if (!C.isLand(Math.floor(tx), Math.floor(ty)) && this.raycaster.ray.intersectPlane(this.waterPlane, p)) { tx = p.x + HALF; ty = p.z + HALF; }
    return { bid, tx, ty, x: Math.floor(tx), y: Math.floor(ty), clientX, clientY };
  }

  // ---------- Frame loop ----------
  placeUnit(u, t) {
    const y = u.sea ? M.WATER_Y + Math.sin(this.time * 2 + u.phase) * 0.04 : 0;
    u.mesh.position.set(wx(u.cur.x), y, wz(u.cur.y));
    const moving = u.from.distanceToSquared(u.to) > 0.0004;
    if (moving && !u.act) u.heading = Math.atan2(u.to.x - u.from.x, u.to.y - u.from.y);
    let d = u.heading - u.mesh.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    u.mesh.rotation.y += d * Math.min(1, t * 10);
    if (!u.sea && moving) u.mesh.position.y += Math.abs(Math.sin(this.time * 12 + u.phase)) * 0.06;
    if (u.sea) u.mesh.rotation.z = Math.sin(this.time * 1.6 + u.phase) * 0.06;
    if (u.lunge > 0) {
      u.lunge = Math.max(0, u.lunge - t * 5);
      const k = Math.sin(u.lunge * Math.PI) * 0.12;
      u.mesh.position.x += Math.sin(u.heading) * k;
      u.mesh.position.z += Math.cos(u.heading) * k;
    }
    if (u.bar) u.bar.position.set(u.mesh.position.x, u.mesh.position.y + (u.sea ? 0.9 : 0.62), u.mesh.position.z);
  }

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.waterMat.uniforms.uTime.value = this.time;
    this.controls.update();
    const t = this.controls.target;
    t.x = Math.max(-16, Math.min(16, t.x));
    t.z = Math.max(-16, Math.min(16, t.z));
    t.y = 0;

    const now = performance.now();
    for (const u of this.umap.values()) {
      const k = Math.min(1, (now - u.t0) / 110);
      u.cur.lerpVectors(u.from, u.to, k);
      this.placeUnit(u, dt);
    }
    for (const v of this.bmap.values()) {
      const ud = v.group.userData;
      if (ud.spinner) ud.spinner.rotation.y += dt * 2;
      if (v.bubble?.visible) v.bubble.position.y = 1.65 + Math.sin(this.time * 4) * 0.08;
      if (v.pop) {
        v.pop = Math.max(0, v.pop - dt * 4);
        const s = 1 + Math.sin(v.pop * Math.PI) * 0.12;
        v.group.scale.set(s, 1 + Math.sin(v.pop * Math.PI) * 0.2, s);
      }
    }
    if (this.selRing.visible) this.selRing.material.opacity = 0.6 + Math.sin(this.time * 5) * 0.3;
    this.fx = this.fx.filter((f) => f.update(dt));

    let shook = false;
    if (this.shake > 0.005) {
      shook = true;
      this.shakeOff = new THREE.Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.camera.position.add(this.shakeOff);
      this.shake *= 0.86;
    }
    this.renderer.render(this.scene, this.camera);
    if (shook) this.camera.position.sub(this.shakeOff);
  }
}

function mergeAll(geos) {
  // Small local merge so zones need no extra import.
  const pos = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
    base += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}
