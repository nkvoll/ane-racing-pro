/**
 * Track centerline control points (closed loops) for Ane Racing PRO.
 * Layouts use dense samples so the piecewise-linear centerline still reads as smooth curves.
 */

const TAU = Math.PI * 2;

/** Smooth bowtie — twin long straights through a pinched waist (original circuit). */
export function buildSmoothBowtieControl(numPoints) {
  const pts = [];
  const n = Math.max(28, numPoints | 0);
  const a = 818;
  const b = 702;
  const pinch = 0.24;
  const wobble = 0.038;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * TAU;
    const rScale = 1 + pinch * Math.cos(2 * t);
    let x = a * Math.sin(t) * rScale;
    let y = b * Math.cos(t);
    x *= 1 + wobble * Math.sin(3 * t);
    y *= 1 + wobble * 0.55 * Math.cos(3 * t);
    pts.push({ x, y });
  }
  return pts;
}

function ringPolar(n, rFn) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * TAU;
    const r = rFn(t);
    pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
  }
  return pts;
}

/** Pure elongated ellipse — high-speed sweepers, minimal direction changes. */
function ovalSpeedwayPoints() {
  return ringPolar(60, (t) => {
    const a = 1050;
    const b = 640;
    return (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
  });
}

/** Tri-lobed polar — three distinct apex pods (technical rhythm). */
function triLobe() {
  return ringPolar(54, (t) => 760 + 215 * Math.cos(3 * t));
}

/** Quattro — four equal tightening bends (kite / + rhythm). */
function quattroLobe() {
  return ringPolar(56, (t) => 665 + 255 * Math.cos(4 * t));
}

/** Vertical peanut — dramatic narrow waist, wide ends (different from bowtie orientation). */
function peanutTall() {
  const pts = [];
  const n = 52;
  const a = 520;
  const b = 880;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * TAU;
    const pinch = 0.38;
    const rScale = 1 + pinch * Math.cos(2 * t);
    pts.push({
      x: a * Math.sin(t) * rScale * 1.12,
      y: b * Math.cos(t),
    });
  }
  return pts;
}

/** Asymmetric GP — one long fast leg + mixed-radius complex (unique lap rhythm). */
function asymmetricGP() {
  const pts = [];
  const n = 56;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * TAU;
    let x = 940 * Math.cos(t) + 140 * Math.cos(2 * t) - 40 * Math.cos(t * 3);
    let y = 620 * Math.sin(t) + 100 * Math.sin(2 * t);
    pts.push({ x, y });
  }
  return pts;
}

/** Five-bump “ribbon” — frequent direction changes, mid-speed. */
function pentacrown() {
  return ringPolar(58, (t) => 720 + 130 * Math.cos(5 * t));
}

/**
 * Rounded stadium: two long straights + 180° ends.
 * Concatenates segments without duplicate corner vertices — repeats broke the layout mesh
 * (self-crossing ribbons / “walls over the field”, especially bottom-right).
 */
function stadiumControl() {
  const L = 520;
  const R = 358;
  const nStr = 10;
  const nArc = 16;

  const bottom = [];
  for (let i = 0; i < nStr; i++) {
    const t = i / (nStr - 1);
    bottom.push({ x: (t * 2 - 1) * L, y: -R });
  }

  const rightArc = [];
  for (let k = 0; k <= nArc; k++) {
    const a = -Math.PI / 2 + (Math.PI * k) / nArc;
    rightArc.push({ x: L + R * Math.cos(a), y: R * Math.sin(a) });
  }

  const top = [];
  for (let i = 0; i <= nStr; i++) {
    const t = i / nStr;
    top.push({ x: L - t * 2 * L, y: R });
  }

  const leftArc = [];
  for (let k = 0; k <= nArc; k++) {
    const a = Math.PI / 2 + (Math.PI * k) / nArc;
    leftArc.push({ x: -L + R * Math.cos(a), y: R * Math.sin(a) });
  }

  const pts = [];
  pts.push(...bottom);
  pts.push(...rightArc.slice(1));
  pts.push(...top.slice(1));
  pts.push(...leftArc.slice(1));

  if (pts.length > 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1) {
      pts.pop();
    }
  }
  return pts;
}

