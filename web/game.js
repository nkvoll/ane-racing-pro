/**
 * Ane Racing PRO — top-down arcade racer
 */

import * as audio from "./audio.js";

const TAU = Math.PI * 2;

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hypot(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function buildClosedSpline(control, subdiv) {
  const n = control.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n];
    const p1 = control[i];
    const p2 = control[(i + 1) % n];
    const p3 = control[(i + 2) % n];
    for (let s = 0; s < subdiv; s++) {
      const t = s / subdiv;
      pts.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  return pts;
}

function rotateClosedPolyline(pts, k) {
  const n = pts.length;
  if (n === 0) return pts;
  k = ((k % n) + n) % n;
  if (k === 0) return pts.slice();
  return [...pts.slice(k), ...pts.slice(0, k)];
}

/** Index of the vertex at the start of the longest edge (best straight for S/F and wall health). */
function findLongestEdgeStartIndex(center) {
  const n = center.length;
  let bestI = 0;
  let bestLen = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = hypot(
      center[j].x - center[i].x,
      center[j].y - center[i].y
    );
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  return bestI;
}

/** 2D cross of (b-a) with (p-a) — sign tells which side of line AB point P is on. */
function crossLinePoint(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segmentIntersect(p1, p2, p3, p4) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const t =
    ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  const u =
    -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / d;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }
  return null;
}

function distPointSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 0 ? (apx * abx + apy * aby) / ab2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return hypot(px - qx, py - qy);
}

function circleHitsSegment(cx, cy, r, ax, ay, bx, by) {
  return distPointSegment(cx, cy, ax, ay, bx, by) < r;
}

/**
 * Smooth bowtie “∞” (two lobes + east/west waist). Scaled ~2× vs the original so a lap is ~2×
 * longer; gentler pinch + light 3rd-harmonic wobble add length without hairpins.
 * Closed simple curve — no self-intersection — so offset walls stay continuous.
 */
function buildSmoothBowtieControl(numPoints) {
  const pts = [];
  const n = Math.max(28, numPoints | 0);
  const a = 818;
  const b = 702;
  const pinch = 0.24;
  const wobble = 0.038;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const rScale = 1 + pinch * Math.cos(2 * t);
    let x = a * Math.sin(t) * rScale;
    let y = b * Math.cos(t);
    x *= 1 + wobble * Math.sin(3 * t);
    y *= 1 + wobble * 0.55 * Math.cos(3 * t);
    pts.push({ x, y });
  }
  return pts;
}

const CONTROL = buildSmoothBowtieControl(48);
const SUBDIV = 14;
const TRACK_WIDTH = 162;
const CAR_R = 16;

class Track {
  constructor() {
    const raw = buildClosedSpline(CONTROL, SUBDIV);
    const rot = findLongestEdgeStartIndex(raw);
    this.center = rotateClosedPolyline(raw, rot);
    this.n = this.center.length;
    this.width = TRACK_WIDTH;
    this.inner = [];
    this.outer = [];
    this.wallSegments = [];

    for (let i = 0; i < this.n; i++) {
      const p0 = this.center[(i - 1 + this.n) % this.n];
      const p1 = this.center[i];
      const p2 = this.center[(i + 1) % this.n];
      let tx = p2.x - p0.x;
      let ty = p2.y - p0.y;
      const len = hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const nx = -ty;
      const ny = tx;
      const hw = this.width * 0.5;
      this.outer.push({ x: p1.x + nx * hw, y: p1.y + ny * hw });
      this.inner.push({ x: p1.x - nx * hw, y: p1.y - ny * hw });
    }

    for (let i = 0; i < this.n; i++) {
      const j = (i + 1) % this.n;
      this.wallSegments.push(
        { a: this.outer[i], b: this.outer[j], inner: false },
        { a: this.inner[i], b: this.inner[j], inner: true }
      );
    }

    // Start / finish: perpendicular at index 0 (after rotation = start of longest straight).
    const t0 = this.tangent(0);
    const nx = -t0.y;
    const ny = t0.x;
    const hw = this.width * 0.5;
    const c0 = this.center[0];
    // Slightly wider than kerbs so the line spans the full drivable width even if normals wobble.
    const fw = hw * 1.12;
    this.finishLine = {
      a: { x: c0.x + nx * fw, y: c0.y + ny * fw },
      b: { x: c0.x - nx * fw, y: c0.y - ny * fw },
      tangent: { x: t0.x, y: t0.y },
    };

    // Sector: must sit on a wide part of the road. Half-lap vertices can land on tight inner
    // corners where offset wall *chords* cut across the centerline — pick max clearance to walls.
    const cumLen = [];
    let acc = 0;
    for (let i = 0; i < this.n; i++) {
      cumLen.push(acc);
      const j = (i + 1) % this.n;
      acc += hypot(
        this.center[j].x - this.center[i].x,
        this.center[j].y - this.center[i].y
      );
    }
    this.length = acc;

    const L = this.length;
    const lo = L * 0.38;
    const hi = L * 0.62;
    let bestMidI = Math.floor(this.n * 0.5) % this.n;
    let bestClear = -1;
    for (let i = 0; i < this.n; i++) {
      const s = cumLen[i];
      if (s < lo || s > hi) continue;
      const px = this.center[i].x;
      const py = this.center[i].y;
      let dmin = Infinity;
      for (const seg of this.wallSegments) {
        dmin = Math.min(
          dmin,
          distPointSegment(px, py, seg.a.x, seg.a.y, seg.b.x, seg.b.y)
        );
      }
      if (dmin > bestClear) {
        bestClear = dmin;
        bestMidI = i;
      }
    }

    this.midCheckpoint = {
      x: this.center[bestMidI].x,
      y: this.center[bestMidI].y,
      r: this.width * 1.2,
    };
  }

  tangent(i) {
    const p0 = this.center[(i - 1 + this.n) % this.n];
    const p2 = this.center[(i + 1) % this.n];
    let tx = p2.x - p0.x;
    let ty = p2.y - p0.y;
    const len = hypot(tx, ty) || 1;
    return { x: tx / len, y: ty / len };
  }
}

class Car {
  constructor(x, y, angle, color, isPlayer, aiOffset = 0) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = 0;
    this.vy = 0;
    this.color = color;
    this.isPlayer = isPlayer;
    this.aiOffset = aiOffset;
    this.aiWp = Math.floor(Math.random() * track.n);
    this.maxHp = 100;
    this.hp = 100;
    this.shieldT = 0;
    this.boostT = 0;
    this.ammoCannon = 18;
    this.ammoMissile = 0;
    this.ammoMines = 0;
    this.cdCannon = 0;
    this.cdMissile = 0;
    this.cdMine = 0;
    this.wreckT = 0;
    this.displayName = isPlayer ? "You" : "Rival";
    this.raceLap = 1;
    this.passedMid = false;
    this.prevX = x;
    this.prevY = y;
  }

  get speed() {
    return hypot(this.vx, this.vy);
  }

  get wrecked() {
    return this.wreckT > 0;
  }
}

function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return "--:--.--";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  const frac = Math.floor((s - whole) * 100);
  return `${m}:${whole.toString().padStart(2, "0")}.${frac.toString().padStart(2, "0")}`;
}

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const track = new Track();

