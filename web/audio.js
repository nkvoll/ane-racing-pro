/**
 * Web Audio — procedural SFX + light background loop (no external files).
 */

let ctx = null;
let masterGain = null;
/** All SFX route through this so volume slider affects sound effects only. */
let sfxBus = null;
let musicGain = null;
/** Voices → DC cut → treble softening → gentle dynamics → music fader. */
let musicHp = null;
let musicLp = null;
let musicComp = null;
/* Scaled by music slider 0–1; was ~0.12 (too quiet vs SFX). */
const BASE_MUSIC_GAIN = 0.4;
let sfxVolume = 1;
let musicVolume = 1;
let musicPhase = 0;
let musicAcc = 0;
const MUSIC_STEP = 0.17;

export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    masterGain.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = sfxVolume;
    sfxBus.connect(masterGain);
    musicGain = ctx.createGain();
    musicGain.gain.value = musicVolume * BASE_MUSIC_GAIN;
    musicHp = ctx.createBiquadFilter();
    musicHp.type = "highpass";
    musicHp.frequency.value = 30;
    musicHp.Q.value = 0.707;
    musicLp = ctx.createBiquadFilter();
    musicLp.type = "lowpass";
    musicLp.frequency.value = 10800;
    musicLp.Q.value = 0.707;
    musicComp = ctx.createDynamicsCompressor();
    musicComp.threshold.value = -22;
    musicComp.knee.value = 36;
    musicComp.ratio.value = 2.2;
    musicComp.attack.value = 0.015;
    musicComp.release.value = 0.22;
    musicHp.connect(musicLp);
    musicLp.connect(musicComp);
    musicComp.connect(musicGain);
    musicGain.connect(masterGain);
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

/** Linear 0–1; persisted by the game (localStorage). */
export function setSfxVolume(v) {
  sfxVolume = Math.max(0, Math.min(1, v));
  if (sfxBus) sfxBus.gain.value = sfxVolume;
}

/** Linear 0–1; persisted by the game (localStorage). */
export function setMusicVolume(v) {
  musicVolume = Math.max(0, Math.min(1, v));
  if (musicGain) musicGain.gain.value = musicVolume * BASE_MUSIC_GAIN;
}

export function getSfxVolume() {
  return sfxVolume;
}

export function getMusicVolume() {
  return musicVolume;
}

function sfxGain() {
  const g = ensureAudio().createGain();
  g.gain.value = 0.22;
  g.connect(sfxBus);
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

function connectMusicVoice(gainNode) {
  ensureAudio();
  gainNode.connect(musicHp);
}

/** Raised-cosine segments, starts/ends at 0 — no corners vs linear ramps (fewer tick artifacts). */
function buildNoteGainCurve(vol, durSec) {
  const c = ensureAudio();
  let atk = Math.min(0.02, durSec * 0.28);
  let rel = Math.min(0.055, durSec * 0.38);
  if (atk + rel > durSec * 0.98) {
    const s = (durSec * 0.98) / (atk + rel);
    atk *= s;
    rel *= s;
  }
  const sustain = Math.max(0, durSec - atk - rel);
  const totalDur = atk + sustain + rel;
  const nRaw = Math.ceil(totalDur * c.sampleRate * 1.25);
  const n = Math.min(512, Math.max(64, nRaw));
  const curve = new Float32Array(n);
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const x = (i / denom) * totalDur;
    let env;
    if (atk > 0 && x <= atk) {
      env = 0.5 - 0.5 * Math.cos((Math.PI * x) / atk);
    } else if (x <= atk + sustain) {
      env = 1;
    } else if (rel > 0) {
      const r = (x - atk - sustain) / rel;
      env = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, r)));
    } else {
      env = 0;
    }
    curve[i] = vol * env;
  }
  return { curve, totalDur };
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

/** 32 steps ≈ 5.4 s per loop at MUSIC_STEP (longer phrase, less frequent seam). */
const BASS_SEQ = [
  48, 48, 55, 52, 50, 57, 55, 52, 53, 60, 57, 55, 52, 57, 60, 64,
  62, 60, 57, 55, 53, 55, 57, 60, 57, 55, 53, 52, 50, 53, 55, 48,
];
const LEAD_SEQ = [
  72, 74, 76, 79, 77, 76, 74, 72, 74, 76, 79, 81, 79, 77, 76, 74,
  76, 77, 79, 81, 79, 77, 76, 74, 72, 74, 76, 77, 76, 74, 72, 72,
];
function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function playMusicNote(freq, type, vol, dur, when) {
  const c = ensureAudio();
  const t = Math.max(when, c.currentTime + 0.025);
  const { curve, totalDur } = buildNoteGainCurve(vol, dur);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0, t);
  g.gain.setValueCurveAtTime(curve, t, totalDur);
  o.connect(g);
  connectMusicVoice(g);
  o.start(t);
  o.stop(t + totalDur + 0.04);
}

export function updateMusic(dt) {
  const c = ensureAudio();
  musicAcc += dt;

  let musicCatchUp = 0;
  while (musicAcc >= MUSIC_STEP) {
    musicAcc -= MUSIC_STEP;
    const t0 = c.currentTime;
    const i = musicPhase % BASS_SEQ.length;
    const tb = t0 + 0.02 + musicCatchUp * MUSIC_STEP;
    musicCatchUp++;
    /* Slightly shorter bass vs step interval + staggered catch-up avoids stacked peaks (clipping). */
    playMusicNote(midiToHz(BASS_SEQ[i]), "triangle", 0.15, 0.15, tb);
    if (musicPhase % 2 === 0) {
      playMusicNote(midiToHz(LEAD_SEQ[i]), "sine", 0.075, 0.13, tb + 0.01);
    }
    if (musicPhase % 4 === 2) {
      playMusicNote(midiToHz(LEAD_SEQ[(i + 4) % LEAD_SEQ.length]) * 0.5, "triangle", 0.05, 0.11, tb);
    }
    musicPhase++;
  }
}
