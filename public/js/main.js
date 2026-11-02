// Clicker Island Wars - client app: networking, HUD, panels and input modes.
import * as C from '/shared/config.js';
import { World } from './world.js';
import * as sfx from './sfx.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.floor(n).toLocaleString();
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const color = (i) => C.PLAYER_COLORS[i % C.PLAYER_COLORS.length];
const storage = (kind) => ({
  get(k, d = null) { try { return window[kind].getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { window[kind].setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { window[kind].removeItem(k); } catch { /* storage unavailable */ } },
});
const local = storage('localStorage');
const session = storage('sessionStorage');

const REPEATABLE = new Set(['wall', 'spike', 'bomb', 'seamine']);
const BUILD_TABS = {
  defense: { label: '🛡️ Defence', types: ['wall', 'cannon', 'tower', 'mortar', 'battery', 'guardpost'] },
  trap: { label: '💥 Traps', types: ['spike', 'bomb', 'seamine'] },
  economy: { label: '🪙 Economy', types: ['mint', 'library'] },
  army: { label: '⛺ Army', types: ['barracks', 'shipyard'] },
};

const S = {
  me: null, room: null, myId: null, screen: 'title',
  view: null, viewIsland: null,
  mode: 'idle', placeType: null, moveId: null, pending: null,
  selected: null, panel: null, buildTab: 'defense',
  quiz: { year: Number(local.get('ciw-year', 4)) || 4, q: null, result: null, busy: false, waitUntil: 0 },
  deployType: null, deployN: 5,
  taps: 0, inflight: 0, tapTimer: null,
  clockOffset: 0, lastPhaseKey: '', aliveSeen: true,
};

// ---------- 3D world ----------
const world = new World($('#scene'), {
  onTap: (pick) => onWorldTap(pick),
  onHover: (pick) => onWorldHover(pick),
  sound: (n) => sfx.play(n),
});

const DEMO_ISLAND = {
  id: 'demo', colorIdx: 0,
  buildings: [
    ...C.START.buildings,
    { type: 'tower', x: 11, y: 7 }, { type: 'battery', x: 7, y: 11 }, { type: 'library', x: 3, y: 5 }, { type: 'guardpost', x: 13, y: 9 },
    { type: 'mortar', x: 9, y: 5 }, { type: 'mint', x: 2, y: 14 },
    ...[...Array(10).keys()].map((i) => ({ type: 'wall', x: 4 + i, y: 3 })),
    ...[...Array(10).keys()].map((i) => ({ type: 'wall', x: 4 + i, y: 15 })),
    ...[...Array(11).keys()].map((i) => ({ type: 'wall', x: 3, y: 4 + i })),
    ...[...Array(11).keys()].map((i) => ({ type: 'wall', x: 14, y: 4 + i })),
  ].map((b, i) => ({ id: 1000 + i, level: b.type === 'wall' ? 3 : 2, stored: 0, ...b })),
};
world.setIsland(DEMO_ISLAND, false);
world.setDemo(true);

// ---------- Networking ----------
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  $('#loading').classList.add('hidden');
  socket.emit('hello', { token: session.get('ciw-token') }, (res) => {
    if (!res?.rejoined && S.screen !== 'title') showTitle();
  });
});
socket.on('disconnect', () => {
  $('#loading').textContent = 'Reconnecting…';
  $('#loading').classList.remove('hidden');
});
socket.on('joined', ({ pid, token }) => {
  S.myId = pid;
  S.view = pid;
  session.set('ciw-token', token);
});
socket.on('room', onRoom);
socket.on('me', onMe);
socket.on('island', (isl) => {
  if (isl.id === S.myId || isl.id !== S.view) return;
  S.viewIsland = isl;
  world.setIsland(isl, false);
});
socket.on('battle', (snap) => world.applyBattle(snap));
socket.on('toast', ({ msg, kind }) => toast(msg, kind));
socket.on('report', showReport);
socket.on('over', showGameOver);

function act(type, data = {}) {
  return new Promise((resolve) => {
    socket.emit('act', type, data, (r) => {
      r = r || {};
      if (r.error && r.error !== 'wait') {
        toast(r.error, 'error');
        sfx.play('error');
      }
      resolve(r);
    });
  });
}

function emitAck(ev, data) {
  return new Promise((resolve) => socket.emit(ev, data, (r) => {
    if (r?.error) toast(r.error, 'error');
    resolve(r || {});
  }));
}

// ---------- Screens ----------
function showScreen(name) {
  S.screen = name;
  $('#screen-title').classList.toggle('hidden', name !== 'title');
  $('#screen-lobby').classList.toggle('hidden', name !== 'lobby');
  $('#hud').classList.toggle('hidden', name !== 'game');
  if (name !== 'game') { closeSheet(); $('#overlay').classList.add('hidden'); }
}

function showTitle() {
  showScreen('title');
  S.room = null;
  S.me = null;
  world.setIsland(DEMO_ISLAND, false);
  world.setDemo(true);
}

function showLobby() {
  if (S.screen !== 'lobby') {
    showScreen('lobby');
    world.setIsland(DEMO_ISLAND, false);
    world.setDemo(true);
  }
  renderLobby();
}

function showGame() {
  showScreen('game');
  world.setDemo(false);
  world.resetCamera();
  S.view = S.myId;
  if (S.me) world.setIsland(ownIsland(), true);
  $('#players').classList.toggle('collapsed', innerWidth < 760);
}

// ---------- Room / state updates ----------
function onRoom(r) {
  S.room = r;
  S.clockOffset = r.now - Date.now();
  if (r.phase === 'lobby') {
    $('#overlay').classList.add('hidden');
    S.lastPhaseKey = '';
    showLobby();
    return;
  }
  if (S.screen !== 'game') showGame();
  const key = `${r.phase}:${r.round}`;
  if (key !== S.lastPhaseKey) {
    const first = !S.lastPhaseKey;
    S.lastPhaseKey = key;
    onPhaseChange(r.phase, first);
  }
  renderPlayers();
  renderPhase();
  if (S.panel === 'attack') renderPanel();
}