/** Arc length from center[0] along the racing line to the closest point on the polyline (for position). */
function distanceAlongTrack(x, y) {
  const n = track.n;
  let acc = 0;
  let bestD = Infinity;
  let bestArc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = track.center[i].x;
    const ay = track.center[i].y;
    const bx = track.center[j].x;
    const by = track.center[j].y;
    const abx = bx - ax;
    const aby = by - ay;
    const segLen = hypot(abx, aby);
    const apx = x - ax;
    const apy = y - ay;
    const t =
      segLen > 1e-9 ? clamp((apx * abx + apy * aby) / (segLen * segLen), 0, 1) : 0;
    const qx = ax + abx * t;
    const qy = ay + aby * t;
    const d = hypot(x - qx, y - qy);
    const arc = acc + t * segLen;
    if (d < bestD) {
      bestD = d;
      bestArc = arc;
    }
    acc += segLen;
  }
  return bestArc;
}

function raceScore(car) {
  const arc = distanceAlongTrack(car.x, car.y);
  const base = (car.raceLap - 1) * track.length + arc;
  return car.wrecked ? base - 1e12 : base;
}

function computePlayerPlace() {
  const ranked = cars.map((c) => ({ c, s: raceScore(c) }));
  ranked.sort((a, b) => b.s - a.s);
  const idx = ranked.findIndex((x) => x.c === player);
  return { place: idx + 1, total: cars.length };
}

// Grid follows the actual centerline backward from S/F — straight-line math left the track on curves.
const GRID_LAT_MAX = track.width * 0.5 - CAR_R - 6;

/**
 * Walk backward along the polyline from center[0], then offset perpendicular to local forward.
 * @returns {{ x: number, y: number, angle: number }}
 */
function gridSlotAlongTrack(distanceBack, lateral) {
  const n = track.n;
  const lat = clamp(lateral, -GRID_LAT_MAX, GRID_LAT_MAX);
  let remaining = distanceBack;
  let i = 0;
  let px = track.center[0].x;
  let py = track.center[0].y;

  while (remaining > 1e-5) {
    const prev = (i - 1 + n) % n;
    const ax = track.center[i].x;
    const ay = track.center[i].y;
    const bx = track.center[prev].x;
    const by = track.center[prev].y;
    const dx = bx - ax;
    const dy = by - ay;
    const segLen = hypot(dx, dy);
    if (segLen < 1e-5) {
      i = prev;
      continue;
    }
    if (remaining >= segLen) {
      remaining -= segLen;
      i = prev;
      px = bx;
      py = by;
    } else {
      const t = remaining / segLen;
      px = ax + dx * t;
      py = ay + dy * t;
      const fx = -dx / segLen;
      const fy = -dy / segLen;
      const ang = Math.atan2(fy, fx);
      const nx = -fy;
      const ny = fx;
      return {
        x: px + nx * lat,
        y: py + ny * lat,
        angle: ang,
      };
    }
  }

  const tan = track.tangent(i);
  const ang = Math.atan2(tan.y, tan.x);
  const nx = -tan.y;
  const ny = tan.x;
  return {
    x: px + nx * lat,
    y: py + ny * lat,
    angle: ang,
  };
}

const GRID_LAT = GRID_LAT_MAX * 0.68;
const GRID_SLOTS = [
  gridSlotAlongTrack(172, -GRID_LAT * 0.72),
  gridSlotAlongTrack(172, GRID_LAT * 0.72),
  gridSlotAlongTrack(236, -GRID_LAT * 0.72),
  gridSlotAlongTrack(236, GRID_LAT * 0.72),
  gridSlotAlongTrack(324, 0),
];
const CAR_GRID_IDX = [4, 0, 1, 2, 3];

const colors = ["#00e5ff", "#ff4081", "#7cff7c", "#ffd54f", "#b388ff"];
const cars = [
  new Car(
    GRID_SLOTS[CAR_GRID_IDX[0]].x,
    GRID_SLOTS[CAR_GRID_IDX[0]].y,
    GRID_SLOTS[CAR_GRID_IDX[0]].angle,
    colors[0],
    true
  ),
  new Car(
    GRID_SLOTS[CAR_GRID_IDX[1]].x,
    GRID_SLOTS[CAR_GRID_IDX[1]].y,
    GRID_SLOTS[CAR_GRID_IDX[1]].angle,
    colors[1],
    false,
    0.12
  ),
  new Car(
    GRID_SLOTS[CAR_GRID_IDX[2]].x,
    GRID_SLOTS[CAR_GRID_IDX[2]].y,
    GRID_SLOTS[CAR_GRID_IDX[2]].angle,
    colors[2],
    false,
    -0.08
  ),
  new Car(
    GRID_SLOTS[CAR_GRID_IDX[3]].x,
    GRID_SLOTS[CAR_GRID_IDX[3]].y,
    GRID_SLOTS[CAR_GRID_IDX[3]].angle,
    colors[3],
    false,
    0.05
  ),
  new Car(
    GRID_SLOTS[CAR_GRID_IDX[4]].x,
    GRID_SLOTS[CAR_GRID_IDX[4]].y,
    GRID_SLOTS[CAR_GRID_IDX[4]].angle,
    colors[4],
    false,
    -0.15
  ),
];

const player = cars[0];
const DISPLAY_NAMES = ["You", "Nova", "Blaze", "Forge", "Echo"];
cars.forEach((c, i) => {
  c.displayName = DISPLAY_NAMES[i];
});

/** @type {{x:number,y:number,vx:number,vy:number,owner:Car,type:string,dmg:number,t:number,ignore:number}[]} */
const projectiles = [];
/** @type {{x:number,y:number,owner:Car,armed:number,r:number,age:number,ownerColor:string}[]} */
const mines = [];
/** @type {{x:number,y:number,kind:string,active:boolean,respawnAt:number}[]} */
const pickups = [];
/** @type {{x:number,y:number,vx:number,vy:number,life:number,color:string,r?:number}[]} */
const particles = [];

const COMBAT = {
  CD_CANNON: 0.14,
  CD_MISSILE: 1.1,
  CD_MINE: 0.85,
  PROJ_SPEED: 620,
  MISSILE_TURN: 5.2,
  MINE_ARM: 0.55,
  MINE_TRIGGER: 42,
  PICKUP_R: 26,
  PICKUP_RESPAWN: 9,
  WRECK_RESPAWN: 2.8,
};

let wallSoundAt = 0;

