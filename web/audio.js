/**
 * Web Audio — procedural SFX + light background loop (no external files).
 */

let ctx = null;
let masterGain = null;
let musicGain = null;
let musicPhase = 0;
let musicAcc = 0;
const MUSIC_STEP = 0.17;
let hatAcc = 0;

export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    masterGain.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.12;
    musicGain.connect(masterGain);
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function sfxGain() {
  const g = ensureAudio().createGain();
  g.gain.value = 0.22;
  g.connect(masterGain);
  return g;
}

function noiseBuffer(duration) {
  const c = ensureAudio();
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  return buf;
}

export function playCannon() {
  const c = ensureAudio();
  const o = c.createOscillator();
  const g = sfxGain();
  o.type = "square";
  o.frequency.setValueAtTime(880, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(220, c.currentTime + 0.06);
  g.gain.setValueAtTime(0.12, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08);
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.09);
}

export function playMissile() {
  const c = ensureAudio();
  const o = c.createOscillator();
  const g = sfxGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(180, c.currentTime);
  o.frequency.linearRampToValueAtTime(420, c.currentTime + 0.15);
  g.gain.setValueAtTime(0.1, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.2);
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.22);
}

export function playMineDrop() {
  const c = ensureAudio();
  const o = c.createOscillator();
  const g = sfxGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(140, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(90, c.currentTime + 0.12);
  g.gain.setValueAtTime(0.14, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.15);
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.16);
}

export function playPickup() {
  const c = ensureAudio();
  const notes = [523, 659, 784];
  notes.forEach((freq, i) => {
    const o = c.createOscillator();
    const g = sfxGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + i * 0.05);
    g.gain.linearRampToValueAtTime(0.1, c.currentTime + i * 0.05 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + i * 0.05 + 0.15);
    o.connect(g);
    o.start(c.currentTime + i * 0.05);
    o.stop(c.currentTime + i * 0.05 + 0.18);
  });
}

export function playHit() {
  const c = ensureAudio();
  const buf = noiseBuffer(0.08);
  const src = c.createBufferSource();
  const g = sfxGain();
  src.buffer = buf;
  g.gain.setValueAtTime(0.18, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08);
  src.connect(g);
  src.start();
}

export function playExplosion() {
  const c = ensureAudio();
  const buf = noiseBuffer(0.35);
  const src = c.createBufferSource();
  const g = sfxGain();
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(1200, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(80, c.currentTime + 0.3);
  src.buffer = buf;
  src.connect(f);
  f.connect(g);
  g.gain.setValueAtTime(0.35, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.35);
  src.start();
}

export function playWall() {
  const c = ensureAudio();
  const o = c.createOscillator();
  const g = sfxGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(95, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(45, c.currentTime + 0.1);
  g.gain.setValueAtTime(0.14, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.12);
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.14);
}

export function playLap() {
  const c = ensureAudio();
  const o = c.createOscillator();
  const g = sfxGain();
  o.type = "sine";
  o.frequency.setValueAtTime(392, c.currentTime);
  o.frequency.setValueAtTime(523, c.currentTime + 0.08);
  g.gain.setValueAtTime(0.12, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.35);
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.4);
}

const BASS_SEQ = [48, 48, 55, 52, 50, 57, 55, 52, 53, 60, 57, 55, 52, 57, 60, 64];
const LEAD_SEQ = [
  72, 74, 76, 79, 77, 76, 74, 72, 74, 76, 79, 81, 79, 77, 76, 74,
];
function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function playMusicNote(freq, type, vol, dur, when) {
  const c = ensureAudio();
  const t = Math.max(when, c.currentTime + 0.005);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g);
  g.connect(musicGain);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function playHiHat(when) {
  const c = ensureAudio();
  const t = Math.max(when, c.currentTime + 0.005);
  const buf = noiseBuffer(0.04);
  const src = c.createBufferSource();
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 7000;
  src.buffer = buf;
  src.connect(f);
  f.connect(g);
  g.gain.setValueAtTime(0.045, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
  g.connect(musicGain);
  src.start(t);
}

export function updateMusic(dt) {
  const c = ensureAudio();
  musicAcc += dt;
  hatAcc += dt;
  const hatStep = MUSIC_STEP * 0.5;

  while (musicAcc >= MUSIC_STEP) {
    musicAcc -= MUSIC_STEP;
    const t0 = c.currentTime;
    const i = musicPhase % BASS_SEQ.length;
    const tb = t0 + 0.02;
    playMusicNote(midiToHz(BASS_SEQ[i]), "triangle", 0.2, 0.2, tb);
    if (musicPhase % 2 === 0) {
      playMusicNote(midiToHz(LEAD_SEQ[i]), "sine", 0.09, 0.14, tb + 0.01);
    }
    if (musicPhase % 4 === 2) {
      playMusicNote(midiToHz(LEAD_SEQ[(i + 4) % LEAD_SEQ.length]) * 0.5, "triangle", 0.06, 0.12, tb);
    }
    musicPhase++;
  }

  while (hatAcc >= hatStep) {
    hatAcc -= hatStep;
    playHiHat(c.currentTime);
  }
}