function onPhaseChange(phase, first) {
  if (phase === 'build') {
    showBanner(`🔨 Build Phase`, `Round ${S.room.round} of ${S.room.settings.rounds} · answer quizzes, build defences!`);
    if (S.view !== S.myId) goHome();
    world.clearBattle();
    if (S.mode === 'deploy') setMode('idle');
    if (S.room.round === 1) {
      S.quiz.q = null;
      S.quiz.result = null;
      if (first) setTimeout(() => toast('📚 Tip: quiz answers earn the most coins!', 'good'), 2800);
    }
  } else if (phase === 'pvp') {
    showBanner('⚔️ PVP!', 'Press Attack and raid an enemy island');
    if (S.mode === 'place' || S.mode === 'move') setMode('idle');
    if (S.panel === 'build' || S.panel === 'info') closeSheet();
    if (S.view !== S.myId) viewIsland(S.view);
  }
  sfx.play('phase');
}

function onMe(m) {
  const prev = S.me;
  S.me = m;
  if (prev && m.coins > prev.coins + 5) bumpCoins();
  if (prev && prev.alive && !m.alive) showBanner('💥 Your Command fell!', 'You can still watch the war');
  renderCoins();
  $('#tap-amt').textContent = `+${m.tapLevel}`;
  $('#quiz-hint').textContent = `+${estReward(S.quiz.year)}`;
  if (S.screen === 'game' && S.view === S.myId) world.setIsland(ownIsland(), true);
  if (S.panel && S.panel !== 'quiz' && S.panel !== 'menu') renderPanel();
  if (S.panel === 'quiz') renderQuizHeader();
  if (S.mode === 'deploy') renderDeploy();
}

const ownIsland = () => ({ id: S.myId, name: S.me.name, colorIdx: S.me.colorIdx, buildings: S.me.buildings });
const phase = () => S.room?.phase;
const canPlay = () => S.me && S.me.alive && (phase() === 'build' || phase() === 'pvp');
const displayCoins = () => (S.me ? S.me.coins + (S.taps + S.inflight) * S.me.tapLevel : 0);

function renderCoins() {
  $('#coins b').textContent = fmt(displayCoins());
}