/** Labels / colors / on-track letter for each pickup type */
const PICKUP_META = {
  health_small: {
    toast: "REPAIR +38 HP",
    detail: "Restores 38 HP (not above max).",
    chat: "grabbed a Repair Pack",
    color: "#69f0ae",
    letter: "H",
  },
  health_full: {
    toast: "FULL RESTORE",
    detail: "Heals you to 100% HP instantly.",
    chat: "scored a FULL repair station",
    color: "#00e676",
    letter: "!",
  },
  cannon: {
    toast: "Plasma +22",
    detail: "Ammo for F — forward plasma shots.",
    chat: "picked up Plasma ammo",
    color: "#00e5ff",
    letter: "P",
  },
  cannon_volley: {
    toast: "Plasma BURST +40",
    detail: "Large plasma ammo pack for sustained fire.",
    chat: "found a plasma BURST crate",
    color: "#18ffff",
    letter: "B",
  },
  missile: {
    toast: "Missile +1",
    detail: "E — heat-seeker in your forward cone.",
    chat: "loaded a homing missile",
    color: "#ff4081",
    letter: "M",
  },
  missile_rack: {
    toast: "Missile RACK +2",
    detail: "Two homing missiles (E per shot).",
    chat: "raided a missile rack",
    color: "#f50057",
    letter: "R",
  },
  mine: {
    toast: "Mines +2",
    detail: "C — drops behind you; arms after a moment.",
    chat: "armed drop mines",
    color: "#ffd54f",
    letter: "D",
  },
  mine_cluster: {
    toast: "Mine CLUSTER +4",
    detail: "Four drop mines for area denial.",
    chat: "deployed a mine cluster crate",
    color: "#ffc400",
    letter: "X",
  },
  nitro: {
    toast: "NITRO boost",
    detail: "Short speed & accel boost (~2.6s).",
    chat: "hit the nitro",
    color: "#ff9100",
    letter: "N",
  },
  nitro_turbo: {
    toast: "TURBO nitro (long)",
    detail: "Longer nitro burn (~4.2s).",
    chat: "grabbed TURBO tanks",
    color: "#ff6d00",
    letter: "T",
  },
  shield: {
    toast: "Shield +5s",
    detail: "Blue ring — reduces incoming damage.",
    chat: "raised shields",
    color: "#536dfe",
    letter: "S",
  },
  shield_heavy: {
    toast: "HEAVY shield +8s",
    detail: "Stronger barrier for longer.",
    chat: "charged a heavy shield",
    color: "#7c4dff",
    letter: "8",
  },
};

function rollPickupKind() {
  const r = Math.random();
  if (r < 0.11) return "health_full";
  if (r < 0.28) return "health_small";
  if (r < 0.38) return "cannon_volley";
  if (r < 0.48) return "cannon";
  if (r < 0.55) return "missile_rack";
  if (r < 0.63) return "missile";
  if (r < 0.71) return "mine_cluster";
  if (r < 0.79) return "mine";
  if (r < 0.86) return "nitro_turbo";
  if (r < 0.92) return "nitro";
  if (r < 0.97) return "shield_heavy";
  return "shield";
}

const chatLines = [];
const CHAT_MAX_LINES = 48;
let pickupToastTimer = 0;
let chatTauntAcc = 0;
let chatTauntNext = 4;

function addChatLine(name, color, text) {
  chatLines.push({ name, color, text });
  while (chatLines.length > CHAT_MAX_LINES) chatLines.shift();
  renderChatLog();
}

function renderChatLog() {
  if (!chatLogEl) return;
  chatLogEl.innerHTML = "";
  for (const line of chatLines) {
    const row = document.createElement("div");
    row.className = "chat-line";
    const who = document.createElement("span");
    who.className = "chat-name";
    who.style.color = line.color;
    who.textContent = line.name;
    row.appendChild(who);
    row.appendChild(document.createTextNode(": " + line.text));
    chatLogEl.appendChild(row);
  }
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function notifyPickupCollected(car, kind) {
  const meta = PICKUP_META[kind] || {
    toast: kind,
    detail: "",
    chat: "picked up something",
    color: "#fff",
    letter: "?",
  };
  if (car.isPlayer) {
    addChatLine(
      car.displayName,
      car.color,
      `${meta.chat} — ${meta.toast}. ${meta.detail || ""}`
    );
    showPickupToast(meta.toast, meta.detail || "", meta.color);
  }
}

function showPickupToast(title, detail, color) {
  if (!pickupToastEl) return;
  if (pickupToastTitleEl) pickupToastTitleEl.textContent = title;
  if (pickupToastDescEl) pickupToastDescEl.textContent = detail;
  pickupToastEl.style.setProperty("--toast-accent", color);
  pickupToastEl.classList.remove("hidden");
  pickupToastEl.classList.add("pickup-toast-pop");
  clearTimeout(pickupToastTimer);
  pickupToastTimer = window.setTimeout(() => {
    pickupToastEl.classList.add("hidden");
    pickupToastEl.classList.remove("pickup-toast-pop");
  }, 3200);
}

function spawnBoostParticles(car, dt) {
  if (car.boostT <= 0 || car.wrecked) return;
  const n = car.isPlayer ? 3 + Math.floor(car.speed / 200) : 1;
  const bx = car.x - Math.cos(car.angle) * 24;
  const by = car.y - Math.sin(car.angle) * 24;
  for (let k = 0; k < n; k++) {
    const a = car.angle + Math.PI + (Math.random() - 0.5) * 1.1;
    const sp = (90 + car.speed * 0.25) * (0.45 + Math.random() * 0.55);
    particles.push({
      x: bx + (Math.random() - 0.5) * 10,
      y: by + (Math.random() - 0.5) * 10,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.2 + Math.random() * 0.22,
      color: Math.random() > 0.45 ? "#ffea00" : "#ff9100",
      r: 2.5 + Math.random() * 2,
    });
  }
}

const TAUNTS = {
  toPlayer: (from) => [
    `${from.displayName} says: eat my ions, human.`,
    `Hey You — ${from.displayName} is taking the inside line.`,
    `${from.displayName}: cute driving. Shame about the lap time.`,
    `You really letting ${from.displayName} bully you like that?`,
  ],
  toBot: (from, to) => [
    `${to.displayName}, ${from.displayName} is in your mirrors.`,
    `${from.displayName} to ${to.displayName}: draft or dust.`,
    `${to.displayName} — ${from.displayName} called dibs on that pickup.`,
    `${from.displayName} is painting ${to.displayName}'s tail.`,
  ],
  general: (from) => [
    `${from.displayName} is feeling spicy this lap.`,
    `Someone tell ${from.displayName} to chill the thrusters.`,
    `${from.displayName}: hold my steering column.`,
  ],
  wreck: (victim, speaker) => [
    `${speaker.displayName}: ${victim.displayName} just became scenery.`,
    `${victim.displayName} collected some air — ${speaker.displayName} approves.`,
  ],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function updateChatTaunts(dt) {
  if (state.mode !== "race") return;
  chatTauntAcc += dt;
  if (chatTauntAcc < chatTauntNext) return;
  chatTauntAcc = 0;
  chatTauntNext = 5 + Math.random() * 14;

  const alive = cars.filter((c) => !c.wrecked);
  if (alive.length < 2) return;
  const speakers = cars.filter((c) => !c.isPlayer && !c.wrecked);
  if (speakers.length === 0) return;
  const from = pickRandom(speakers);
  let lines;
  if (Math.random() < 0.42 && !player.wrecked) {
    lines = TAUNTS.toPlayer(from);
  } else {
    const others = alive.filter((c) => c !== from);
    const to = pickRandom(others);
    if (to !== from) {
      lines = TAUNTS.toBot(from, to);
    } else {
      lines = TAUNTS.general(from);
    }
  }
  addChatLine(from.displayName, from.color, pickRandom(lines));
}

function maybeWreckTaunt(victim) {
  const speakers = cars.filter((c) => c !== victim && !c.isPlayer && !c.wrecked);
  if (speakers.length === 0) return;
  const s = pickRandom(speakers);
  addChatLine(s.displayName, s.color, pickRandom(TAUNTS.wreck(victim, s)));
}

function initPickups() {
  pickups.length = 0;
  const slots = [0.1, 0.24, 0.38, 0.52, 0.66, 0.8, 0.93];
  for (const t of slots) {
    const idx = Math.floor(t * track.n) % track.n;
    const p = track.center[idx];
    pickups.push({
      x: p.x,
      y: p.y,
      kind: rollPickupKind(),
      active: true,
      respawnAt: 0,
    });
  }
}

function nearestCenterIndex(px, py) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < track.n; i++) {
    const d = hypot(px - track.center[i].x, py - track.center[i].y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function respawnCarOnTrack(car) {
  const i = nearestCenterIndex(car.x, car.y);
  const tan = track.tangent(i);
  const n = { x: -tan.y, y: tan.x };
  car.x = track.center[i].x + n.x * 8;
  car.y = track.center[i].y + n.y * 8;
  car.angle = Math.atan2(tan.y, tan.x);
  car.vx = 0;
  car.vy = 0;
  car.hp = car.maxHp;
  car.shieldT = 1.2;
  car.wreckT = 0;
  car.cdCannon = 0.3;
  car.cdMissile = 0.5;
  car.cdMine = 0.5;
}

function spawnParticles(x, y, n, color, spread = 120) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const s = spread * (0.3 + Math.random() * 0.7);
    particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.35 + Math.random() * 0.25,
      color,
    });
  }
}