/** Squircle-like — predictable apexes, office-park feel. */
function squircleCircuit() {
  const pts = [];
  const n = 56;
  const a = 820;
  const b = 680;
  const p = 3.2;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * TAU;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ax = Math.abs(c) ** (2 / p) * Math.sign(c) * a;
    const ay = Math.abs(s) ** (2 / p) * Math.sign(s) * b;
    pts.push({ x: ax, y: ay });
  }
  return pts;
}

/** Teardrop — one tight bulb + long open arc (polar radius varies once per lap). */
function tearDropLoop() {
  return ringPolar(54, (t) => 620 + 280 * Math.sin(t * 0.5) ** 2);
}

/**
 * @typedef {{ uid: string, id: string, name: string, tagline: string, widthScale?: number, buildControl: () => {x:number,y:number}[] }} LevelDef
 * Stable `uid` (UUID) is used for saves and caches — safe across reordering. `id` is a short slug for humans / migration.
 * @type {LevelDef[]}
 */
export const LEVELS = [
  {
    uid: "a7e3b2c1-7d4e-41f0-9c2a-8b1e6d3c5a00",
    id: "neon_infinity",
    name: "Neon Infinity",
    tagline: "Twin apexes · classic flowing ∞",
    buildControl: () => buildSmoothBowtieControl(48),
  },
  {
    uid: "b2f8a4d3-2e5b-42c1-a8f9-1c2d3e4f5b01",
    id: "azure_oval",
    name: "Azure Oval",
    tagline: "Wide-open sweepers · pace management",
    buildControl: () => ovalSpeedwayPoints(),
  },
  {
    uid: "c9a1e6f4-8c2d-43e7-b0a4-9f8e7d6c5b02",
    id: "titan_stadium",
    name: "Titan Stadium",
    tagline: "Long straights · heavy braking into bends",
    buildControl: () => stadiumControl(),
  },
  {
    uid: "d4b7c8e2-1f6a-44d3-c5b8-0a1b2c3d4e03",
    id: "trident_circuit",
    name: "Trident Circuit",
    tagline: "Three-lobe cadence · technical",
    buildControl: () => triLobe(),
  },
  {
    uid: "e1c9d2a6-5e8f-45c4-d9a7-1b2c3d4e5f04",
    id: "quattro_cross",
    name: "Quattro Cross",
    tagline: "Four equal pulses · metronome laps",
    buildControl: () => quattroLobe(),
  },
  {
    uid: "f6d3e7b1-9a4c-46f8-e0b9-2c3d4e5f6a05",
    id: "quantum_peanut",
    name: "Quantum Peanut",
    tagline: "Vertical waist squeeze · momentum game",
    buildControl: () => peanutTall(),
  },
  {
    uid: "0a8e4f2c-7b1d-47a9-f1c0-3d4e5f6a7b06",
    id: "solaris_gp",
    name: "Solaris GP",
    tagline: "Asymmetric · one long blast straight",
    buildControl: () => asymmetricGP(),
  },
  {
    uid: "1b9f5a3d-8c2e-48b0-a2d1-4e5f6a7b8c07",
    id: "pentagrid_ribbon",
    name: "Pentagrid Ribbon",
    tagline: "Five micro-crests · busy steering",
    buildControl: () => pentacrown(),
  },
  {
    uid: "2c0a6b4e-9d3f-49c1-b3e2-5f6a7b8c9d08",
    id: "ember_squircle",
    name: "Ember Squircle",
    tagline: "Soft corners · grippy rhythm",
    buildControl: () => squircleCircuit(),
  },
  {
    uid: "3d1b7c5f-0e4a-40d2-c4f3-6a7b8c9d0e09",
    id: "vortex_teardrop",
    name: "Vortex Teardrop",
    tagline: "One tight nose · long power arc home",
    buildControl: () => tearDropLoop(),
  },
];

/** @param {string} uid */
export function getLevelByUid(uid) {
  return LEVELS.find((L) => L.uid === uid) ?? LEVELS[0];
}

/** @param {string} slug @returns {LevelDef | undefined} */
export function getLevelBySlug(slug) {
  return LEVELS.find((L) => L.id === slug);
}