function bumpCoins() {
  const el = $('#coins');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

setInterval(renderPhase, 250);
function renderPhase() {
  if (!S.room || S.screen !== 'game') return;
  const r = S.room;
  const el = $('#phase');
  const left = r.endsAt - (Date.now() + S.clockOffset);
  el.className = `pill phase ${r.phase}`;
  if (r.phase === 'build' || r.phase === 'pvp') {
    $('#phase-label').textContent = `${r.phase === 'build' ? '🔨 BUILD' : '⚔️ PVP'} · R${r.round}/${r.settings.rounds}`;
    $('#phase-time').textContent = mmss(left);
    el.classList.toggle('urgent', left < 10000);
  } else {
    $('#phase-label').textContent = 'GAME OVER';
    $('#phase-time').textContent = '';
  }
  document.querySelector('.nav-btn.attack').classList.toggle('live', r.phase === 'pvp' && !!S.me?.alive);
}

function renderPlayers() {
  const r = S.room;
  if (!r) return;
  $('#players').innerHTML = r.players.map((p) => `
    <div class="pl ${p.id === S.myId ? 'me' : ''} ${p.alive ? '' : 'dead'}" data-act="view" data-id="${p.id}" title="View island">
      <span class="dot" style="background:${color(p.colorIdx)}"></span>
      <span class="nm">${p.isBot ? '🤖 ' : ''}${esc(p.name)}${p.connected ? '' : ' 💤'}</span>
      <span class="sc">${p.score}</span>
      ${r.phase === 'pvp' ? `<span class="hp"><i style="width:${p.cmdHp}%;background:${p.cmdHp > 50 ? 'var(--green)' : p.cmdHp > 25 ? '#facc15' : 'var(--red)'}"></i></span>` : ''}
    </div>`).join('');
}

function renderViewbar() {
  const bar = $('#viewbar');
  if (S.view === S.myId || !S.room) { bar.classList.add('hidden'); return; }
  const p = S.room.players.find((o) => o.id === S.view);
  const attacking = phase() === 'pvp' && p?.alive && S.me?.alive;
  bar.classList.remove('hidden');
  bar.classList.toggle('scout', !attacking);
  $('#view-label').textContent = `${attacking ? '⚔️ Attacking' : '👁️ Scouting'} ${p ? p.name : ''}`;
}

// ---------- Lobby ----------
function renderLobby() {
  const r = S.room;
  if (!r) return;
  const host = r.hostId === S.myId;
  $('#lobby-code').textContent = r.code;
  $('#lobby-players').innerHTML = r.players.map((p) => `
    <div class="lp">
      <span class="dot" style="background:${color(p.colorIdx)}"></span>
      <span class="nm">${p.isBot ? '🤖 ' : ''}${esc(p.name)}</span>
      <span class="tag">${p.id === S.myId ? 'You' : ''}${p.id === r.hostId ? ' 👑 Host' : ''}${p.connected ? '' : ' (away)'}</span>
      ${host && p.isBot ? `<button class="btn small danger" data-act="kick" data-id="${p.id}">✖</button>` : ''}
    </div>`).join('') + (r.players.length < r.settings.maxPlayers ? `<div class="lp muted">Waiting for players… (${r.players.length}/${r.settings.maxPlayers})</div>` : '');
  const labels = { buildMin: '🔨 Build (min)', pvpMin: '⚔️ PVP (min)', rounds: '🔁 Rounds', maxPlayers: '👥 Max players' };
  $('#lobby-settings').innerHTML = Object.entries(C.SETTING_OPTIONS).map(([k, opts]) => `
    <label><span>${labels[k]}</span>
      <select data-setting="${k}" ${host ? '' : 'disabled'}>
        ${opts.map((o) => `<option value="${o}" ${o === r.settings[k] ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
    </label>`).join('');
  $('#btn-add-bot').classList.toggle('hidden', !host || r.players.length >= r.settings.maxPlayers);
  $('#btn-start').classList.toggle('hidden', !host);
  $('#btn-start').disabled = r.players.length < 2;
  $('#lobby-hint').textContent = host
    ? (r.players.length < 2 ? 'Share the code with friends or add a bot, then start the war!' : 'Ready when you are, Captain!')
    : 'Waiting for the host to start the war…';
}

document.addEventListener('change', (e) => {
  const k = e.target.dataset?.setting;
  if (k) act('settings', { [k]: Number(e.target.value) });
});

// ---------- Tapping (clicker) ----------
function doTap(x, y) {
  if (!canPlay()) return;
  S.taps++;
  sfx.play('tap');
  floater(x + (Math.random() - 0.5) * 40, y - 20, `+${S.me.tapLevel}`);
  renderCoins();
  if (!S.tapTimer) S.tapTimer = setTimeout(flushTaps, 300);
}

function flushTaps() {
  S.tapTimer = null;
  const n = S.taps;
  if (!n) return;
  S.taps = 0;
  S.inflight += n;
  act('tap', { n }).then(() => {
    S.inflight -= n;
    renderCoins();
  });
}
addEventListener('visibilitychange', flushTaps);

const tapBtn = $('#tap-btn');
tapBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sfx.unlock();
  const r = tapBtn.getBoundingClientRect();
  doTap(r.left + r.width / 2, r.top);
  tapBtn.classList.add('hit');
  setTimeout(() => tapBtn.classList.remove('hit'), 80);
});

// ---------- World interaction ----------
function onWorldTap(pick) {
  if (S.screen !== 'game' || !S.me) return;
  if (S.mode === 'place') return placeTap(pick);
  if (S.mode === 'move') return moveTap(pick);
  if (S.view !== S.myId) {
    if (S.mode === 'deploy') deployAt(pick);
    else toast(phase() === 'pvp' ? 'Press ⚔️ Attack to launch a strike here.' : 'Scouting only - attacks open in the PVP phase.');
    return;
  }
  if (pick.bid != null) {
    const b = S.me.buildings.find((x) => x.id === pick.bid);
    if (!b) return;
    if (b.type === 'command') {
      doTap(pick.clientX, pick.clientY);
      world.bump(b.id);
      return;
    }
    if (b.type === 'mint' && b.stored >= 1) {
      collectMint(b, pick);
      return;
    }
    selectBuilding(b.id);
  } else if (S.panel === 'info') closeSheet();
  else world.select(null);
}

async function collectMint(b, pick) {
  if (!canPlay()) return;
  world.bump(b.id);
  const r = await act('collect', { id: b.id });
  if (r.ok && r.amount > 0) {
    floater(pick.clientX, pick.clientY - 20, `+${r.amount} 🪙`, true);
    sfx.play('coin');
  }
}

function onWorldHover(pick) {
  if (S.mode === 'place') world.showGhost(S.placeType, pick.x, pick.y, canPlaceLocal(S.placeType, pick.x, pick.y), S.me.colorIdx);
  else if (S.mode === 'move') {
    const b = S.me.buildings.find((x) => x.id === S.moveId);
    if (b) world.showGhost(b.type, pick.x, pick.y, canPlaceLocal(b.type, pick.x, pick.y, b.id), S.me.colorIdx);
  }
}

function canPlaceLocal(type, x, y, ignoreId) {
  const def = C.BUILDINGS[type];
  const size = def.size || 1;
  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      if (def.water ? !C.isShallow(x + dx, y + dy) : !C.isBuildable(x + dx, y + dy)) return false;
    }
  }
  return !S.me.buildings.some((b) => {
    if (b.id === ignoreId) return false;
    const bs = C.BUILDINGS[b.type].size || 1;
    return x < b.x + bs && x + size > b.x && y < b.y + bs && y + size > b.y;
  });
}

function setMode(mode, opts = {}) {
  S.mode = mode;
  S.pending = null;
  world.hideGhost();
  $('#place-confirm').classList.add('hidden');
  $('#placebar').classList.toggle('hidden', mode !== 'place' && mode !== 'move');
  $('#deploy').classList.toggle('hidden', mode !== 'deploy');
  tapBtn.classList.toggle('hidden', mode === 'deploy');
  if (mode === 'place') {
    S.placeType = opts.type;
    const d = C.BUILDINGS[opts.type];
    $('#place-label').innerHTML = `${d.icon} ${d.name} <span class="cost">🪙${d.cost}</span> · tap a ${d.water ? 'shallow water' : 'grass'} tile`;
    world.showZone(d.water ? 'shallow' : 'build');
    world.select(null);
  } else if (mode === 'move') {
    S.moveId = opts.id;
    const b = S.me.buildings.find((x) => x.id === opts.id);
    const d = C.BUILDINGS[b.type];
    $('#place-label').textContent = `Moving ${d.icon} ${d.name} · tap a new tile`;
    world.showZone(d.water ? 'shallow' : 'build');
  } else if (mode === 'deploy') {
    world.select(null);
    renderDeploy();
  } else {
    world.showZone(null);
  }
}

function startPlace(type) {
  if (phase() !== 'build') return toast('You can only build during the build phase.', 'error');
  closeSheet();
  setMode('place', { type });
}

async function placeTap(pick) {
  const type = S.placeType;
  const ok = canPlaceLocal(type, pick.x, pick.y);
  const confirmTap = S.pending && S.pending.x === pick.x && S.pending.y === pick.y;
  if (!world.mobile || confirmTap) {
    if (!ok) { toast("You can't build there.", 'error'); sfx.play('error'); return; }
    return doBuild(type, pick.x, pick.y, pick);
  }
  S.pending = { x: pick.x, y: pick.y };
  world.showGhost(type, pick.x, pick.y, ok, S.me.colorIdx);
  $('#place-confirm').classList.toggle('hidden', !ok);
}

async function doBuild(type, x, y, pick) {
  const r = await act('build', { type, x, y });
  if (!r.ok) return;
  sfx.play('build');
  const p = world.project(x + 0.5, y + 0.5, 1);
  floater(p.x, p.y, `${C.BUILDINGS[type].icon} -${C.BUILDINGS[type].cost}`);
  if (REPEATABLE.has(type) && S.me) {
    S.pending = null;
    world.hideGhost();
    $('#place-confirm').classList.add('hidden');
    const limit = C.LIMITS[type][S.me.cmdLevel - 1];
    if (S.me.buildings.filter((b) => b.type === type).length + 1 >= limit) setMode('idle');
  } else setMode('idle');
}

async function moveTap(pick) {
  const b = S.me.buildings.find((x) => x.id === S.moveId);
  if (!b) return setMode('idle');
  const ok = canPlaceLocal(b.type, pick.x, pick.y, b.id);
  const confirmTap = S.pending && S.pending.x === pick.x && S.pending.y === pick.y;
  if (!world.mobile || confirmTap) {
    if (!ok) { toast("You can't move it there.", 'error'); return; }
    const r = await act('move', { id: b.id, x: pick.x, y: pick.y });
    if (r.ok) { sfx.play('build'); setMode('idle'); selectBuilding(b.id); }
    return;
  }
  S.pending = { x: pick.x, y: pick.y };
  world.showGhost(b.type, pick.x, pick.y, ok, S.me.colorIdx);
  $('#place-confirm').classList.toggle('hidden', !ok);
}

function selectBuilding(id) {
  S.selected = id;
  world.select(id);
  openPanel('info');
}

// ---------- Viewing islands ----------
async function viewIsland(id) {
  if (id === S.myId) return goHome();
  const r = await act('watch', { id });
  if (!r.island) return;
  S.view = id;
  S.viewIsland = r.island;
  setMode('idle');
  world.setIsland(r.island, false);
  if (r.battle) world.applyBattle(r.battle);
  world.resetCamera();
  const p = S.room.players.find((o) => o.id === id);
  if (phase() === 'pvp' && p?.alive && S.me?.alive) {
    if (!S.deployType || !S.me.army[S.deployType]) S.deployType = C.UNIT_TYPES.find((t) => S.me.army[t] > 0) || null;
    setMode('deploy');
  }
  renderViewbar();
  if (S.panel === 'attack') closeSheet();
}

async function goHome() {
  const r = await act('watch', { id: S.myId });
  S.view = S.myId;
  S.viewIsland = null;
  setMode('idle');
  if (S.me) world.setIsland(ownIsland(), true);
  if (r.battle) world.applyBattle(r.battle);
  world.resetCamera();
  renderViewbar();
}

// ---------- Deploying ----------
function renderDeploy() {
  if (!S.me) return;
  $('#deploy-units').innerHTML = C.UNIT_TYPES.map((t) => {
    const u = C.UNITS[t];
    const n = S.me.army[t];
    return `<button class="du ${u.domain === 'sea' ? 'sea' : ''} ${S.deployType === t ? 'on' : ''}" data-act="deploy-type" data-type="${t}" ${n ? '' : 'disabled'}>
      <span class="ic">${u.icon}</span>${u.name}<span class="ct">${n}</span></button>`;
  }).join('');
  for (const b of document.querySelectorAll('#deploy-n button')) b.classList.toggle('on', Number(b.dataset.n) === S.deployN);
  const d = S.deployType && C.UNITS[S.deployType];
  const total = C.UNIT_TYPES.reduce((s, t) => s + S.me.army[t], 0);
  $('#deploy-hint').textContent = !total ? 'No units left - train more in the Army menu!'
    : !d ? 'Pick a unit below'
      : d.domain === 'land' ? `Tap the green beach to land ${d.name}s` : `Tap the green outer sea to launch ${d.name}s`;
  world.showZone(d ? (d.domain === 'land' ? 'land' : 'sea') : null);
}

async function deployAt(pick) {
  if (!S.deployType) return toast('Pick a unit first!');
  const have = S.me.army[S.deployType];
  if (!have) return toast(`No ${C.UNITS[S.deployType].name}s left!`, 'error');
  const n = Math.min(S.deployN, have);
  const r = await act('deploy', { target: S.view, type: S.deployType, x: pick.tx, y: pick.ty, n });
  if (r.ok) {
    sfx.play('deploy');
    floater(pick.clientX, pick.clientY - 20, `${C.UNITS[S.deployType].icon} ×${n}`);
    if (S.me.army[S.deployType] - n <= 0) S.deployType = C.UNIT_TYPES.find((t) => t !== S.deployType && S.me.army[t] > 0) || S.deployType;
  }
}

// ---------- Panels ----------
function openPanel(name) {
  sfx.unlock();
  if (S.panel === name && name !== 'info') return closeSheet();
  S.panel = name;
  S.panelHtml = null;
  $('#sheet').classList.remove('hidden');
  $('#sheet').classList.toggle('tall', name === 'quiz');
  document.body.classList.add('sheet-open');
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.toggle('active', b.dataset.panel === name);
  $('#sheet-body').scrollTop = 0;
  renderPanel();
  if (name === 'quiz' && !S.quiz.q) fetchQuestion();
}

function closeSheet() {
  if (S.panel === 'info') world.select(null);
  S.panel = null;
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('sheet-open');
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.remove('active');
}

function renderPanel() {
  if (!S.panel || !S.me) return;
  const titles = { quiz: '📚 Island Quiz', build: '🔨 Build', army: '🪖 Army', attack: '⚔️ Islands', menu: '☰ Menu' };
  let html = '';
  if (S.panel === 'quiz') html = quizHtml();
  else if (S.panel === 'build') html = buildHtml();
  else if (S.panel === 'army') html = armyHtml();
  else if (S.panel === 'attack') html = attackHtml();
  else if (S.panel === 'menu') html = menuHtml();
  else if (S.panel === 'info') {
    const b = S.me.buildings.find((x) => x.id === S.selected);
    if (!b) return closeSheet();
    titles.info = `${C.BUILDINGS[b.type].icon} ${C.BUILDINGS[b.type].name}`;
    html = infoHtml(b);
  }
  $('#sheet-title').textContent = titles[S.panel];
  // Only touch the DOM when something changed, so periodic state updates never swallow a click.
  if (html !== S.panelHtml) {
    S.panelHtml = html;
    $('#sheet-body').innerHTML = html;
  }
}

// Quiz
function estReward(year) {
  if (!S.me) return C.QUIZ_REWARD[year];
  return Math.round(C.QUIZ_REWARD[year] * (1 + S.me.quizBonus) * (1 + Math.min(S.me.streak, C.STREAK_MAX) * C.STREAK_BONUS));
}

function quizHeaderHtml() {
  const me = S.me;
  const streakPct = Math.min(me.streak, C.STREAK_MAX) * C.STREAK_BONUS * 100;
  return `
    <div class="years">${C.QUIZ_YEARS.map((y) => `<button class="${y === S.quiz.year ? 'on' : ''}" data-act="quiz-year" data-year="${y}">Y${y}<small>🪙${estReward(y)}</small></button>`).join('')}</div>
    <div class="streak">
      <span>🔥 Streak <b>${me.streak}</b>${streakPct ? ` (+${streakPct}%)` : ''}</span>
      ${me.quizBonus ? `<span>📘 +${Math.round(me.quizBonus * 100)}%</span>` : ''}
      <span>✅ ${me.correct}/${me.answered}</span>
    </div>`;
}

function renderQuizHeader() {
  const head = document.getElementById('quiz-head');
  if (head) head.innerHTML = quizHeaderHtml();
}

function quizHtml() {
  const { q, result } = S.quiz;
  let body;
  if (!canPlay()) body = '<div class="question">The quiz opens when the war is running.</div>';
  else if (!q) body = '<div class="question">⏳ Fetching a question from the island library…</div>';
  else {
    const keys = ['A', 'B', 'C', 'D'];
    const answers = q.options.map((o, i) => {
      let cls = '';
      if (result && !result.pending) {
        if (i === result.correctIndex) cls = 'correct';
        else if (i === result.choice) cls = 'wrong';
      }
      return `<button class="answer ${cls}" data-act="answer" data-i="${i}" ${result ? 'disabled' : ''}><span class="k">${keys[i]}</span><span>${esc(o)}</span></button>`;
    }).join('');
    let fb = '';
    if (result && !result.pending) {
      if (result.correct) {
        fb = `<div class="feedback good"><div class="head">✅ Correct! +${result.reward} 🪙</div>${esc(result.explanation)}</div>`;
      } else {
        const wait = Math.max(0, S.quiz.waitUntil - Date.now());
        fb = `<div class="feedback bad"><div class="head">❌ Not quite!</div>
          The answer is <b>${esc(q.options[result.correctIndex])}</b>. ${esc(result.explanation)}
          <div style="margin-top:8px"><button class="btn primary" data-act="quiz-next" ${wait ? 'disabled' : ''}>${wait ? 'Next in a moment…' : 'Next question ➜'}</button></div></div>`;
        if (wait) setTimeout(() => { if (S.panel === 'quiz' && S.quiz.result === result) renderPanel(); }, wait + 30);
      }
    }
    body = `<div class="question"><div class="meta"><span>Year ${q.year} · English</span><span class="cost">🪙 +${q.reward}</span></div>${esc(q.text)}</div>
      <div class="answers">${answers}</div>${fb}`;
  }
  return `<div id="quiz-head">${quizHeaderHtml()}</div>${body}
    <p class="muted small center">Harder years pay more. Streaks add up to +${C.STREAK_MAX * C.STREAK_BONUS * 100}%. Wrong answers pause for a moment.</p>`;
}

async function fetchQuestion() {
  if (S.quiz.busy || !canPlay()) return;
  S.quiz.busy = true;
  const r = await act('quiz', { year: S.quiz.year });
  S.quiz.busy = false;
  if (r.error === 'wait') { setTimeout(fetchQuestion, r.wait + 50); return; }
  if (r.error) return;
  S.quiz.q = r;
  S.quiz.result = null;
  if (S.panel === 'quiz') renderPanel();
}

async function answerQuiz(i) {
  const q = S.quiz.q;
  if (!q || S.quiz.result) return;
  S.quiz.result = { pending: true, choice: i };
  const r = await act('answer', { qid: q.qid, choice: i });
  if (r.error) { S.quiz.q = null; S.quiz.result = null; fetchQuestion(); return; }
  const result = { ...r, choice: i };
  S.quiz.result = result;
  const btn = document.querySelector('.nav-btn.quiz').getBoundingClientRect();
  if (r.correct) {
    sfx.play('correct');
    floater(btn.left + btn.width / 2, btn.top - 10, `+${r.reward} 🪙`, true);
    setTimeout(() => { if (S.quiz.result === result) nextQuestion(); }, 1500);
  } else {
    sfx.play('wrong');
    S.quiz.waitUntil = Date.now() + (r.cooldown || 0);
  }
  if (S.panel === 'quiz') renderPanel();
}

function nextQuestion() {
  if (S.quiz.result && !S.quiz.result.correct && Date.now() < S.quiz.waitUntil) return;
  S.quiz.q = null;
  S.quiz.result = null;
  if (S.panel === 'quiz') renderPanel();
  fetchQuestion();
}

// Build
function buildHtml() {
  const me = S.me;
  const L = me.cmdLevel;
  const building = phase() === 'build';
  const cmd = me.buildings.find((b) => b.type === 'command');
  const cmdCost = C.upgradeCost('command', L);
  const head = `
    <div class="box row">
      <div class="big-ic">🏰</div>
      <div class="grow"><b>Central Command</b> <span class="muted">Lv ${L}</span>
        <div class="small muted">${L < C.MAX_LEVEL ? 'Upgrade to unlock more buildings and higher levels.' : 'Max level!'}</div></div>
      <button class="btn small" data-act="select" data-id="${cmd?.id}">Details</button>
    </div>
    ${building ? '' : '<div class="box small">🔒 Building is locked during PVP. You can still train units and answer quizzes!</div>'}
    <div class="tabs">${Object.entries(BUILD_TABS).map(([k, t]) => `<button class="${k === S.buildTab ? 'on' : ''}" data-act="build-tab" data-tab="${k}">${t.label}</button>`).join('')}</div>`;
  const items = BUILD_TABS[S.buildTab].types.map((t) => {
    const d = C.BUILDINGS[t];
    const count = me.buildings.filter((b) => b.type === t).length;
    const limit = C.LIMITS[t][L - 1];
    const afford = displayCoins() >= d.cost;
    const ok = building && count < limit && afford;
    const lockMsg = limit === 0 ? `Command Lv ${C.LIMITS[t].findIndex((n) => n > 0) + 1}` : `${count}/${limit}`;
    return `<button class="item" data-act="place" data-type="${t}" ${ok ? '' : 'disabled'}>
      <span class="ic">${d.icon}</span><span class="nm">${d.name}</span><span class="ds">${d.desc}</span>
      <span class="ft"><span class="cost ${afford ? '' : 'no'}">🪙${fmt(d.cost)}</span><span>${lockMsg}</span></span></button>`;
  }).join('');
  let extra = '';
  if (S.buildTab === 'economy') {
    const cost = C.tapUpgradeCost(me.tapLevel);
    const max = me.tapLevel >= C.TAP_MAX_LEVEL;
    extra = `<div class="box row" style="margin-top:10px">
      <div class="big-ic">👆</div>
      <div class="grow"><b>Tap Power</b> <span class="muted">Lv ${me.tapLevel}</span><div class="small muted">+${me.tapLevel} coins per tap${max ? '' : ` → +${me.tapLevel + 1}`}</div></div>
      <button class="btn small gold" data-act="tap-upgrade" ${max || displayCoins() < cost ? 'disabled' : ''}>${max ? 'MAX' : `🪙${fmt(cost)}`}</button></div>`;
  }
  return head + `<div class="grid">${items}</div>` + extra;
}

// Army
function armyHtml() {
  const me = S.me;
  const caps = me.caps;
  const building = phase() === 'build';
  const bar = (used, cap, sea) => `<div class="bar ${sea ? 'sea' : ''}"><i style="width:${cap ? Math.min(100, (used / cap) * 100) : 0}%"></i></div>`;
  const head = `<div class="box">
      <div class="row"><span class="grow">⛺ Land troops</span><b>${caps.landUsed}/${caps.land}</b></div>${bar(caps.landUsed, caps.land)}
      <div class="row" style="margin-top:6px"><span class="grow">⚓ Warships</span><b>${caps.seaUsed}/${caps.sea}</b></div>${bar(caps.seaUsed, caps.sea, true)}
      <div class="small muted" style="margin-top:4px">Build or upgrade Barracks and Shipyards for more space and stronger upgrades.</div>
    </div>`;
  const cards = C.UNIT_TYPES.map((t) => {
    const u = C.UNITS[t];
    const lv = me.unitLevels[t];
    const st = C.unitStats(t, lv);
    const homeType = u.domain === 'land' ? 'barracks' : 'shipyard';
    const homeLv = Math.max(0, ...me.buildings.filter((b) => b.type === homeType).map((b) => b.level));
    const free = u.domain === 'land' ? caps.land - caps.landUsed : caps.sea - caps.seaUsed;
    const can1 = free >= u.space && displayCoins() >= u.cost && canPlay();
    const can5 = free >= u.space * 5 && displayCoins() >= u.cost * 5 && canPlay();
    const upCost = C.unitUpgradeCost(t, lv);
    const canUp = building && lv < C.MAX_LEVEL && lv < homeLv && displayCoins() >= upCost;
    const upLabel = lv >= C.MAX_LEVEL ? 'MAX' : lv >= homeLv ? `Needs ${C.BUILDINGS[homeType].name} Lv${lv + 1}` : `⬆ Lv${lv + 1} 🪙${fmt(upCost)}`;
    return `<div class="unit">
      <div class="row"><span class="big-ic">${u.icon}</span>
        <div class="grow"><b>${u.name}</b> <span class="lv">Lv ${lv}</span> <span class="small muted">${u.domain === 'sea' ? '⚓ sea' : '⛺ land'} · space ${u.space}</span>
        <div class="small muted">${u.desc}</div></div>
        <span class="own">×${me.army[t]}</span></div>
      <div class="small muted">❤️ ${st.hp} · ⚔️ ${st.dmg}${st.splash ? ' splash' : ''} · 🎯 ${st.range} · 🏃 ${st.speed}</div>
      <div class="btn-row" style="margin-top:6px">
        <button class="btn primary" data-act="train" data-type="${t}" data-n="1" ${can1 ? '' : 'disabled'}>+1 🪙${u.cost}</button>
        <button class="btn primary" data-act="train" data-type="${t}" data-n="5" ${can5 ? '' : 'disabled'}>+5 🪙${u.cost * 5}</button>
        <button class="btn gold" data-act="unit-upgrade" data-type="${t}" ${canUp ? '' : 'disabled'}>${upLabel}</button>
      </div></div>`;
  }).join('');
  return head + cards;
}

// Building info
function infoHtml(b) {
  const me = S.me;
  const d = C.BUILDINGS[b.type];
  const st = C.buildingStats(b.type, b.level);
  const max = b.level >= C.MAX_LEVEL;
  const nx = max ? null : C.buildingStats(b.type, b.level + 1);
  const line = (label, key, fmtv = (v) => v) => st[key] ? `<div><span>${label}</span> <b>${fmtv(st[key])}</b>${nx && nx[key] !== st[key] ? ` <span class="up">→ ${fmtv(nx[key])}</span>` : ''}</div>` : '';
  const stats = [
    line('❤️ HP', 'hp'),
    line('⚔️ Damage', 'dmg'),
    st.rate ? `<div><span>⏱️ Shots/s</span> <b>${st.rate}</b></div>` : '',
    line('🎯 Range', 'range', (v) => v.toFixed(1)),
    st.splash ? `<div><span>💥 Splash</span> <b>${st.splash}</b></div>` : '',
    st.targets.length ? `<div><span>Targets</span> <b>${st.targets.map((t) => (t === 'land' ? '⛺' : '⚓')).join(' ')}</b></div>` : '',
    line('🪙 Coins/s', 'income'),
    line('📦 Storage', 'store'),
    line('⛺ Troop space', 'landCap'),
    line('⚓ Ship space', 'seaCap'),
    line('📚 Quiz bonus', 'quizBonus', (v) => `+${Math.round(v * 100)}%`),
    line('💂 Guards', 'guards'),
  ].join('');
  const building = phase() === 'build';
  const cost = C.upgradeCost(b.type, b.level);
  const needCmd = b.type !== 'command' && b.level >= me.cmdLevel;
  const canUp = building && !max && !needCmd && displayCoins() >= cost;
  const upLabel = max ? 'Max level' : needCmd ? `Needs Command Lv${b.level + 1}` : `⬆ Upgrade to Lv${b.level + 1} · 🪙${fmt(cost)}`;
  let mint = '';
  if (b.type === 'mint') {
    mint = `<div class="box row"><span class="grow">🪙 Stored <b>${b.stored}</b> / ${st.store}</span>
      <button class="btn small gold" data-act="collect" data-id="${b.id}" ${b.stored >= 1 ? '' : 'disabled'}>Collect</button></div>`;
  }
  let cmdNote = '';
  if (b.type === 'command' && !max) {
    const unlocks = Object.keys(C.LIMITS).filter((t) => C.LIMITS[t][b.level] > C.LIMITS[t][b.level - 1])
      .map((t) => `${C.BUILDINGS[t].icon} ${C.LIMITS[t][b.level - 1] === 0 ? 'unlock' : `+${C.LIMITS[t][b.level] - C.LIMITS[t][b.level - 1]}`}`).join(' · ');
    cmdNote = `<div class="box small">Next level: ${unlocks} · all buildings can reach Lv${b.level + 1}</div>`;
  }
  return `<div class="box"><div class="row"><span class="big-ic">${d.icon}</span><div class="grow"><b>${d.name}</b> <span class="lv">Lv ${b.level}</span>
      <div class="small muted">${d.desc}</div></div></div>
      <div class="stats">${stats}</div></div>
    ${mint}${cmdNote}
    ${building ? '' : '<div class="box small">🔒 Upgrades, moving and demolishing are locked during PVP.</div>'}
    <div class="btn-col">
      <button class="btn gold" data-act="upgrade" data-id="${b.id}" ${canUp ? '' : 'disabled'}>${upLabel}</button>
      ${b.type === 'command' ? '' : `<div class="btn-row">
        <button class="btn blue" data-act="move" data-id="${b.id}" ${building ? '' : 'disabled'}>✥ Move</button>
        <button class="btn danger" data-act="sell" data-id="${b.id}" ${building ? '' : 'disabled'}>🗑 Demolish +${fmt(Math.floor(b.spent * 0.5))}</button>
      </div>`}
    </div>`;
}

// Attack / islands
function attackHtml() {
  const r = S.room;
  const pvp = r.phase === 'pvp';
  const foes = r.players.filter((p) => p.id !== S.myId);
  const armyTotal = S.me ? C.UNIT_TYPES.reduce((s, t) => s + S.me.army[t], 0) : 0;
  return `<div class="box small">${pvp
    ? (S.me.alive ? `⚔️ PVP is live! Pick an island, then deploy units. You have <b>${armyTotal}</b> units ready.` : '💥 Your Command fell - you can still watch.')
    : '🔨 Build phase: scout enemy islands to plan your raid. Attacks open in the PVP phase.'}</div>
    ${foes.map((p) => `<div class="box">
      <div class="row"><span class="dot" style="width:16px;height:16px;border-radius:50%;background:${color(p.colorIdx)};display:inline-block"></span>
        <div class="grow"><b>${p.isBot ? '🤖 ' : ''}${esc(p.name)}</b> <span class="muted small">Command Lv${p.cmdLevel} · score ${p.score}</span></div>
        ${p.alive
    ? `<button class="btn small ${pvp && S.me.alive ? 'danger' : 'blue'}" data-act="view" data-id="${p.id}">${pvp && S.me.alive ? '⚔️ Attack' : '👁️ Scout'}</button>`
    : '<span class="muted">💀 Fallen</span>'}
      </div>
      ${pvp && p.alive ? `<div class="small muted" style="margin-top:4px">Command HP ${p.cmdHp}% · ${p.destroyed}% destroyed</div><div class="bar"><i style="width:${p.cmdHp}%;background:var(--red)"></i></div>` : ''}
    </div>`).join('')}`;
}

function menuHtml() {
  return `<div class="btn-col">
      <button class="btn blue" data-act="reset-cam">🎥 Reset camera</button>
      <button class="btn" data-act="home">🏝️ View my island</button>
      <button class="btn danger" data-act="leave-game">🚪 Leave game</button>
    </div>
    <div class="box small" style="margin-top:14px">
      <b>How to win</b><br>
      Destroy enemy <b>Central Commands</b> - the last island standing wins. If the rounds run out, the highest War Score wins
      (+10 per building destroyed, +50 per Command, +1 per invader your defences stop).<br><br>
      <b>Tips</b><br>
      📚 Quiz answers pay far more than tapping - and harder years pay most.<br>
      🧱 Walls slow troops; archers shoot over them, sappers blow them up.<br>
      🗼 Coastal Batteries and 🌀 Sea Mines stop warships. 💣 Mortars shred groups of troops.<br>
      🚢 Ships can only hit buildings near the coast - you need land troops to reach a central Command.<br>
      🪙 Tap Coin Mints to collect, and tap your Command for bonus coins.
    </div>`;
}

// ---------- Overlays ----------
function showReport(r) {
  const parts = [];
  if (r.deployed) parts.push(`⚔️ Destroyed ${r.destroyed} buildings (+${fmt(r.loot)} 🪙), lost ${r.lost} units`);
  else parts.push('⚔️ You launched no strikes this round');
  parts.push(`🛡️ Defences stopped ${r.kills} invaders (+${fmt(r.bounty)} 🪙)`);
  toast(`<b>Round ${r.round} report</b><br>${parts.join('<br>')}`, 'big', 7000, true);
}

function showGameOver(res) {
  const el = $('#overlay');
  const won = res.winnerId === S.myId;
  const host = S.room?.hostId === S.myId;
  el.innerHTML = `<div class="card">
    <h2 class="result-title">${won ? '🏆 Victory!' : '🏴‍☠️ Game Over'}</h2>
    <p class="center">${won ? 'Your island rules the seas!' : `<b>${esc(res.winnerName)}</b> wins the war!`}
      <br><span class="muted small">${res.reason === 'command' ? 'Last Central Command standing.' : 'Rounds complete - highest War Score wins.'}</span></p>
    ${res.ranking.map((p, i) => `<div class="rank"><b>#${i + 1}</b><span class="dot" style="background:${color(p.colorIdx)}"></span>
      <span>${p.isBot ? '🤖 ' : ''}${esc(p.name)} ${p.alive ? '' : '💀'}<br><span class="muted small">📚 ${p.correct}/${p.answered} quiz</span></span><b class="cost">${p.score}</b></div>`).join('')}
    <div class="btn-row" style="margin-top:12px">
      ${host ? '<button class="btn primary" data-act="rematch">🔁 Play again</button>' : '<span class="muted small center" style="flex:1">Waiting for the host to start a rematch…</span>'}
      <button class="btn" data-act="leave-game">🏝️ Main menu</button>
    </div></div>`;
  el.classList.remove('hidden');
  sfx.play(won ? 'correct' : 'phase');
}

function showBanner(text, sub = '') {
  const b = $('#banner');
  b.innerHTML = `${text}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  b.classList.add('hidden');
  void b.offsetWidth;
  b.classList.remove('hidden');
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => b.classList.add('hidden'), 2700);
}

function toast(msg, kind = 'info', ms = 2800, html = false) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  if (html) t.innerHTML = msg;
  else t.textContent = msg;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.remove(), kind === 'big' ? Math.max(ms, 4500) : ms);
}