function applyDamage(car, amount, hitPos) {
  if (amount <= 0 || car.wrecked) return;
  let a = amount;
  if (car.shieldT > 0) a *= 0.3;
  car.hp -= a;
  if (hitPos) spawnParticles(hitPos.x, hitPos.y, 4, "#ff7043", 180);
  if (car.hp <= 0) {
    car.hp = 0;
    car.vx = 0;
    car.vy = 0;
    car.wreckT = COMBAT.WRECK_RESPAWN;
    spawnParticles(car.x, car.y, 28, car.color, 260);
    try {
      maybeWreckTaunt(car);
    } catch (_) {}
    try {
      audio.playExplosion();
    } catch (_) {}
  } else if (a > 7) {
    try {
      audio.playHit();
    } catch (_) {}
  }
}

function applyPickup(car, kind) {
  switch (kind) {
    case "health_small":
      car.hp = clamp(car.hp + 38, 0, car.maxHp);
      break;
    case "health_full":
      car.hp = car.maxHp;
      break;
    case "cannon":
      car.ammoCannon += 22;
      break;
    case "cannon_volley":
      car.ammoCannon += 40;
      break;
    case "missile":
      car.ammoMissile += 1;
      break;
    case "missile_rack":
      car.ammoMissile += 2;
      break;
    case "mine":
      car.ammoMines += 2;
      break;
    case "mine_cluster":
      car.ammoMines += 4;
      break;
    case "nitro":
      car.boostT = Math.max(car.boostT, 2.6);
      break;
    case "nitro_turbo":
      car.boostT = Math.max(car.boostT, 4.2);
      break;
    case "shield":
      car.shieldT = Math.max(car.shieldT, 5);
      break;
    case "shield_heavy":
      car.shieldT = Math.max(car.shieldT, 8);
      break;
    default:
      break;
  }
  notifyPickupCollected(car, kind);
  try {
    audio.playPickup();
  } catch (_) {}
}

function updatePickups(nowSec) {
  for (const p of pickups) {
    if (!p.active) {
      if (nowSec >= p.respawnAt) {
        p.kind = rollPickupKind();
        p.active = true;
      }
      continue;
    }
    for (const car of cars) {
      if (car.wrecked) continue;
      if (hypot(car.x - p.x, car.y - p.y) < COMBAT.PICKUP_R + CAR_R) {
        applyPickup(car, p.kind);
        p.active = false;
        p.respawnAt = nowSec + COMBAT.PICKUP_RESPAWN;
        const pc = (PICKUP_META[p.kind] || {}).color || "#00e5ff";
        spawnParticles(p.x, p.y, 14, pc, 110);
        break;
      }
    }
  }
}

function trySpawnProjectile(car, type) {
  if (car.wrecked) return;
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const bx = car.x + fx * 26;
  const by = car.y + fy * 26;

  if (type === "cannon") {
    if (car.ammoCannon < 1 || car.cdCannon > 0) return;
    car.ammoCannon -= 1;
    car.cdCannon = COMBAT.CD_CANNON;
    projectiles.push({
      x: bx,
      y: by,
      vx: fx * COMBAT.PROJ_SPEED + car.vx * 0.35,
      vy: fy * COMBAT.PROJ_SPEED + car.vy * 0.35,
      owner: car,
      type: "cannon",
      dmg: 9,
      t: 1.35,
      ignore: 0.06,
    });
    spawnParticles(bx, by, 2, "#00e5ff", 40);
    try {
      audio.playCannon();
    } catch (_) {}
    return;
  }

  if (type === "missile") {
    if (car.ammoMissile < 1 || car.cdMissile > 0) return;
    car.ammoMissile -= 1;
    car.cdMissile = COMBAT.CD_MISSILE;
    let target = null;
    let best = Infinity;
    for (const o of cars) {
      if (o === car || o.wrecked) continue;
      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const dist = hypot(dx, dy);
      if (dist > 520 || dist < 40) continue;
      const ang = Math.atan2(dy, dx);
      const ad = Math.abs(wrapAngle(ang - car.angle));
      if (ad > 0.75) continue;
      if (dist < best) {
        best = dist;
        target = o;
      }
    }
    projectiles.push({
      x: bx,
      y: by,
      vx: fx * (COMBAT.PROJ_SPEED * 0.72) + car.vx * 0.2,
      vy: fy * (COMBAT.PROJ_SPEED * 0.72) + car.vy * 0.2,
      owner: car,
      type: "missile",
      dmg: 26,
      t: 2.4,
      ignore: 0.08,
      target,
    });
    spawnParticles(bx, by, 5, "#ff4081", 70);
    try {
      audio.playMissile();
    } catch (_) {}
    return;
  }

  if (type === "mine") {
    if (car.ammoMines < 1 || car.cdMine > 0) return;
    car.ammoMines -= 1;
    car.cdMine = COMBAT.CD_MINE;
    mines.push({
      x: car.x - fx * 38,
      y: car.y - fy * 38,
      owner: car,
      ownerColor: car.color,
      armed: COMBAT.MINE_ARM,
      r: COMBAT.MINE_TRIGGER,
      age: 0,
    });
    try {
      audio.playMineDrop();
    } catch (_) {}
  }
}

