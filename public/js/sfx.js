// Tiny synthesized sound effects (no audio files needed).
let ctx = null;
let muted = false;
const last = {};

try { muted = localStorage.getItem('ciw-muted') === '1'; } catch { /* storage unavailable */ }

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('ciw-muted', m ? '1' : '0'); } catch { /* storage unavailable */ }
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx?.state === 'suspended') ctx.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.15, slide = 0, delay = 0 } = {}) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, vol = 0.2, freq = 800) {
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

const SOUNDS = {
  tap: () => tone(880 + Math.random() * 120, 0.06, { type: 'triangle', vol: 0.08 }),
  coin: () => { tone(988, 0.08, { type: 'square', vol: 0.05 }); tone(1319, 0.18, { type: 'square', vol: 0.05, delay: 0.07 }); },
  correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.12, delay: i * 0.07 })),
  wrong: () => { tone(220, 0.25, { type: 'sawtooth', vol: 0.07, slide: -80 }); },
  build: () => { noise(0.12, 0.15, 1200); tone(330, 0.12, { type: 'square', vol: 0.05, delay: 0.05 }); },
  shot: () => noise(0.08, 0.06, 1800),
  mortar: () => tone(300, 0.3, { type: 'sine', vol: 0.06, slide: -200 }),
  boom: () => noise(0.35, 0.12, 500),
  trap: () => tone(1200, 0.1, { type: 'square', vol: 0.05, slide: -900 }),
  deploy: () => tone(440, 0.12, { type: 'triangle', vol: 0.1, slide: 220 }),
  phase: () => [392, 523, 659].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', vol: 0.06, delay: i * 0.12 })),
  error: () => tone(180, 0.15, { type: 'square', vol: 0.05 }),
};

const MIN_GAP = { shot: 60, boom: 90, mortar: 120, tap: 30 };

export function play(name) {
  if (muted || !ctx || ctx.state !== 'running' || !SOUNDS[name]) return;
  const now = performance.now();
  if (MIN_GAP[name] && now - (last[name] || 0) < MIN_GAP[name]) return;
  last[name] = now;
  SOUNDS[name]();
}