function floater(x, y, text, big = false) {
  const f = document.createElement('span');
  f.className = `floater ${big ? 'big' : ''}`;
  f.textContent = text;
  f.style.left = `${x}px`;
  f.style.top = `${y}px`;
  $('#floaters').appendChild(f);
  setTimeout(() => f.remove(), 900);
}

// ---------- UI events ----------
function playerName() {
  const v = $('#name').value.trim();
  if (v) local.set('ciw-name', v);
  return v || $('#name').placeholder;
}

async function leaveGame() {
  socket.emit('leave');
  session.del('ciw-token');
  S.myId = null;
  S.lastPhaseKey = '';
  S.quiz.q = null;
  S.quiz.result = null;
  setMode('idle');
  showTitle();
}

const ACTIONS = {
  quick: () => emitAck('quick', { name: playerName() }),
  practice: () => emitAck('create', { name: playerName(), bots: 1, settings: { buildMin: 3, pvpMin: 2, rounds: 3, maxPlayers: 4 } }),
  create: () => emitAck('create', { name: playerName() }),
  join: () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Enter the 4-letter room code.', 'error');
    emitAck('join', { name: playerName(), code });
  },
  leave: leaveGame,
  'leave-game': () => { $('#overlay').classList.add('hidden'); leaveGame(); },
  'copy-code': () => {
    const url = `${location.origin}/?room=${S.room?.code}`;
    navigator.clipboard?.writeText(url).then(() => toast('Invite link copied!', 'good'), () => toast(`Code: ${S.room?.code}`));
  },
  'add-bot': () => act('addBot'),
  kick: (d) => act('kick', { id: d.id }),
  start: () => act('start'),
  rematch: () => act('rematch'),
  open: (d) => openPanel(d.panel),
  close: closeSheet,
  menu: () => openPanel('menu'),
  'toggle-players': () => $('#players').classList.toggle('collapsed'),
  mute: () => {
    sfx.setMuted(!sfx.isMuted());
    $('#btn-mute').textContent = sfx.isMuted() ? '🔇' : '🔊';
  },
  'reset-cam': () => { world.resetCamera(); closeSheet(); },
  home: () => { closeSheet(); goHome(); },
  view: (d) => viewIsland(d.id),
  'quiz-year': (d) => {
    S.quiz.year = Number(d.year);
    local.set('ciw-year', String(S.quiz.year));
    $('#quiz-hint').textContent = `+${estReward(S.quiz.year)}`;
    if (!S.quiz.result || S.quiz.result.correct || Date.now() >= S.quiz.waitUntil) nextQuestion();
    else renderPanel();
  },
  answer: (d) => answerQuiz(Number(d.i)),
  'quiz-next': nextQuestion,
  'build-tab': (d) => { S.buildTab = d.tab; renderPanel(); },
  place: (d) => startPlace(d.type),
  'place-cancel': () => setMode(S.view !== S.myId && phase() === 'pvp' ? 'deploy' : 'idle'),
  'place-confirm': () => {
    if (!S.pending) return;
    const pick = { x: S.pending.x, y: S.pending.y };
    if (S.mode === 'place') doBuild(S.placeType, pick.x, pick.y, pick);
    else if (S.mode === 'move') { S.pending = { ...pick }; moveTap({ ...pick }); }
  },
  select: (d) => selectBuilding(Number(d.id)),
  upgrade: async (d) => { const r = await act('upgrade', { id: Number(d.id) }); if (r.ok) { sfx.play('build'); world.bump(Number(d.id)); } },
  move: (d) => { closeSheet(); setMode('move', { id: Number(d.id) }); },
  sell: async (d) => { const r = await act('sell', { id: Number(d.id) }); if (r.ok) closeSheet(); },
  collect: async (d) => {
    const r = await act('collect', { id: Number(d.id) });
    if (r.ok && r.amount) { sfx.play('coin'); toast(`+${r.amount} 🪙 collected`, 'good', 1500); }
  },
  train: async (d) => { const r = await act('train', { type: d.type, n: Number(d.n) }); if (r.ok) sfx.play('build'); },
  'unit-upgrade': async (d) => { const r = await act('unitUpgrade', { type: d.type }); if (r.ok) sfx.play('correct'); },
  'tap-upgrade': async () => { const r = await act('tapUpgrade'); if (r.ok) sfx.play('correct'); },
  'deploy-type': (d) => { S.deployType = d.type; renderDeploy(); },
  'deploy-n': (d) => { S.deployN = Number(d.n); renderDeploy(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  sfx.unlock();
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset, el);
});
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Enter' && e.target.id === 'join-code') ACTIONS.join();
    return;
  }
  if (S.screen !== 'game') return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    const r = tapBtn.getBoundingClientRect();
    doTap(r.left + r.width / 2, r.top);
  } else if (k === 'q') openPanel('quiz');
  else if (k === 'b') openPanel('build');
  else if (k === 'a') openPanel('army');
  else if (k === 'h') goHome();
  else if (k === 'escape') {
    if (S.mode === 'place' || S.mode === 'move') ACTIONS['place-cancel']();
    else closeSheet();
  } else if (S.panel === 'quiz' && ['1', '2', '3', '4'].includes(k)) answerQuiz(Number(k) - 1);
  else if (S.panel === 'quiz' && k === 'enter') nextQuestion();
});

// ---------- Boot ----------
const savedName = local.get('ciw-name');
const ADJ = ['Brave', 'Salty', 'Sunny', 'Mighty', 'Clever', 'Coral', 'Stormy', 'Lucky'];
const NOUN = ['Parrot', 'Gull', 'Turtle', 'Dolphin', 'Crab', 'Kraken', 'Pelican', 'Shark'];
$('#name').placeholder = `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
if (savedName) $('#name').value = savedName;
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) $('#join-code').value = roomParam.toUpperCase().slice(0, 4);
$('#btn-mute').textContent = sfx.isMuted() ? '🔇' : '🔊';
showScreen('title');