function updateProjectiles(dt) {
  outer: for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.ignore = Math.max(0, pr.ignore - dt);
    pr.t -= dt;
    if (pr.t <= 0) {
      projectiles.splice(i, 1);
      continue;
    }

    if (pr.type === "missile" && pr.target && !pr.target.wrecked) {
      const dx = pr.target.x - pr.x;
      const dy = pr.target.y - pr.y;
      const want = Math.atan2(dy, dx);
      const cur = Math.atan2(pr.vy, pr.vx);
      const turn = clamp(wrapAngle(want - cur), -1, 1) * COMBAT.MISSILE_TURN * dt;
      const spd = hypot(pr.vx, pr.vy);
      const na = cur + turn;
      pr.vx = Math.cos(na) * spd;
      pr.vy = Math.sin(na) * spd;
    }

    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;

    for (const seg of track.wallSegments) {
      if (
        circleHitsSegment(pr.x, pr.y, 4, seg.a.x, seg.a.y, seg.b.x, seg.b.y)
      ) {
        spawnParticles(pr.x, pr.y, 6, "#aaa", 100);
        projectiles.splice(i, 1);
        continue outer;
      }
    }

    for (const car of cars) {
      if (car.wrecked) continue;
      if (car === pr.owner && pr.ignore > 0) continue;
      if (hypot(car.x - pr.x, car.y - pr.y) < CAR_R + 6) {
        applyDamage(car, pr.dmg, { x: pr.x, y: pr.y });
        spawnParticles(pr.x, pr.y, 8, "#fff", 140);
        projectiles.splice(i, 1);
        continue outer;
      }
    }
  }
}

function updateMines(dt) {
  outer: for (let i = mines.length - 1; i >= 0; i--) {
    const m = mines[i];
    m.age += dt;
    m.armed -= dt;
    if (m.age > 48) {
      mines.splice(i, 1);
      continue;
    }
    for (const car of cars) {
      if (car.wrecked) continue;
      if (car === m.owner && m.armed > 0) continue;
      if (hypot(car.x - m.x, car.y - m.y) < m.r + CAR_R) {
        applyDamage(car, 32, { x: m.x, y: m.y });
        const oc = m.ownerColor || "#ffd54f";
        spawnParticles(m.x, m.y, 14, oc, 200);
        spawnParticles(m.x, m.y, 10, "#ff1744", 260);
        mines.splice(i, 1);
        continue outer;
      }
    }
  }
}

function updateParticles(dt) {
  while (particles.length > 520) particles.shift();
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.96;
    p.vy *= 0.96;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function resolveCarCar() {
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const A = cars[a];
      const B = cars[b];
      if (A.wrecked || B.wrecked) continue;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const dist = hypot(dx, dy);
      const minD = CAR_R * 2.05;
      if (dist >= minD || dist < 1e-6) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minD - dist;
      A.x -= nx * overlap * 0.5;
      A.y -= ny * overlap * 0.5;
      B.x += nx * overlap * 0.5;
      B.y += ny * overlap * 0.5;
      const rvx = B.vx - A.vx;
      const rvy = B.vy - A.vy;
      const rel = Math.abs(rvx * nx + rvy * ny);
      if (rel > 95) {
        const dmg = rel * 0.018;
        applyDamage(A, dmg * 0.9, { x: A.x, y: A.y });
        applyDamage(B, dmg * 0.9, { x: B.x, y: B.y });
      }
    }
  }
}

function updateCarCombatTimers(car, dt) {
  car.cdCannon = Math.max(0, car.cdCannon - dt);
  car.cdMissile = Math.max(0, car.cdMissile - dt);
  car.cdMine = Math.max(0, car.cdMine - dt);
  if (car.shieldT > 0) car.shieldT -= dt;
  if (car.boostT > 0) car.boostT -= dt;
  if (car.wreckT > 0) {
    car.wreckT -= dt;
    if (car.wreckT <= 0) {
      car.wreckT = 0;
      respawnCarOnTrack(car);
    }
  }
}

function aiCombatThink(car, dt) {
  if (car.wrecked || car.isPlayer) return;
  if (car.ammoMissile > 0 && car.cdMissile <= 0 && Math.random() < 0.0045 * 60 * dt) {
    trySpawnProjectile(car, "missile");
  }
  if (car.ammoMines > 0 && car.cdMine <= 0 && Math.random() < 0.0022 * 60 * dt) {
    trySpawnProjectile(car, "mine");
  }
  if (car.cdCannon > 0 || car.ammoCannon < 1) return;
  if (Math.random() > 0.018 * 60 * dt) return;
  let best = null;
  let bd = Infinity;
  for (const o of cars) {
    if (o === car || o.wrecked) continue;
    const dx = o.x - car.x;
    const dy = o.y - car.y;
    const d = hypot(dx, dy);
    if (d > 400 || d < 50) continue;
    const ang = Math.atan2(dy, dx);
    if (Math.abs(wrapAngle(ang - car.angle)) > 0.55) continue;
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  if (best) trySpawnProjectile(car, "cannon");
}

const state = {
  mode: "title", // title | countdown | race | finished
  countdown: 3,
  lap: 1,
  totalLaps: 3,
  lapStartTime: 0,
  raceStartTime: 0,
  currentLapTime: 0,
  lastLapTime: null,
  bestLap: Number(localStorage.getItem("aneRacingBestLap"))
    ? parseFloat(localStorage.getItem("aneRacingBestLap"))
    : null,
  prevPos: { x: player.x, y: player.y },
  camera: { x: 0, y: 0, zoom: 1 },
  pendingRestart: false,
};

const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlaySub = document.getElementById("overlay-sub");
const overlayHintEl = document.getElementById("overlay-hint");
const countdownEl = document.getElementById("countdown");
const lapDisplay = document.getElementById("lap-display");
const currentTimeEl = document.getElementById("current-time");
const lastLapEl = document.getElementById("last-lap");
const bestLapEl = document.getElementById("best-lap");
const placeDisplayEl = document.getElementById("place-display");
const restartPromptEl = document.getElementById("restart-prompt");
const hpBarEl = document.getElementById("hp-bar");
const hpTextEl = document.getElementById("hp-text");
const shieldTextEl = document.getElementById("shield-text");
const boostTextEl = document.getElementById("boost-text");
const ammoCannonEl = document.getElementById("ammo-cannon");
const ammoMissileEl = document.getElementById("ammo-missile");
const ammoMineEl = document.getElementById("ammo-mine");
const chatLogEl = document.getElementById("chat-log");
const pickupToastEl = document.getElementById("pickup-toast");
const pickupToastTitleEl = document.getElementById("pickup-toast-title");
const pickupToastDescEl = document.getElementById("pickup-toast-desc");

function showOverlay(title, sub, show = true, hint = "") {
  overlayTitle.textContent = title;
  overlaySub.textContent = sub || "";
  overlay.classList.toggle("hidden", !show);
  if (overlayHintEl) {
    overlayHintEl.textContent = hint;
    overlayHintEl.classList.toggle("hidden", !hint);
  }
}

function setRestartPrompt(on) {
  state.pendingRestart = on;
  if (restartPromptEl) {
    restartPromptEl.classList.toggle("hidden", !on);
  }
}

function updateHud() {
  lapDisplay.textContent =
    state.mode === "race" || state.mode === "finished"
      ? `${Math.min(player.raceLap, state.totalLaps)} / ${state.totalLaps}`
      : "— / —";
  if (placeDisplayEl) {
    if (state.mode === "race" || state.mode === "finished") {
      const { place, total } = computePlayerPlace();
      placeDisplayEl.textContent = `${place} / ${total}`;
    } else {
      placeDisplayEl.textContent = "—";
    }
  }
  currentTimeEl.textContent = formatTime(state.currentLapTime);
  lastLapEl.textContent =
    state.lastLapTime != null ? formatTime(state.lastLapTime) : "--:--.--";
  bestLapEl.textContent =
    state.bestLap != null ? formatTime(state.bestLap) : "--:--.--";

  const pl = player;
  const h = pl.maxHp > 0 ? pl.hp / pl.maxHp : 0;
  hpBarEl.style.transform = `scaleX(${clamp(h, 0, 1)})`;
  hpTextEl.textContent = pl.wrecked ? "WRECK" : `${Math.round(pl.hp)}`;
  shieldTextEl.textContent =
    pl.shieldT > 0 ? `${pl.shieldT.toFixed(1)}s` : "—";
  boostTextEl.textContent =
    pl.boostT > 0 ? `${pl.boostT.toFixed(1)}s` : "—";
  ammoCannonEl.textContent = String(Math.floor(pl.ammoCannon));
  ammoMissileEl.textContent = String(pl.ammoMissile);
  ammoMineEl.textContent = String(pl.ammoMines);
}

const ACCEL = 520;
const FRICTION = 0.978;
const STEER = 2.85;
const MAX_SPEED = 420;
const AI_MAX = 380;

function resolveCarWalls(car) {
  for (const seg of track.wallSegments) {
    if (
      circleHitsSegment(car.x, car.y, CAR_R, seg.a.x, seg.a.y, seg.b.x, seg.b.y)
    ) {
      const ax = seg.a.x;
      const ay = seg.a.y;
      const bx = seg.b.x;
      const by = seg.b.y;
      const abx = bx - ax;
      const aby = by - ay;
      const apx = car.x - ax;
      const apy = car.y - ay;
      const ab2 = abx * abx + aby * aby;
      let t = ab2 > 0 ? (apx * abx + apy * aby) / ab2 : 0;
      t = clamp(t, 0, 1);
      const qx = ax + abx * t;
      const qy = ay + aby * t;
      let nx = car.x - qx;
      let ny = car.y - qy;
      const nlen = hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;
      const push = CAR_R - hypot(car.x - qx, car.y - qy) + 2;
      car.x += nx * push;
      car.y += ny * push;
      const vn = car.vx * nx + car.vy * ny;
      if (vn < 0) {
        car.vx -= 2 * vn * nx;
        car.vy -= 2 * vn * ny;
      }
      car.vx *= 0.88;
      car.vy *= 0.88;
      if (vn < -95) {
        const imp = -vn - 95;
        applyDamage(car, imp * 0.006, { x: car.x, y: car.y });
        const t = performance.now();
        if (t - wallSoundAt > 220) {
          wallSoundAt = t;
          try {
            audio.playWall();
          } catch (_) {}
        }
      }
    }
  }
}

function updateCar(car, dt, input) {
  if (state.mode !== "race") {
    car.vx *= 0.92;
    car.vy *= 0.92;
    if (!car.isPlayer) return;
    resolveCarWalls(car);
    return;
  }

  if (car.wrecked) {
    car.vx *= 0.9;
    car.vy *= 0.9;
    return;
  }

  const boostMul = car.boostT > 0 ? 1.38 : 1;

  if (car.isPlayer) {
    let steer = 0;
    if (input.left) steer -= 1;
    if (input.right) steer += 1;
    const hb = input.handbrake;
    const thr = (input.up ? 1 : 0) - (input.down ? 0.35 : 0);
    if (thr !== 0) {
      const ax = Math.cos(car.angle) * ACCEL * thr * boostMul;
      const ay = Math.sin(car.angle) * ACCEL * thr * boostMul;
      car.vx += ax * dt;
      car.vy += ay * dt;
    }
    const spRatio = clamp(car.speed / MAX_SPEED, 0.2, 1.12);
    const hbSteer = hb ? 2.35 : 1;
    if (car.speed > 38) {
      car.angle += steer * STEER * dt * spRatio * hbSteer;
    } else if (Math.abs(steer) > 0) {
      car.angle += steer * STEER * (hb ? 1.05 : 0.5) * dt;
    }
    if (hb && car.speed > 42) {
      const bleed = 1 - dt * 0.42;
      car.vx *= bleed;
      car.vy *= bleed;
    }
  } else {
    const tgt = track.center[car.aiWp % track.n];
    const dx = tgt.x - car.x;
    const dy = tgt.y - car.y;
    const want = Math.atan2(dy, dx);
    let diff = wrapAngle(want - car.angle + car.aiOffset * 0.35);
    const steerAi = clamp(diff * 2.4, -1, 1);
    car.angle += steerAi * STEER * dt * 0.92;

    const boost =
      (0.88 + Math.sin(performance.now() * 0.002 + car.aiOffset * 12) * 0.08) *
      (car.boostT > 0 ? 1.25 : 1);
    const ax = Math.cos(car.angle) * ACCEL * boost;
    const ay = Math.sin(car.angle) * ACCEL * boost;
    car.vx += ax * dt;
    car.vy += ay * dt;

    if (hypot(dx, dy) < 88) {
      car.aiWp = (car.aiWp + 1) % track.n;
    }
  }

  const sp = car.speed;
  const cap = (car.isPlayer ? MAX_SPEED : AI_MAX) * (car.boostT > 0 ? 1.22 : 1);
  if (sp > cap) {
    const s = cap / sp;
    car.vx *= s;
    car.vy *= s;
  }

  let fric = FRICTION;
  if (car.isPlayer && input.handbrake && car.speed > 36) {
    fric = 0.966;
  }
  car.vx *= Math.pow(fric, dt * 60);
  car.vy *= Math.pow(fric, dt * 60);

  car.x += car.vx * dt;
  car.y += car.vy * dt;

  resolveCarWalls(car);
}

function checkCarLap(car, prev, curr) {
  const fl = track.finishLine;
  const cp = crossLinePoint(fl.a.x, fl.a.y, fl.b.x, fl.b.y, prev.x, prev.y);
  const cc = crossLinePoint(fl.a.x, fl.a.y, fl.b.x, fl.b.y, curr.x, curr.y);
  const eps = 2;
  const crossedSides = cp * cc < 0 || (Math.abs(cp) <= eps && Math.abs(cc) > eps) || (Math.abs(cc) <= eps && Math.abs(cp) > eps);
  const hitSeg = segmentIntersect(prev, curr, fl.a, fl.b) != null;
  if (!crossedSides && !hitSeg) return;

  const vx = curr.x - prev.x;
  const vy = curr.y - prev.y;
  const forward = vx * fl.tangent.x + vy * fl.tangent.y;
  if (forward <= 0) return;

  if (!car.passedMid) return;

  car.passedMid = false;
  car.raceLap += 1;

  if (!car.isPlayer) {
    return;
  }

  const now = performance.now() / 1000;
  const lapTime = now - state.lapStartTime;
  state.lastLapTime = lapTime;
  if (state.bestLap == null || lapTime < state.bestLap) {
    state.bestLap = lapTime;
    localStorage.setItem("aneRacingBestLap", String(lapTime));
  }
  state.lapStartTime = now;
  state.lap = player.raceLap;

  if (player.raceLap > state.totalLaps) {
    state.mode = "finished";
    const totalTime = now - state.raceStartTime;
    showOverlay(
      "Finish!",
      `Total time: ${formatTime(totalTime)}\nBest lap: ${formatTime(state.bestLap)}`,
      true,
      "Space to race again"
    );
    try {
      audio.playLap();
    } catch (_) {}
  } else {
    try {
      audio.playLap();
    } catch (_) {}
  }
}

const keys = { up: false, down: false, left: false, right: false, handbrake: false };

window.addEventListener("keydown", (e) => {
  try {
    audio.ensureAudio();
  } catch (_) {}

  if (e.code === "ArrowUp" || e.code === "KeyW") keys.up = true;
  if (e.code === "ArrowDown" || e.code === "KeyS") keys.down = true;
  if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = true;
  if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys.handbrake = true;

  if (e.code === "KeyR" && (state.mode === "race" || state.mode === "finished")) {
    if (!state.pendingRestart) {
      setRestartPrompt(true);
    }
  }

  if (e.code === "Enter" && state.pendingRestart) {
    e.preventDefault();
    setRestartPrompt(false);
    resetRace();
    return;
  }

  if (e.code === "Escape" && state.pendingRestart) {
    e.preventDefault();
    setRestartPrompt(false);
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (state.pendingRestart) {
      setRestartPrompt(false);
      return;
    }
    if (state.mode === "title" || state.mode === "finished") startSequence();
  }
  if (
    state.mode === "race" &&
    !e.repeat &&
    !player.wrecked
  ) {
    if (e.code === "KeyF") trySpawnProjectile(player, "cannon");
    if (e.code === "KeyE") trySpawnProjectile(player, "missile");
    if (e.code === "KeyC") trySpawnProjectile(player, "mine");
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "ArrowUp" || e.code === "KeyW") keys.up = false;
  if (e.code === "ArrowDown" || e.code === "KeyS") keys.down = false;
  if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = false;
  if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = false;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys.handbrake = false;
});

function resetRace() {
  projectiles.length = 0;
  mines.length = 0;
  particles.length = 0;
  initPickups();

  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    const slot = GRID_SLOTS[CAR_GRID_IDX[i]];
    c.x = slot.x;
    c.y = slot.y;
    c.angle = slot.angle;
    c.vx = 0;
    c.vy = 0;
    c.aiWp = (Math.floor(track.n * 0.15) + i * 7) % track.n;
    c.maxHp = 100;
    c.hp = 100;
    c.shieldT = 0;
    c.boostT = 0;
    c.ammoCannon = c.isPlayer ? 22 : 28;
    c.ammoMissile = c.isPlayer ? 0 : 1;
    c.ammoMines = c.isPlayer ? 0 : 1;
    c.cdCannon = 0;
    c.cdMissile = 0;
    c.cdMine = 0;
    c.wreckT = 0;
    c.raceLap = 1;
    c.passedMid = false;
    c.prevX = c.x;
    c.prevY = c.y;
  }

  state.lap = 1;
  state.lastLapTime = null;
  state.lapStartTime = performance.now() / 1000;
  state.raceStartTime = state.lapStartTime;
  state.mode = "race";
  showOverlay("", "", false, "");
  countdownEl.classList.add("hidden");
  setRestartPrompt(false);
  state.prevPos.x = player.x;
  state.prevPos.y = player.y;
  chatLines.length = 0;
  chatTauntAcc = 0;
  chatTauntNext = 3 + Math.random() * 6;
  addChatLine("Race", "#6b7a8f", "Green flag — good luck!");
  updateHud();
}

function startSequence() {
  showOverlay("", "", false, "");
  setRestartPrompt(false);
  state.mode = "countdown";
  countdownEl.classList.remove("hidden");
  const labels = ["3", "2", "1", "GO"];
  let step = 0;
  countdownEl.textContent = labels[0];
  const timer = setInterval(() => {
    step += 1;
    if (step < labels.length) {
      countdownEl.textContent = labels[step];
    } else {
      clearInterval(timer);
      setTimeout(() => {
        countdownEl.classList.add("hidden");
        resetRace();
      }, 420);
    }
  }, 820);
}

initPickups();
showOverlay(
  "Ane Racing PRO",
  "Audio on first key · F/E/C weapons",
  true,
  "Space to start"
);

let lastFrame = performance.now();

function drawWorld() {
  const cx = state.camera.x;
  const cy = state.camera.y;
  const z = state.camera.zoom;

  ctx.save();
  ctx.setTransform(z, 0, 0, z, canvas.width / 2 - cx * z, canvas.height / 2 - cy * z);

  // Grass (large enough for scaled track + camera pan)
  const grassR = 3200;
  ctx.fillStyle = "#1a3d2e";
  ctx.fillRect(cx - grassR, cy - grassR, grassR * 2, grassR * 2);

  // Subtle grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1 / z;
  for (let gx = -grassR; gx < grassR; gx += 80) {
    ctx.beginPath();
    ctx.moveTo(gx, -grassR);
    ctx.lineTo(gx, grassR);
    ctx.stroke();
  }
  for (let gy = -grassR; gy < grassR; gy += 80) {
    ctx.beginPath();
    ctx.moveTo(-grassR, gy);
    ctx.lineTo(grassR, gy);
    ctx.stroke();
  }

  // Track fill (even-odd)
  ctx.beginPath();
  ctx.moveTo(track.outer[0].x, track.outer[0].y);
  for (let i = 1; i <= track.n; i++) {
    const p = track.outer[i % track.n];
    ctx.lineTo(p.x, p.y);
  }
  ctx.moveTo(track.inner[0].x, track.inner[0].y);
  for (let i = 1; i <= track.n; i++) {
    const p = track.inner[i % track.n];
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  const grd = ctx.createLinearGradient(-1200, -800, 1200, 800);
  grd.addColorStop(0, "#2d333f");
  grd.addColorStop(1, "#1e222b");
  ctx.fillStyle = grd;
  ctx.fill("evenodd");

  // Edge lines
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 3 / z;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(track.outer[0].x, track.outer[0].y);
  for (let i = 1; i <= track.n; i++) {
    const p = track.outer[i % track.n];
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(track.inner[0].x, track.inner[0].y);
  for (let i = 1; i <= track.n; i++) {
    const p = track.inner[i % track.n];
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  // Center dashed racing line
  ctx.setLineDash([14 / z, 12 / z]);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2 / z;
  ctx.beginPath();
  ctx.moveTo(track.center[0].x, track.center[0].y);
  for (let i = 1; i <= track.n; i++) {
    const p = track.center[i % track.n];
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Kerbs (every 4th outer segment) — skip near sector so red/white rumble doesn't read as a barrier
  const midK = track.midCheckpoint;
  for (let i = 0; i < track.n; i += 4) {
    const j = (i + 1) % track.n;
    const o0 = track.outer[i];
    const o1 = track.outer[j];
    if (
      distPointSegment(midK.x, midK.y, o0.x, o0.y, o1.x, o1.y) <
      midK.r + track.width * 0.55
    ) {
      continue;
    }
    const gr = i % 8 === 0 ? "#c62828" : "#f5f5f5";
    ctx.strokeStyle = gr;
    ctx.lineWidth = 8 / z;
    ctx.beginPath();
    ctx.moveTo(o0.x, o0.y);
    ctx.lineTo(o1.x, o1.y);
    ctx.stroke();
  }

  // Start / finish
  const fl = track.finishLine;
  ctx.strokeStyle = "#fff59d";
  ctx.lineWidth = 5 / z;
  ctx.beginPath();
  ctx.moveTo(fl.a.x, fl.a.y);
  ctx.lineTo(fl.b.x, fl.b.y);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,245,157,0.35)";
  ctx.font = `${14 / z}px Orbitron,sans-serif`;
  ctx.save();
  ctx.translate((fl.a.x + fl.b.x) / 2, (fl.a.y + fl.b.y) / 2);
  ctx.rotate(Math.atan2(fl.tangent.y, fl.tangent.x));
  ctx.fillText("S/F", -12 / z, -8 / z);
  ctx.restore();

  const pulse = performance.now() * 0.004;
  for (const pk of pickups) {
    if (!pk.active) continue;
    const meta = PICKUP_META[pk.kind] || { color: "#fff", letter: "?" };
    const col = meta.color;
    ctx.save();
    ctx.translate(pk.x, pk.y);
    ctx.rotate(pulse + pk.x * 0.001);
    ctx.strokeStyle = col;
    ctx.fillStyle = `${col}66`;
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU - Math.PI / 4;
      const x = Math.cos(a) * (COMBAT.PICKUP_R * 0.85);
      const y = Math.sin(a) * (COMBAT.PICKUP_R * 0.85);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${13 / z}px Orbitron,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(meta.letter, 0, 0);
    ctx.restore();
  }

  for (const m of mines) {
    const armed = m.armed <= 0;
    const col = m.ownerColor || "#ff5722";
    ctx.save();
    ctx.translate(m.x, m.y);
    if (armed) {
      ctx.rotate(performance.now() * 0.0035);
    }
    const spikes = 10;
    const ro = armed ? 16 : 12;
    const ri = 5;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * TAU - Math.PI / 2;
      const rad = i % 2 === 0 ? ro : ri;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    const grd = ctx.createRadialGradient(0, 0, 1, 0, 0, ro);
    grd.addColorStop(0, "rgba(10,10,14,0.95)");
    grd.addColorStop(0.55, col);
    grd.addColorStop(1, armed ? "#8b0000" : "#333");
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.strokeStyle = armed ? "#ff1744" : "#555";
    ctx.lineWidth = 2.2 / z;
    ctx.stroke();
    if (armed) {
      ctx.strokeStyle = `rgba(255,23,68,${0.35 + Math.sin(performance.now() * 0.012) * 0.25})`;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(0, 0, ro + 5, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${11 / z}px Orbitron,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", 0, 0);
    ctx.restore();
  }

  for (const pr of projectiles) {
    ctx.save();
    ctx.translate(pr.x, pr.y);
    if (pr.type === "missile") {
      ctx.rotate(Math.atan2(pr.vy, pr.vx));
      ctx.fillStyle = "#ff4081";
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-8, 6);
      ctx.lineTo(-8, -6);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "#00e5ff";
      ctx.shadowColor = "#00e5ff";
      ctx.shadowBlur = 8 / z;
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  for (const car of cars) {
    if (!car.isPlayer) {
      ctx.save();
      ctx.translate(car.x, car.y);
      const hull = car.hp / car.maxHp;
      const bw = 46;
      const bh = 7;
      const yBar = -CAR_R - 20;
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(-bw / 2, yBar, bw, bh);
      if (!car.wrecked) {
        ctx.fillStyle =
          hull > 0.55 ? "#7cff7c" : hull > 0.28 ? "#ffd54f" : "#e53935";
        ctx.fillRect(-bw / 2, yBar, bw * clamp(hull, 0, 1), bh);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(-bw / 2, yBar, bw, bh);
      ctx.font = `${10 / z}px Orbitron,sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(car.wrecked ? "0" : `${Math.round(car.hp)}`, 0, yBar - 3 / z);
      ctx.restore();
    }
  }

  // Cars
  for (const car of cars) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    ctx.shadowColor = car.color;
    ctx.shadowBlur = 12 / z;

    ctx.fillStyle = "#111";
    ctx.fillRect(-18, -10, 36, 20);

    const hull = car.hp / car.maxHp;
    ctx.globalAlpha = hull < 0.35 ? 0.72 : 1;
    ctx.fillStyle = car.color;
    ctx.beginPath();
    const rx = -16;
    const ry = -8;
    const rw = 32;
    const rh = 16;
    const rr = 3;
    ctx.moveTo(rx + rr, ry);
    ctx.lineTo(rx + rw - rr, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rr);
    ctx.lineTo(rx + rw, ry + rh - rr);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
    ctx.lineTo(rx + rr, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rr);
    ctx.lineTo(rx, ry + rr);
    ctx.quadraticCurveTo(rx, ry, rx + rr, ry);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(6, -6, 8, 12);

    ctx.shadowBlur = 0;
    if (car.isPlayer) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(10, 0, 3, 0, TAU);
      ctx.fill();
    }

    if (car.shieldT > 0) {
      ctx.strokeStyle = "rgba(83,109,254,0.65)";
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(0, 0, CAR_R + 7, 0, TAU);
      ctx.stroke();
    }

    if (car.boostT > 0) {
      ctx.strokeStyle = "rgba(255,171,64,0.75)";
      ctx.lineWidth = 2.5 / z;
      ctx.beginPath();
      ctx.arc(0, 0, CAR_R + 10, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,234,0,0.35)";
      ctx.lineWidth = 4 / z;
      ctx.beginPath();
      ctx.arc(0, 0, CAR_R + 13, 0, TAU);
      ctx.stroke();
    }

    if (car.wrecked) {
      ctx.fillStyle = "rgba(80,80,80,0.5)";
      ctx.beginPath();
      ctx.arc(-6, -12, 5, 0, TAU);
      ctx.arc(4, -14, 6, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life * 3, 0, 1);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 4 / z;
    const rad = p.r != null ? p.r : 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;

  if (state.mode === "race") {
    const nowSec = now / 1000;

    for (const car of cars) {
      updateCarCombatTimers(car, dt);
    }
    for (const car of cars) {
      updateCar(car, dt, keys);
    }
    resolveCarCar();
    updateProjectiles(dt);
    updateMines(dt);
    updatePickups(nowSec);
    for (const car of cars) {
      aiCombatThink(car, dt);
    }
    updateParticles(dt);
    updateChatTaunts(dt);
    for (const car of cars) {
      spawnBoostParticles(car, dt);
    }

    const m = track.midCheckpoint;
    for (const car of cars) {
      if (hypot(car.x - m.x, car.y - m.y) < m.r) {
        car.passedMid = true;
      }
    }

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      checkCarLap(c, { x: c.prevX, y: c.prevY }, { x: c.x, y: c.y });
    }
    for (const car of cars) {
      car.prevX = car.x;
      car.prevY = car.y;
    }
    state.prevPos.x = player.x;
    state.prevPos.y = player.y;

    const t = now / 1000;
    state.currentLapTime = t - state.lapStartTime;
    updateHud();
    try {
      audio.updateMusic(dt);
    } catch (_) {}
  } else {
    for (const car of cars) {
      updateCar(car, dt, keys);
    }
    updateParticles(dt);
    updateHud();
  }

  // Camera follow player
  state.camera.x = lerp(state.camera.x, player.x, 1 - Math.pow(0.002, dt));
  state.camera.y = lerp(state.camera.y, player.y, 1 - Math.pow(0.002, dt));
  state.camera.zoom = lerp(state.camera.zoom, 1, dt * 3);

  ctx.fillStyle = "#0d1018";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawWorld();

  requestAnimationFrame(frame);
}

updateHud();
requestAnimationFrame(frame);
