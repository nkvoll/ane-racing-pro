/**
 * Ane Racing PRO — top-down arcade racer
 */

import * as audio from "./audio.js";
import { LEVELS, getLevelByUid, getLevelBySlug } from "./tracks.js";
import {
  loadCustomTracks,
  createCustomTrack,
  deleteCustomTrack,
} from "./custom-tracks.js";
import { initTrackEditor } from "./track-editor.js";
import {
  appendRoadOutlineToCanvasPath,
  boundsRoadOutline,
  buildTrackLayout,
  distPointSegment,
  strokeRoadOutlineBoundaries,
  TRACK_WIDTH,
} from "./track-geometry.js";

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

/** Darken a #rrggbb color for gradients / edges (fallback: return as-is). */
function hexDarken(hex, t = 0.5) {
  const m = String(hex).match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!m) return "rgb(20,24,32)";
  const k = 1 - t;
  const r = Math.round(parseInt(m[1], 16) * k);
  const g = Math.round(parseInt(m[2], 16) * k);
  const b = Math.round(parseInt(m[3], 16) * k);
  return `rgb(${r},${g},${b})`;
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

function circleHitsSegment(cx, cy, r, ax, ay, bx, by) {
  return distPointSegment(cx, cy, ax, ay, bx, by) < r;
}

const CAR_R = 16;

class Track {
  /**
   * @param {{x:number,y:number}[]} control closed control polygon
   * @param {{ trackWidth?: number }} [opts]
   */
  constructor(control, opts = {}) {
    const g = buildTrackLayout(control, opts);
    this.center = g.center;
    this.n = g.n;
    this.width = g.width;
    this.inner = g.inner;
    this.outer = g.outer;
    this.roadOutline = g.roadOutline;
    this.wallSegments = g.wallSegments;
    this.finishLine = g.finishLine;
    this.checkpoints = g.checkpoints;
    this.length = g.length;
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

/** True road silhouette from layout (figure-8, cross, etc.); falls back to ribbon if absent. */
function roadOutlineForTrack(tr) {
  if (tr.roadOutline?.outer?.length >= 3) return tr.roadOutline;
  return {
    outer: tr.outer,
    holes: tr.inner?.length >= 3 ? [tr.inner] : [],
  };
}

const trackCache = new Map();

/** @param {string} uid */
function findCustomRecord(uid) {
  return loadCustomTracks().find((t) => t.uid === uid);
}

/** @param {{ uid: string, name: string, control: {x:number,y:number}[], subdiv?: number, widthScale?: number }} rec */
function customRecordToLevelDef(rec) {
  const ctrl = rec.control.map((p) => ({ x: p.x, y: p.y }));
  return {
    uid: rec.uid,
    id: "custom",
    name: rec.name,
    tagline: "Custom · drawn track",
    widthScale: rec.widthScale ?? 1,
    buildControl() {
      return ctrl.map((p) => ({ x: p.x, y: p.y }));
    },
  };
}

/** Built-in or saved custom layout (same shape as `tracks.js` LevelDef). */
function getLevelDef(uid) {
  const rec = findCustomRecord(uid);
  if (rec) return customRecordToLevelDef(rec);
  return getLevelByUid(uid);
}

function isCustomTrackUid(uid) {
  return (
    typeof uid === "string" &&
    uid.startsWith("custom_") &&
    Boolean(findCustomRecord(uid))
  );
}

/** Resolve persisted menu selection: UUID, legacy slug `id`, or legacy numeric index. */
function resolveStoredLevelUid(stored) {
  if (stored == null || stored === "") return LEVELS[0].uid;
  const s = String(stored).trim();
  if (LEVELS.some((L) => L.uid === s)) return s;
  if (findCustomRecord(s)) return s;
  const bySlug = getLevelBySlug(s);
  if (bySlug) return bySlug.uid;
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && n >= 0 && n < LEVELS.length) return LEVELS[n].uid;
  return LEVELS[0].uid;
}

function readInitialLevelUid() {
  try {
    return resolveStoredLevelUid(localStorage.getItem("aneRacingLastLevel"));
  } catch (_) {
    return LEVELS[0].uid;
  }
}

function buildTrackForLevel(levelUid) {
  const def = getLevelDef(levelUid);
  const control = def.buildControl();
  const tw = TRACK_WIDTH * (def.widthScale ?? 1);
  if (!trackCache.has(def.uid)) {
    trackCache.set(
      def.uid,
      new Track(control, { trackWidth: tw })
    );
  }
  return trackCache.get(def.uid);
}

let activeLevelUid = readInitialLevelUid();
let track = buildTrackForLevel(activeLevelUid);

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
    /** Next checkpoint index to clear (0 … checkpoints.length); equals length ⇒ eligible to complete lap at S/F. */
    this.nextCheckpointIndex = 0;
    /** Stable place score: last polyline segment used for projecting (x,y) onto the racing line. */
    this.trackSegHint = -1;
    /** Previous arc length [0,L) for resolving closest-segment ambiguity at self-overlaps. */
    this.lastArcPlace = null;
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

const LEGACY_LEADERBOARD_KEY = "aneRacingTop10RaceTimes";
const LEADERBOARD_MAX = 10;
const LEADERBOARD_NAME_MAX = 16;
/** Default name for the next qualifying finish — also last name typed on the finish overlay. */
const LB_DISPLAY_NAME_KEY = "aneRacingLbDisplayName";

/** @param {string} s */
function sanitizeLeaderboardName(s) {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, LEADERBOARD_NAME_MAX);
  return t;
}

/** `ts` of the row on the finish screen name field, or null */
let pendingLeaderboardEntryTs = null;

function flushPendingLeaderboardName() {
  if (pendingLeaderboardEntryTs == null || !overlayLbNameInputEl) return;
  updateLeaderboardEntryName(
    pendingLeaderboardEntryTs,
    overlayLbNameInputEl.value
  );
}

function leaderboardStorageKey() {
  return `aneRacingTop10_${activeLevelUid}`;
}

/** Clears stored top-10 race times and best lap for one track uid (layout-specific keys only). */
function clearSavedRaceTimesForLevelUid(levelUid) {
  try {
    localStorage.removeItem(`aneRacingTop10_${levelUid}`);
    localStorage.removeItem(`aneRacingBestLap_${levelUid}`);
  } catch (_) {}
  if (activeLevelUid === levelUid) {
    loadBestLapFromStorage();
  }
  if (state.mode === "title" && menuSubScreen === "levels") {
    syncLevelSelectUi();
  }
}

function parseLeaderboardForLevelUid(levelUid) {
  try {
    const def = getLevelDef(levelUid);
    let raw = localStorage.getItem(`aneRacingTop10_${def.uid}`);
    if (!raw) {
      raw = localStorage.getItem(`aneRacingTop10_${def.id}`);
    }
    if (!raw && def.id === LEVELS[0].id) {
      raw = localStorage.getItem(LEGACY_LEADERBOARD_KEY);
    }
    if (raw) {
      try {
        if (!localStorage.getItem(`aneRacingTop10_${def.uid}`)) {
          localStorage.setItem(`aneRacingTop10_${def.uid}`, raw);
        }
      } catch (_) {}
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x) =>
          x &&
          typeof x.time === "number" &&
          Number.isFinite(x.time) &&
          x.time > 0
      )
      .sort(
        (a, b) =>
          a.time - b.time || (a.ts || 0) - (b.ts || 0)
      )
      .slice(0, LEADERBOARD_MAX);
  } catch {
    return [];
  }
}

function parseLeaderboard() {
  return parseLeaderboardForLevelUid(activeLevelUid);
}

/** Saves this race finish; returns rank and entry timestamp when stored in the top {LEADERBOARD_MAX}. */
function recordRaceFinishTime(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) {
    renderLeaderboard(null);
    return { rank: null, leaderboardEntryTs: null };
  }
  const rows = [...parseLeaderboard()];
  const ts = Date.now();
  let defaultName = "";
  try {
    defaultName = sanitizeLeaderboardName(localStorage.getItem(LB_DISPLAY_NAME_KEY) || "");
  } catch (_) {}
  rows.push({ time: totalSec, ts, name: defaultName });
  rows.sort(
    (a, b) => a.time - b.time || (a.ts || 0) - (b.ts || 0)
  );
  const next = rows.slice(0, LEADERBOARD_MAX);
  localStorage.setItem(leaderboardStorageKey(), JSON.stringify(next));
  const idx = next.findIndex((r) => r.ts === ts);
  const rank = idx >= 0 ? idx + 1 : null;
  renderLeaderboard(rank != null ? ts : null);
  return {
    rank,
    leaderboardEntryTs: rank != null ? ts : null,
  };
}

/**
 * Updates display name for one saved row (by `ts`) and default for future finishes.
 * @param {number} ts
 * @param {string} rawName
 */
function updateLeaderboardEntryName(ts, rawName) {
  const name = sanitizeLeaderboardName(rawName);
  try {
    localStorage.setItem(LB_DISPLAY_NAME_KEY, name);
  } catch (_) {}
  let list;
  try {
    const raw = localStorage.getItem(leaderboardStorageKey());
    list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  const i = list.findIndex((r) => r && r.ts === ts);
  if (i < 0) return;
  list[i] = { ...list[i], name };
  try {
    localStorage.setItem(leaderboardStorageKey(), JSON.stringify(list));
  } catch (_) {}
  renderLeaderboard(ts);
  const lbEl = document.getElementById("leaderboard-list-level-select");
  if (lbEl && levelSelectUid === activeLevelUid) {
    fillLeaderboardList(lbEl, null, parseLeaderboardForLevelUid(levelSelectUid));
  }
}

/** @param finishHighlightTs `row.ts` of this race to highlight on the finish overlay list only; omit/null to clear. */
function renderLeaderboard(finishHighlightTs = null) {
  const finishList = document.getElementById("leaderboard-list-finish");
  fillLeaderboardList(finishList, finishHighlightTs);
}

function fillLeaderboardList(listEl, highlightTs, dataOverride = null) {
  if (!listEl) return;
  listEl.innerHTML = "";
  const data = dataOverride != null ? dataOverride : parseLeaderboard();
  if (data.length === 0) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "No races saved yet — finish one!";
    listEl.appendChild(li);
    return;
  }
  data.forEach((row, i) => {
    const li = document.createElement("li");
    if (
      highlightTs != null &&
      row.ts != null &&
      row.ts === highlightTs
    ) {
      li.classList.add("leaderboard-row--you");
      li.setAttribute("aria-label", `Your result, rank ${i + 1}`);
    }
    const rank = document.createElement("span");
    rank.className = "lb-rank";
    rank.textContent = `${i + 1}.`;
    const nameEl = document.createElement("span");
    nameEl.className = "lb-name";
    const rawName = row.name != null ? String(row.name).trim() : "";
    nameEl.textContent = rawName || "—";
    const timeEl = document.createElement("span");
    timeEl.className = "lb-time";
    timeEl.textContent = formatTime(row.time);
    li.appendChild(rank);
    li.appendChild(nameEl);
    li.appendChild(timeEl);
    listEl.appendChild(li);
  });
}

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

function arcDeltaWrap(a, b, L) {
  if (a == null || b == null || !Number.isFinite(L) || L < 1e-6) return Infinity;
  const d = Math.abs(a - b);
  return Math.min(d, L - d);
}

/**
 * Arc length from center[0] along the racing line, with continuity so place doesn't flicker
 * on self-overlaps when several segments are almost equally close.
 */
function distanceAlongTrackForCar(car) {
  const x = car.x;
  const y = car.y;
  const n = track.n;
  const L = track.length;
  let acc = 0;
  /** @type {{ d: number, arc: number, seg: number }[]} */
  const cands = [];
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
    const arc = acc + t * segLen;
    const qx = ax + abx * t;
    const qy = ay + aby * t;
    const d = hypot(x - qx, y - qy);
    cands.push({ d, arc, seg: i });
    acc += segLen;
  }

  let bestD = Infinity;
  for (const c of cands) {
    bestD = Math.min(bestD, c.d);
  }

  const STICKY_DIST = 26;
  const TIE_DIST = 10;
  const hint = car.trackSegHint;

  if (hint >= 0 && hint < n && cands[hint].d <= bestD + STICKY_DIST) {
    const chosen = cands[hint];
    car.trackSegHint = chosen.seg;
    car.lastArcPlace = chosen.arc;
    return chosen.arc;
  }

  let pool = cands.filter((c) => c.d <= bestD + TIE_DIST);
  if (pool.length > 1 && car.lastArcPlace != null) {
    pool = [...pool].sort(
      (a, b) =>
        arcDeltaWrap(a.arc, car.lastArcPlace, L) -
        arcDeltaWrap(b.arc, car.lastArcPlace, L)
    );
  } else {
    pool.sort((a, b) => a.d - b.d);
  }

  const chosen = pool[0];
  car.trackSegHint = chosen.seg;
  car.lastArcPlace = chosen.arc;
  return chosen.arc;
}

/**
 * Lap / checkpoint / arc as separate axes — never combine into one float (cp*L dominated arc and warped order).
 * Wrecked cars rank last.
 */
function raceProgressComparable(car) {
  if (car.wrecked) {
    return { lap: -1, cp: -1, arc: -1 };
  }
  const K = track.checkpoints?.length ?? 0;
  const cp = K > 0 ? car.nextCheckpointIndex : 0;
  const arc = distanceAlongTrackForCar(car);
  return { lap: car.raceLap, cp, arc };
}

function computePlayerPlace() {
  const ranked = cars.map((c) => ({ c, p: raceProgressComparable(c) }));
  const K = track.checkpoints?.length ?? 0;
  ranked.sort((x, y) => {
    const pa = x.p;
    const pb = y.p;
    if (pa.lap !== pb.lap) return pb.lap - pa.lap;
    if (K > 0 && pa.cp !== pb.cp) return pb.cp - pa.cp;
    return pb.arc - pa.arc;
  });
  const idx = ranked.findIndex((row) => row.c === player);
  return { place: idx + 1, total: cars.length };
}

// Grid follows the actual centerline backward from S/F — straight-line math left the track on curves.
let GRID_LAT_MAX = track.width * 0.5 - CAR_R - 6;

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

let GRID_LAT = 0;
/** @type {{ x: number, y: number, angle: number }[]} */
let GRID_SLOTS = [];

function recomputeGridSlots() {
  const gridScale = clamp(track.length / 5200, 0.42, 1.15);
  const d1 = 172 * gridScale;
  const d2 = 236 * gridScale;
  const d3 = 324 * gridScale;
  GRID_LAT_MAX = track.width * 0.5 - CAR_R - 6;
  GRID_LAT = GRID_LAT_MAX * 0.68;
  GRID_SLOTS = [
    gridSlotAlongTrack(d1, -GRID_LAT * 0.72),
    gridSlotAlongTrack(d1, GRID_LAT * 0.72),
    gridSlotAlongTrack(d2, -GRID_LAT * 0.72),
    gridSlotAlongTrack(d2, GRID_LAT * 0.72),
    gridSlotAlongTrack(d3, 0),
  ];
}

recomputeGridSlots();

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
  /** Forward plasma (F) — hull damage per hit (before shield). */
  CANNON_DMG: 18,
  /** Homing missile: fraction of target max HP applied on direct hit (before shield). */
  MISSILE_HP_FRAC: 0.9,
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
    detail: "E — heat-seeker; ~90% hull damage on connect (shield cuts it).",
    chat: "loaded a homing missile",
    color: "#ff4081",
    letter: "M",
  },
  missile_rack: {
    toast: "Missile RACK +2",
    detail: "Two homing missiles (E each — devastating on hit).",
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
const CHAT_VISIBLE_LINES = 3;
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
  for (const line of chatLines.slice(-CHAT_VISIBLE_LINES)) {
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
  // Lap / CP rays use prev→curr; without this, one frame uses wreck pos→new pos and can cross S/F or CPs falsely.
  car.prevX = car.x;
  car.prevY = car.y;
  car.trackSegHint = -1;
  car.lastArcPlace = null;
  /** Must match projection used for steering — old value caused bots to orbit wrong way after wreck / big shunts. */
  car.aiWp = i;
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
      dmg: COMBAT.CANNON_DMG,
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
      dmg: 0,
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
        const dmg =
          pr.type === "missile"
            ? car.maxHp * COMBAT.MISSILE_HP_FRAC
            : pr.dmg;
        applyDamage(car, dmg, { x: pr.x, y: pr.y });
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
        applyDamage(car, car.maxHp * 0.75, { x: m.x, y: m.y });
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
        const dmg = rel * 0.006;
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
  /** Running race clock (seconds), advanced only while mode===race && !paused */
  raceElapsedSec: 0,
  /** Set when a race ends — HUD “Race” time after finish */
  raceTotalTimeAtFinish: null,
  currentLapTime: 0,
  lastLapTime: null,
  bestLap: null,
  prevPos: { x: player.x, y: player.y },
  camera: { x: 0, y: 0, zoom: 1 },
  /** Main menu or pause overlay is visible */
  menuOpen: false,
  /** "title" | "race" | "countdown" — which panel / resume behavior */
  menuContext: "title",
  paused: false,
};

function loadBestLapFromStorage() {
  const def = getLevelDef(activeLevelUid);
  let v = localStorage.getItem(`aneRacingBestLap_${def.uid}`);
  if (v == null) {
    v = localStorage.getItem(`aneRacingBestLap_${def.id}`);
  }
  if (v == null && def.id === LEVELS[0].id) {
    v = localStorage.getItem("aneRacingBestLap");
  }
  state.bestLap =
    v != null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : null;
}

/**
 * @param {string} levelUid
 * @param {{ repositionCars?: boolean, snapCamera?: boolean }} [options]
 */
function setActiveLevel(levelUid, options = {}) {
  const { repositionCars = true, snapCamera = true } = options;
  activeLevelUid = getLevelDef(levelUid).uid;
  track = buildTrackForLevel(activeLevelUid);
  recomputeGridSlots();
  try {
    localStorage.setItem("aneRacingLastLevel", activeLevelUid);
  } catch (_) {}
  loadBestLapFromStorage();
  if (repositionCars) {
    prepareGridForRaceStart();
  }
  if (snapCamera) {
    state.camera.x = player.x;
    state.camera.y = player.y;
  }
}

loadBestLapFromStorage();

function finishScreenRestartRace() {
  if (state.mode !== "finished") return;
  flushPendingLeaderboardName();
  if (overlayFinishActionsEl) overlayFinishActionsEl.classList.add("hidden");
  startSequence();
}

function finishScreenGoToMainMenu() {
  if (state.mode !== "finished") return;
  flushPendingLeaderboardName();
  prepareGridForRaceStart();
  showTitleMenu();
}

let preRaceCountdownIntervalId = null;
let preRaceCountdownTimeoutId = null;
let resumeCountdownIntervalId = null;
let resumeCountdownTimeoutId = null;
/** "main" | "instructions" | "levels" | "editor" | "options" — nested menu screens */
let menuSubScreen = "main";
/** When opening the editor from the title screen, Back returns to the title instead of the track list. */
let trackEditorFromTitle = false;
/** @type {{ destroy: () => void, getSnapshot?: () => object } | null} */
let trackEditorApi = null;
/** Highlighted level in the picker (stable UUID, not list index). */
let levelSelectUid = LEVELS[0].uid;

const CHECKPOINT_RINGS_KEY = "aneRacingShowCheckpointRings";
const FORCE_MOBILE_MODE_KEY = "aneRacingForceMobileMode";
/** Persisted UI toggles; checkpoint lap logic is unchanged when rings are off. */
const gameOptions = { showCheckpointRings: false, forceMobileMode: false };
function loadCheckpointRingsOption() {
  try {
    const v = localStorage.getItem(CHECKPOINT_RINGS_KEY);
    if (v === "1" || v === "true") return true;
    return false;
  } catch (_) {
    return false;
  }
}
function loadForceMobileModeOption() {
  try {
    const v = localStorage.getItem(FORCE_MOBILE_MODE_KEY);
    if (v === "1" || v === "true") return true;
    return false;
  } catch (_) {
    return false;
  }
}
gameOptions.showCheckpointRings = loadCheckpointRingsOption();
gameOptions.forceMobileMode = loadForceMobileModeOption();

const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlaySub = document.getElementById("overlay-sub");
const overlayHintEl = document.getElementById("overlay-hint");
const overlayFinishRankEl = document.getElementById("overlay-finish-rank");
const overlayLeaderboardEl = document.getElementById("overlay-leaderboard");
const overlayFinishActionsEl = document.getElementById("overlay-finish-actions");
const overlayLbNameWrapEl = document.getElementById("overlay-lb-name-wrap");
const overlayLbNameInputEl = document.getElementById("overlay-lb-name-input");
const countdownEl = document.getElementById("countdown");
const lapDisplay = document.getElementById("lap-display");
const currentTimeEl = document.getElementById("current-time");
const placeDisplayEl = document.getElementById("place-display");
const ammoCannonEl = document.getElementById("ammo-cannon");
const ammoMissileEl = document.getElementById("ammo-missile");
const ammoMineEl = document.getElementById("ammo-mine");
const chatLogEl = document.getElementById("chat-log");
const pickupToastEl = document.getElementById("pickup-toast");
const pickupToastTitleEl = document.getElementById("pickup-toast-title");
const pickupToastDescEl = document.getElementById("pickup-toast-desc");
const viewportEl = document.getElementById("viewport");
const gameMenuOverlayEl = document.getElementById("game-menu-overlay");
const sfxVolumeEl = document.getElementById("sfx-volume");
const musicVolumeEl = document.getElementById("music-volume");

/**
 * Some embedded WebViews ignore stacking for GPU-backed <canvas>; inline
 * setProperty(..., 'important') keeps the menu layer above the game when needed.
 */
function applyGameMenuOverlay(el) {
  if (!el) return;
  if (el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  const I = "important";
  el.style.setProperty("position", "fixed", I);
  el.style.setProperty("top", "0", I);
  el.style.setProperty("left", "0", I);
  el.style.setProperty("right", "0", I);
  el.style.setProperty("bottom", "0", I);
  el.style.setProperty("width", "100vw", I);
  el.style.setProperty("height", "100vh", I);
  el.style.setProperty("max-width", "100vw", I);
  el.style.setProperty("max-height", "100vh", I);
  el.style.setProperty("height", "100dvh", I);
  el.style.setProperty("max-height", "100dvh", I);
  el.style.setProperty("margin", "0", I);
  el.style.setProperty("padding", "1rem", I);
  el.style.setProperty("box-sizing", "border-box", I);
  el.style.setProperty("z-index", "2147483647", I);
  el.style.setProperty("display", "flex", I);
  el.style.setProperty("align-items", "center", I);
  el.style.setProperty("justify-content", "center", I);
  el.style.setProperty("visibility", "visible", I);
  el.style.setProperty("opacity", "1", I);
  el.style.setProperty("pointer-events", "auto", I);
  el.style.setProperty("background-color", "rgba(5, 8, 14, 0.94)", I);
  el.style.setProperty("-webkit-transform", "translateZ(0)", I);
  el.style.setProperty("transform", "translateZ(0)", I);
}

function hideGameMenuOverlay(el) {
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
  el.removeAttribute("style");
}

function syncPauseSliderElements() {
  if (sfxVolumeEl) sfxVolumeEl.value = String(Math.round(audio.getSfxVolume() * 100));
  if (musicVolumeEl) musicVolumeEl.value = String(Math.round(audio.getMusicVolume() * 100));
}

const btnOptionsFullscreenEl = document.getElementById("btn-options-fullscreen");

async function syncFullscreenButtonLabels() {
  let fs = !!document.fullscreenElement;
  if (window.electronShell?.getFullscreen) {
    try {
      fs = await window.electronShell.getFullscreen();
    } catch (_) {}
  }
  const label = fs ? "Exit fullscreen" : "Fullscreen";
  if (btnOptionsFullscreenEl) btnOptionsFullscreenEl.textContent = label;
}

function updateGameMenuPanels() {
  const titlePanel = document.getElementById("menu-panel-title");
  const pausePanel = document.getElementById("menu-panel-pause");
  const instructionsPanel = document.getElementById("menu-panel-instructions");
  const optionsPanel = document.getElementById("menu-panel-options");
  const levelPanel = document.getElementById("menu-panel-level-select");
  const editorPanel = document.getElementById("menu-panel-track-editor");
  if (!titlePanel || !pausePanel || !instructionsPanel || !optionsPanel) return;
  const showTitle =
    state.mode === "title" && state.menuContext === "title" && state.menuOpen;

  if (menuSubScreen === "editor") {
    editorPanel?.classList.remove("hidden");
    levelPanel?.classList.add("hidden");
    optionsPanel.classList.add("hidden");
    instructionsPanel.classList.add("hidden");
    titlePanel.classList.add("hidden");
    pausePanel.classList.add("hidden");
    return;
  }
  editorPanel?.classList.add("hidden");

  if (menuSubScreen === "levels") {
    levelPanel?.classList.remove("hidden");
    optionsPanel.classList.add("hidden");
    instructionsPanel.classList.add("hidden");
    titlePanel.classList.add("hidden");
    pausePanel.classList.add("hidden");
    return;
  }
  levelPanel?.classList.add("hidden");

  if (menuSubScreen === "options") {
    optionsPanel.classList.remove("hidden");
    instructionsPanel.classList.add("hidden");
    titlePanel.classList.add("hidden");
    pausePanel.classList.add("hidden");
    return;
  }

  if (menuSubScreen === "instructions") {
    instructionsPanel.classList.remove("hidden");
    optionsPanel.classList.add("hidden");
    titlePanel.classList.add("hidden");
    pausePanel.classList.add("hidden");
    return;
  }

  optionsPanel.classList.add("hidden");
  instructionsPanel.classList.add("hidden");
  titlePanel.classList.toggle("hidden", !showTitle);
  pausePanel.classList.toggle("hidden", showTitle);
}

function exitMenuSubscreen() {
  menuSubScreen = "main";
  updateGameMenuPanels();
}

function showInstructionsSubmenu() {
  menuSubScreen = "instructions";
  updateGameMenuPanels();
}

function syncForceMobileClass() {
  document.documentElement.classList.toggle(
    "force-mobile-testing",
    !!gameOptions.forceMobileMode
  );
}

function syncOptionsUi() {
  const el = document.getElementById("opt-show-checkpoints");
  if (el) el.checked = gameOptions.showCheckpointRings;
  const mob = document.getElementById("opt-force-mobile");
  if (mob) mob.checked = gameOptions.forceMobileMode;
  syncForceMobileClass();
}

function showOptionsSubmenu() {
  menuSubScreen = "options";
  syncOptionsUi();
  syncPauseSliderElements();
  void syncFullscreenButtonLabels();
  updateGameMenuPanels();
}

function clearPreRaceCountdown() {
  if (preRaceCountdownIntervalId != null) {
    clearInterval(preRaceCountdownIntervalId);
    preRaceCountdownIntervalId = null;
  }
  if (preRaceCountdownTimeoutId != null) {
    clearTimeout(preRaceCountdownTimeoutId);
    preRaceCountdownTimeoutId = null;
  }
}

function clearResumeRaceCountdown() {
  if (resumeCountdownIntervalId != null) {
    clearInterval(resumeCountdownIntervalId);
    resumeCountdownIntervalId = null;
  }
  if (resumeCountdownTimeoutId != null) {
    clearTimeout(resumeCountdownTimeoutId);
    resumeCountdownTimeoutId = null;
  }
}

/** 3–2–1–GO before resuming the race after pausing mid-session */
function startResumeRaceCountdown(afterGo) {
  clearResumeRaceCountdown();
  countdownEl.classList.remove("hidden");
  const labels = ["3", "2", "1", "GO"];
  let step = 0;
  countdownEl.textContent = labels[0];
  resumeCountdownIntervalId = window.setInterval(() => {
    step += 1;
    if (step < labels.length) {
      countdownEl.textContent = labels[step];
    } else {
      clearInterval(resumeCountdownIntervalId);
      resumeCountdownIntervalId = null;
      resumeCountdownTimeoutId = window.setTimeout(() => {
        resumeCountdownTimeoutId = null;
        countdownEl.classList.add("hidden");
        afterGo();
      }, 420);
    }
  }, 820);
}

function showTitleMenu() {
  destroyTrackEditor();
  trackEditorFromTitle = false;
  menuSubScreen = "main";
  clearPreRaceCountdown();
  clearResumeRaceCountdown();
  countdownEl.classList.add("hidden");
  state.mode = "title";
  state.menuContext = "title";
  state.menuOpen = true;
  state.paused = false;
  showOverlay("", "", false, "");
  updateGameMenuPanels();
  viewportEl?.classList.remove("race-paused");
  keys.up = keys.down = keys.left = keys.right = keys.handbrake = false;
  resetAllTouchDrive();
  if (gameMenuOverlayEl) {
    applyGameMenuOverlay(gameMenuOverlayEl);
    syncPauseSliderElements();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncPauseSliderElements();
        if (gameMenuOverlayEl) void gameMenuOverlayEl.offsetHeight;
      });
    });
  }
  renderLeaderboard(null);
}

function drawTrackPreviewCanvas(cnv, levelUid) {
  if (!cnv) return;
  const w = cnv.width;
  const h = cnv.height;
  const ctx = cnv.getContext("2d");
  if (!ctx) return;
  const tr = buildTrackForLevel(levelUid);
  const ro = roadOutlineForTrack(tr);
  const b = boundsRoadOutline(ro);
  let minX = b.minX;
  let minY = b.minY;
  let maxX = b.maxX;
  let maxY = b.maxY;
  const bw = maxX - minX;
  const bh = maxY - minY;
  const pad = 26;
  const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d1219";
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(s, 0, 0, s, w / 2 - cx * s, h / 2 - cy * s);
  ctx.beginPath();
  appendRoadOutlineToCanvasPath(ctx, ro);
  const grd = ctx.createLinearGradient(minX, minY, maxX, maxY);
  grd.addColorStop(0, "#2d333f");
  grd.addColorStop(1, "#1a1e28");
  ctx.fillStyle = grd;
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3 / s;
  strokeRoadOutlineBoundaries(ctx, ro);
  ctx.setLineDash([10 / s, 8 / s]);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2 / s;
  ctx.beginPath();
  ctx.moveTo(tr.center[0].x, tr.center[0].y);
  for (let i = 1; i <= tr.n; i++) {
    ctx.lineTo(tr.center[i % tr.n].x, tr.center[i % tr.n].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function syncLevelSelectUi() {
  const big = document.getElementById("level-preview-canvas");
  drawTrackPreviewCanvas(big, levelSelectUid);
  const L = getLevelDef(levelSelectUid);
  const nameEl = document.getElementById("level-preview-name");
  const tagEl = document.getElementById("level-preview-tag");
  if (nameEl) nameEl.textContent = L.name;
  if (tagEl) tagEl.textContent = L.tagline;
  const customAct = document.getElementById("level-select-custom-actions");
  if (customAct) {
    const isBuiltIn = LEVELS.some((L) => L.uid === levelSelectUid);
    const showEditDelete = isCustomTrackUid(levelSelectUid) && !isBuiltIn;
    customAct.classList.toggle("hidden", !showEditDelete);
    customAct.setAttribute("aria-hidden", showEditDelete ? "false" : "true");
  }
  const lbEl = document.getElementById("leaderboard-list-level-select");
  if (lbEl) {
    fillLeaderboardList(lbEl, null, parseLeaderboardForLevelUid(levelSelectUid));
  }
  document.querySelectorAll("[data-level-uid]").forEach((row) => {
    const u = row.getAttribute("data-level-uid");
    row.classList.toggle("level-select-row--active", u === levelSelectUid);
  });
}

function populateLevelSelectList() {
  const container = document.getElementById("level-select-list");
  if (!container) return;
  container.innerHTML = "";
  function addRow(Lv, extraClass = "") {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "level-select-row" + (extraClass ? ` ${extraClass}` : "");
    row.setAttribute("data-level-uid", Lv.uid);
    row.innerHTML =
      '<canvas class="level-thumb-canvas" width="112" height="72" aria-hidden="true"></canvas>' +
      '<span class="level-select-row-text">' +
      `<span class="level-select-row-name">${Lv.name}</span>` +
      `<span class="level-select-row-tag">${Lv.tagline}</span>` +
      "</span>";
    row.addEventListener("click", () => {
      levelSelectUid = Lv.uid;
      syncLevelSelectUi();
    });
    container.appendChild(row);
    const thumb = row.querySelector(".level-thumb-canvas");
    drawTrackPreviewCanvas(thumb, Lv.uid);
  }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  LEVELS.forEach((Lv) => addRow(Lv));
  loadCustomTracks().forEach((rec) => {
    const def = customRecordToLevelDef(rec);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "level-select-row level-select-row--custom";
    row.setAttribute("data-level-uid", def.uid);
    row.innerHTML =
      '<canvas class="level-thumb-canvas" width="112" height="72" aria-hidden="true"></canvas>' +
      '<span class="level-select-row-text">' +
      `<span class="level-select-row-name">${escHtml(def.name)}</span>` +
      `<span class="level-select-row-tag">${escHtml(def.tagline)}</span>` +
      "</span>";
    row.addEventListener("click", () => {
      levelSelectUid = def.uid;
      syncLevelSelectUi();
    });
    container.appendChild(row);
    const thumb = row.querySelector(".level-thumb-canvas");
    drawTrackPreviewCanvas(thumb, def.uid);
  });
}

function destroyTrackEditor() {
  if (trackEditorApi?.destroy) {
    trackEditorApi.destroy();
  }
  trackEditorApi = null;
}

function closeTrackEditorFromBack() {
  destroyTrackEditor();
  if (trackEditorFromTitle) {
    menuSubScreen = "main";
  } else {
    menuSubScreen = "levels";
    populateLevelSelectList();
    syncLevelSelectUi();
  }
  trackEditorFromTitle = false;
  updateGameMenuPanels();
}

function finishTrackEditorSave(uid) {
  trackCache.delete(uid);
  destroyTrackEditor();
  trackEditorFromTitle = false;
  menuSubScreen = "levels";
  populateLevelSelectList();
  levelSelectUid = uid;
  syncLevelSelectUi();
  updateGameMenuPanels();
}

/**
 * @param {object | null | undefined} initial
 * @param {{ fromTitle?: boolean }} [opts]
 */
function openTrackEditor(initial, opts = {}) {
  destroyTrackEditor();
  trackEditorFromTitle = Boolean(opts.fromTitle);
  menuSubScreen = "editor";
  state.menuOpen = true;
  state.menuContext = "title";
  updateGameMenuPanels();
  const canvas = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById("track-editor-canvas")
  );
  if (!canvas || !gameMenuOverlayEl) {
    menuSubScreen = trackEditorFromTitle ? "main" : "levels";
    trackEditorFromTitle = false;
    updateGameMenuPanels();
    return;
  }
  applyGameMenuOverlay(gameMenuOverlayEl);
  syncPauseSliderElements();
  trackEditorApi = initTrackEditor({
    canvas,
    initial: initial || undefined,
    onClose: () => {
      closeTrackEditorFromBack();
    },
    onSave: ({ name, control, widthScale, uid }) => {
      const outUid = createCustomTrack({ name, control, widthScale, uid });
      finishTrackEditorSave(outUid);
    },
  });
}

function trySaveAndRaceFromEditor() {
  if (!trackEditorApi?.getSnapshot) return;
  const snap = trackEditorApi.getSnapshot();
  if (!snap.valid) return;
  const uid = createCustomTrack({
    name: snap.name,
    control: snap.control,
    widthScale: snap.widthScale,
    uid: snap.uid,
  });
  trackCache.delete(uid);
  populateLevelSelectList();
  levelSelectUid = uid;
  destroyTrackEditor();
  trackEditorFromTitle = false;
  setActiveLevel(uid);
  startSequence();
}

function showLevelSelectMenu() {
  menuSubScreen = "levels";
  state.menuOpen = true;
  state.menuContext = "title";
  levelSelectUid = activeLevelUid;
  syncLevelSelectUi();
  updateGameMenuPanels();
  if (gameMenuOverlayEl) {
    applyGameMenuOverlay(gameMenuOverlayEl);
    syncPauseSliderElements();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncPauseSliderElements();
        if (gameMenuOverlayEl) void gameMenuOverlayEl.offsetHeight;
      });
    });
  }
}

function startRaceFromLevelSelect() {
  setActiveLevel(levelSelectUid);
  menuSubScreen = "main";
  startSequence();
}

function openRaceOrCountdownMenu() {
  menuSubScreen = "main";
  if (state.mode === "race") {
    state.menuContext = "race";
    state.paused = true;
    keys.up = keys.down = keys.left = keys.right = keys.handbrake = false;
    resetAllTouchDrive();
  } else if (state.mode === "countdown") {
    clearPreRaceCountdown();
    countdownEl.classList.add("hidden");
    state.menuContext = "countdown";
    keys.up = keys.down = keys.left = keys.right = keys.handbrake = false;
    resetAllTouchDrive();
  } else {
    return;
  }
  state.menuOpen = true;
  viewportEl?.classList.add("race-paused");
  updateGameMenuPanels();
  if (gameMenuOverlayEl) {
    applyGameMenuOverlay(gameMenuOverlayEl);
    syncPauseSliderElements();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncPauseSliderElements();
        if (gameMenuOverlayEl) void gameMenuOverlayEl.offsetHeight;
      });
    });
  }
}

function resumeFromGameMenu() {
  if (!state.menuOpen) return;
  menuSubScreen = "main";
  const ctx = state.menuContext;
  hideGameMenuOverlay(gameMenuOverlayEl);
  state.menuOpen = false;

  if (ctx === "race") {
    startResumeRaceCountdown(() => {
      state.paused = false;
      viewportEl?.classList.remove("race-paused");
    });
  } else if (ctx === "countdown") {
    startSequence();
  }
}

/** Abandon current race / countdown and return to the title screen. */
function returnToMainMenuFromPause() {
  if (!state.menuOpen) return;
  if (state.menuContext !== "race" && state.menuContext !== "countdown") return;
  menuSubScreen = "main";
  clearPreRaceCountdown();
  clearResumeRaceCountdown();
  countdownEl.classList.add("hidden");
  prepareGridForRaceStart();
  showTitleMenu();
}

function exitGame() {
  if (window.electronShell?.quit) {
    window.electronShell.quit();
    return;
  }
  window.close();
}

function toggleFullscreenGame() {
  if (window.electronShell?.toggleFullscreen) {
    void window.electronShell.toggleFullscreen();
    setTimeout(() => void syncFullscreenButtonLabels(), 150);
    return;
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen?.()?.then(() => syncFullscreenButtonLabels());
  } else {
    void document.documentElement.requestFullscreen?.()?.then(() => syncFullscreenButtonLabels());
  }
}

function restartRaceFromMenu() {
  if (state.mode !== "race") return;
  menuSubScreen = "main";
  clearResumeRaceCountdown();
  prepareGridForRaceStart();
  hideGameMenuOverlay(gameMenuOverlayEl);
  state.menuOpen = false;
  state.paused = true;
  viewportEl?.classList.add("race-paused");
  startResumeRaceCountdown(() => {
    beginRaceFromGrid();
  });
}

function showOverlay(title, sub, show = true, hint = "", options = {}) {
  overlayTitle.textContent = title;
  overlaySub.textContent = sub || "";
  overlay.classList.toggle("hidden", !show);
  if (overlayHintEl) {
    overlayHintEl.textContent = hint;
    overlayHintEl.classList.toggle("hidden", !hint);
  }
  if (overlayFinishRankEl) {
    if (show && options.showLeaderboard && "finishRank" in options) {
      const r = options.finishRank;
      overlayFinishRankEl.classList.remove("hidden");
      if (r != null && r >= 1 && r <= LEADERBOARD_MAX) {
        overlayFinishRankEl.textContent = `This race: #${r} of your ${LEADERBOARD_MAX} fastest saved races`;
        overlayFinishRankEl.classList.toggle("finish-rank-podium", r <= 3);
      } else {
        overlayFinishRankEl.textContent = `Not among your ${LEADERBOARD_MAX} fastest saved races`;
        overlayFinishRankEl.classList.remove("finish-rank-podium");
      }
    } else {
      overlayFinishRankEl.classList.add("hidden");
    }
  }
  if (overlayLeaderboardEl) {
    const showLb = Boolean(show && options.showLeaderboard);
    overlayLeaderboardEl.classList.toggle("hidden", !showLb);
  }
  if (overlayFinishActionsEl) {
    if (!show) {
      overlayFinishActionsEl.classList.add("hidden");
    } else {
      overlayFinishActionsEl.classList.toggle("hidden", !options.showFinishActions);
    }
  }
  if (overlayLbNameWrapEl) {
    if (show && options.leaderboardEntryTs != null) {
      pendingLeaderboardEntryTs = options.leaderboardEntryTs;
      overlayLbNameWrapEl.classList.remove("hidden");
      overlayLbNameWrapEl.setAttribute("aria-hidden", "false");
      if (overlayLbNameInputEl) {
        const rows = parseLeaderboard();
        const row = rows.find((r) => r.ts === options.leaderboardEntryTs);
        const v = row && row.name != null ? String(row.name) : "";
        overlayLbNameInputEl.value = v;
        requestAnimationFrame(() => overlayLbNameInputEl?.focus());
      }
    } else {
      flushPendingLeaderboardName();
      pendingLeaderboardEntryTs = null;
      overlayLbNameWrapEl.classList.add("hidden");
      overlayLbNameWrapEl.setAttribute("aria-hidden", "true");
      if (overlayLbNameInputEl) overlayLbNameInputEl.value = "";
    }
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
  if (state.mode === "finished" && state.raceTotalTimeAtFinish != null) {
    currentTimeEl.textContent = formatTime(state.raceTotalTimeAtFinish);
  } else if (state.mode === "race") {
    currentTimeEl.textContent = formatTime(state.raceElapsedSec);
  } else {
    currentTimeEl.textContent = "--:--.--";
  }

  const pl = player;
  ammoCannonEl.textContent = String(Math.floor(pl.ammoCannon));
  ammoMissileEl.textContent = String(pl.ammoMissile);
  ammoMineEl.textContent = String(pl.ammoMines);
  syncTouchRaceHud();
}

const ACCEL = 520;
const FRICTION = 0.978;
const STEER = 2.85;
const MAX_SPEED = 420;
/** Joystick deflection is a world-space drive vector; gain maps angle error → ±1 steer input. */
const JOY_STICK_DEAD = 0.14;
const JOY_STICK_STEER_GAIN = 2.45;

/** Point on the centerline ~`distAhead` forward from vertex index `fromIdx` (arc-length). */
function getCenterPointAhead(fromIdx, distAhead) {
  const n = track.n;
  let i = ((fromIdx % n) + n) % n;
  let remaining = distAhead;
  for (let guard = 0; guard <= n + 6 && remaining > 0.35; guard++) {
    const j = (i + 1) % n;
    const ax = track.center[i].x;
    const ay = track.center[i].y;
    const bx = track.center[j].x;
    const by = track.center[j].y;
    const sl = hypot(bx - ax, by - ay);
    if (sl < 1e-6) {
      i = j;
      continue;
    }
    if (remaining <= sl) {
      const t = remaining / sl;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
    }
    remaining -= sl;
    i = j;
  }
  return { x: track.center[i].x, y: track.center[i].y };
}

/** Stable direction away from the nearest wall chords (helps bots hold a clean line). */
function aiWallRepulsion(car) {
  let rx = 0;
  let ry = 0;
  const targetClear = CAR_R + 36;
  for (const seg of track.wallSegments) {
    const d = distPointSegment(car.x, car.y, seg.a.x, seg.a.y, seg.b.x, seg.b.y);
    if (d >= targetClear + 18) continue;
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
    const nl = hypot(nx, ny);
    if (nl < 1e-6) continue;
    nx /= nl;
    ny /= nl;
    const pen = clamp((targetClear - d) / targetClear, 0, 1);
    rx += nx * pen;
    ry += ny * pen;
  }
  const rl = hypot(rx, ry);
  if (rl < 0.06) return { x: 0, y: 0 };
  return { x: rx / rl, y: ry / rl };
}

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
    let thr = 0;
    const hb = input.handbrake;
    /** Screen axes match world axes (camera is translated only). Stick = desired drive direction on the map. */
    if (touchDrive.stickActive) {
      const jx = touchDrive.jx;
      const jy = touchDrive.jy;
      const mag = Math.min(1, hypot(jx, jy));
      const want = Math.atan2(jy, jx);
      const diff = wrapAngle(want - car.angle);
      steer = clamp(diff * JOY_STICK_STEER_GAIN, -1, 1);
      let tcos = mag * Math.cos(diff);
      if (tcos < 0) tcos *= 0.35;
      thr = tcos;
    } else {
      if (input.left) steer -= 1;
      if (input.right) steer += 1;
      thr = (input.up ? 1 : 0) - (input.down ? 0.35 : 0);
    }
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
    const nowSec = performance.now() * 0.001;
    const tRace =
      state.raceStartTime > 0 ? nowSec - state.raceStartTime : 999;
    /** 0 right at green → 1 after a few seconds: eases launch aggression */
    const startEase = clamp(tRace / 2.5, 0, 1);

    distanceAlongTrackForCar(car);
    car.aiWp = car.trackSegHint;
    const wp = ((car.aiWp % track.n) + track.n) % track.n;
    const tan0 = track.tangent(wp);
    const across = { x: -tan0.y, y: tan0.x };
    const lateral = car.aiOffset * track.width * (0.09 + 0.07 * startEase);
    const lookBase = 168 + Math.abs(car.aiOffset) * 48;
    const look = lookBase * (0.52 + 0.48 * startEase);
    const ahead = getCenterPointAhead(wp, look);
    let tx = ahead.x + across.x * lateral;
    let ty = ahead.y + across.y * lateral;
    const rep = aiWallRepulsion(car);
    const repGain = 112 * (1.4 - 0.35 * startEase);
    tx += rep.x * repGain;
    ty += rep.y * repGain;

    const dx = tx - car.x;
    const dy = ty - car.y;
    const want = Math.atan2(dy, dx);
    let diff = wrapAngle(want - car.angle + car.aiOffset * 0.12 * startEase);
    const absDiff = Math.abs(diff);
    const steerGain =
      (2.75 + 0.52 * startEase) *
      (0.82 + 0.18 * clamp(car.speed / MAX_SPEED, 0, 1)) *
      (1 + 0.42 * clamp(absDiff - 0.35, 0, 1.1));
    const steerAi = clamp(diff * steerGain, -1, 1);
    /** Tighter hairpins: extra yaw + light speed bleed (player handbrake analogy). */
    const hbSim =
      absDiff > 0.62 && car.speed > 72
        ? 1.22 + 0.28 * clamp((absDiff - 0.62) / 0.55, 0, 1)
        : 1;
    car.angle += steerAi * STEER * dt * (0.88 + 0.12 * startEase) * hbSim;
    if (hbSim > 1.08 && car.speed > 48) {
      const bleed = 1 - dt * 0.32 * (hbSim - 1);
      car.vx *= bleed;
      car.vy *= bleed;
    }

    const cornerBrake = clamp(
      absDiff * (1.08 + 0.38 * (1 - startEase)),
      0,
      1
    );
    let throttle =
      (1 - cornerBrake * (0.32 + 0.12 * (1 - startEase))) *
      (0.91 + Math.sin(performance.now() * 0.0016 + car.aiOffset * 11) * 0.048);
    if (car.boostT > 0) {
      throttle *= 1.25;
    }
    throttle *= 0.52 + 0.48 * startEase;
    const trackForward = car.vx * tan0.x + car.vy * tan0.y;
    if (trackForward < -30) {
      throttle *= clamp(1 + trackForward / 130, 0.38, 1);
    }
    const ax = Math.cos(car.angle) * ACCEL * throttle;
    const ay = Math.sin(car.angle) * ACCEL * throttle;
    car.vx += ax * dt;
    car.vy += ay * dt;
  }

  const sp = car.speed;
  const cap = MAX_SPEED * (car.boostT > 0 ? 1.22 : 1);
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
  if (car.wrecked) return;
  const fl = track.finishLine;
  // Only the finite S/F segment counts — not the infinite line through it (else false laps elsewhere).
  if (segmentIntersect(prev, curr, fl.a, fl.b) == null) return;

  const vx = curr.x - prev.x;
  const vy = curr.y - prev.y;
  const forward = vx * fl.tangent.x + vy * fl.tangent.y;
  if (forward <= 0) return;

  const cps = track.checkpoints || [];
  if (cps.length > 0 && car.nextCheckpointIndex < cps.length) return;

  // New lap: reset CP counter, then credit any gates whose disks already contain the car
  // (e.g. CP1 on/near S/F — no outside→inside edge needed on the frame you cross the line).
  car.nextCheckpointIndex = 0;
  if (cps.length > 0) {
    const px = curr.x;
    const py = curr.y;
    while (car.nextCheckpointIndex < cps.length) {
      const cp = cps[car.nextCheckpointIndex];
      if (hypot(px - cp.x, py - cp.y) < cp.r) {
        car.nextCheckpointIndex++;
      } else {
        break;
      }
    }
  }
  car.raceLap += 1;

  if (!car.isPlayer) {
    return;
  }

  const now = performance.now() / 1000;
  const lapTime = now - state.lapStartTime;
  state.lastLapTime = lapTime;
  if (state.bestLap == null || lapTime < state.bestLap) {
    state.bestLap = lapTime;
    const def = getLevelDef(activeLevelUid);
    try {
      localStorage.setItem(`aneRacingBestLap_${def.uid}`, String(lapTime));
      if (def.id === LEVELS[0].id) {
        localStorage.setItem("aneRacingBestLap", String(lapTime));
      }
    } catch (_) {}
  }
  state.lapStartTime = now;
  state.lap = player.raceLap;

  if (player.raceLap > state.totalLaps) {
    state.mode = "finished";
    const totalTime = now - state.raceStartTime;
    state.raceTotalTimeAtFinish = totalTime;
    state.raceElapsedSec = totalTime;
    const { rank, leaderboardEntryTs } = recordRaceFinishTime(totalTime);
    showOverlay(
      "Finish!",
      `Total time: ${formatTime(totalTime)}\nBest lap: ${formatTime(state.bestLap)}`,
      true,
      "",
      {
        showLeaderboard: true,
        finishRank: rank,
        leaderboardEntryTs,
        showFinishActions: true,
      }
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

/** Count checkpoints whose entry edge was crossed prev→curr; loop allows several in one frame. */
function accumulateCheckpointsForCars(cars, cps) {
  if (!cps || cps.length === 0) return;
  for (const car of cars) {
    if (car.wrecked) continue;
    let guard = 0;
    while (guard++ < cps.length + 2) {
      const idx = car.nextCheckpointIndex;
      if (idx >= cps.length) break;
      const cp = cps[idx];
      const ax = car.prevX;
      const ay = car.prevY;
      const bx = car.x;
      const by = car.y;
      const d = hypot(bx - cp.x, by - cp.y);
      const dprev = hypot(ax - cp.x, ay - cp.y);
      const moveLen = hypot(bx - ax, by - ay);
      const entryFromOutside = d < cp.r && dprev >= cp.r;
      const chordThroughDisk =
        moveLen > 0.2 &&
        dprev > cp.r &&
        d > cp.r &&
        circleHitsSegment(cp.x, cp.y, cp.r, ax, ay, bx, by);
      if (entryFromOutside || chordThroughDisk) {
        car.nextCheckpointIndex++;
      } else {
        break;
      }
    }
  }
}

const keys = { up: false, down: false, left: false, right: false, handbrake: false };

/**
 * Virtual joystick: `jx,jy` = screen/world drive direction (-1…1); handbrake from its button.
 * (Keyboard still uses discrete keys via `mergedKeys`.)
 */
const touchDrive = {
  jx: 0,
  jy: 0,
  stickActive: false,
  handbrake: false,
};

const mergedKeys = {
  up: false,
  down: false,
  left: false,
  right: false,
  handbrake: false,
};

function refreshMergedKeys() {
  mergedKeys.up = keys.up;
  mergedKeys.down = keys.down;
  mergedKeys.left = keys.left;
  mergedKeys.right = keys.right;
  mergedKeys.handbrake = keys.handbrake || touchDrive.handbrake;
}

const touchHudEl = document.getElementById("touch-hud");
const touchJoystickBaseEl = document.getElementById("touch-joystick-base");
const touchJoystickKnobEl = document.getElementById("touch-joystick-knob");
const touchHudMenuEl = document.getElementById("touch-hud-menu");
const touchHudHbEl = document.getElementById("touch-hud-handbrake");

function prefersTouchRaceHud() {
  if (gameOptions.forceMobileMode) return true;

  /**
   * iOS Safari often reports `(pointer: fine)` for the primary pointer even on iPhone; use
   * `any-pointer: coarse`, touch caps, and UA fallbacks (see WebKit / MQ4 discussions).
   */
  try {
    const mq = typeof window !== "undefined" && window.matchMedia;
    if (mq && mq("(any-pointer: coarse)").matches) return true;
    if (mq && mq("(pointer: coarse)").matches) return true;
  } catch (_) {}

  const mtp = navigator.maxTouchPoints ?? 0;
  if (mtp > 0) return true;
  if (typeof window !== "undefined" && "ontouchstart" in window) return true;

  const ua = navigator.userAgent || "";
  if (/\b(iPhone|iPod)\b/i.test(ua)) return true;
  if (/\biPad\b/i.test(ua) || (navigator.platform === "MacIntel" && mtp > 1)) return true;

  return false;
}

const PORTRAIT_HINT_DISMISS_KEY = "aneRacingPortraitHintDismiss";

/**
 * Banner when a touch‑oriented client is in portrait (landscape plays best).
 * Dismissal is per browser tab session (`sessionStorage`).
 */
function syncPortraitOrientationHint() {
  const el = document.getElementById("portrait-orient-hint");
  if (!el) return;
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem(PORTRAIT_HINT_DISMISS_KEY) === "1";
  } catch (_) {}
  let portrait = false;
  try {
    portrait = matchMedia("(orientation: portrait)").matches;
  } catch (_) {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    portrait = w > 0 && h > 0 && w < h;
  }
  const show = !dismissed && portrait && prefersTouchRaceHud();
  el.classList.toggle("hidden", !show);
  el.setAttribute("aria-hidden", show ? "false" : "true");
}

function resetAllTouchDrive() {
  touchDrive.jx = 0;
  touchDrive.jy = 0;
  touchDrive.stickActive = false;
  touchDrive.handbrake = false;
  joystickPointerId = null;
  if (touchJoystickKnobEl) touchJoystickKnobEl.style.transform = "translate(0, 0)";
}

/**
 * @returns {void}
 */
function syncTouchRaceHud() {
  if (!touchHudEl) return;
  const show =
    prefersTouchRaceHud() &&
    !state.menuOpen &&
    (state.mode === "race" || state.mode === "countdown");
  touchHudEl.classList.toggle("hidden", !show);
  touchHudEl.setAttribute("aria-hidden", show ? "false" : "true");
  touchHudEl.classList.toggle("touch-hud--countdown", state.mode === "countdown");
}

let joystickPointerId = /** @type {number | null} */ (null);

function updateJoystickKnobFromEvent(/** @type {PointerEvent} */ ev) {
  if (!touchJoystickBaseEl || !touchJoystickKnobEl) return;
  const rect = touchJoystickBaseEl.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  const dx = ev.clientX - cx;
  const dy = ev.clientY - cy;
  const maxD = Math.min(rect.width, rect.height) * 0.38;
  let nx = dx;
  let ny = dy;
  const d = Math.hypot(dx, dy);
  if (d > maxD && d > 1e-6) {
    nx = (dx / d) * maxD;
    ny = (dy / d) * maxD;
  }
  const hx = maxD > 1e-6 ? nx / maxD : 0;
  const hy = maxD > 1e-6 ? ny / maxD : 0;
  const m = Math.hypot(hx, hy);
  if (m < JOY_STICK_DEAD) {
    touchDrive.jx = 0;
    touchDrive.jy = 0;
    touchDrive.stickActive = false;
  } else {
    touchDrive.jx = hx;
    touchDrive.jy = hy;
    touchDrive.stickActive = true;
  }
  touchJoystickKnobEl.style.transform = `translate(${nx}px, ${ny}px)`;
}

function clearJoystickTouchAxes() {
  touchDrive.jx = 0;
  touchDrive.jy = 0;
  touchDrive.stickActive = false;
  if (touchJoystickKnobEl) touchJoystickKnobEl.style.transform = "translate(0, 0)";
}

if (touchJoystickBaseEl && touchJoystickKnobEl) {
  const base = touchJoystickBaseEl;
  const onJMove = (/** @type {PointerEvent} */ ev) => {
    if (joystickPointerId === null || ev.pointerId !== joystickPointerId) return;
    ev.preventDefault();
    updateJoystickKnobFromEvent(ev);
  };
  const onJEnd = (/** @type {PointerEvent} */ ev) => {
    if (joystickPointerId === null || ev.pointerId !== joystickPointerId) return;
    ev.preventDefault();
    try {
      base.releasePointerCapture(ev.pointerId);
    } catch (_) {}
    joystickPointerId = null;
    clearJoystickTouchAxes();
  };
  base.addEventListener(
    "pointerdown",
    (ev) => {
      if (joystickPointerId !== null) return;
      try {
        audio.ensureAudio();
      } catch (_) {}
      ev.preventDefault();
      joystickPointerId = ev.pointerId;
      try {
        base.setPointerCapture(ev.pointerId);
      } catch (_) {}
      updateJoystickKnobFromEvent(ev);
    },
    { passive: false }
  );
  base.addEventListener("pointermove", onJMove, { passive: false });
  base.addEventListener("pointerup", onJEnd);
  base.addEventListener("pointercancel", onJEnd);
  base.addEventListener("lostpointercapture", onJEnd);
}

if (touchHudHbEl) {
  const setHb = (v) => {
    touchDrive.handbrake = v;
  };
  touchHudHbEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      audio.ensureAudio();
    } catch (_) {}
    setHb(true);
  });
  touchHudHbEl.addEventListener("pointerup", () => setHb(false));
  touchHudHbEl.addEventListener("pointercancel", () => setHb(false));
  touchHudHbEl.addEventListener("pointerleave", (e) => {
    if (e.buttons === 0) setHb(false);
  });
}

function bindTouchWeapon(id, /** @type {"cannon"|"missile"|"mine"} */ type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      audio.ensureAudio();
    } catch (_) {}
    if (state.mode !== "race" || state.paused || player.wrecked) return;
    trySpawnProjectile(player, type);
  });
}

bindTouchWeapon("touch-weapon-cannon", "cannon");
bindTouchWeapon("touch-weapon-missile", "missile");
bindTouchWeapon("touch-weapon-mine", "mine");

if (touchHudMenuEl) {
  touchHudMenuEl.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      audio.ensureAudio();
    } catch (_) {}
    if (state.mode === "race" || state.mode === "countdown") {
      openRaceOrCountdownMenu();
    }
  });
}

window.addEventListener("keydown", (e) => {
  try {
    audio.ensureAudio();
  } catch (_) {}

  if (e.code === "ArrowUp" || e.code === "KeyW") keys.up = true;
  if (e.code === "ArrowDown" || e.code === "KeyS") keys.down = true;
  if (e.code === "ArrowLeft" || e.code === "KeyA") keys.left = true;
  if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys.handbrake = true;

  if (e.code === "Escape") {
    if (state.menuOpen && menuSubScreen === "editor") {
      e.preventDefault();
      closeTrackEditorFromBack();
      return;
    }
    if (
      state.menuOpen &&
      (menuSubScreen === "instructions" || menuSubScreen === "options")
    ) {
      e.preventDefault();
      exitMenuSubscreen();
      return;
    }
    if (state.menuOpen && menuSubScreen === "levels") {
      e.preventDefault();
      menuSubScreen = "main";
      updateGameMenuPanels();
      return;
    }
    if (state.menuOpen) {
      if (state.menuContext === "title") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      resumeFromGameMenu();
      return;
    }
    if (state.mode === "race" || state.mode === "countdown") {
      e.preventDefault();
      openRaceOrCountdownMenu();
      return;
    }
  }

  if (e.code === "KeyP" && !e.repeat) {
    if (
      state.menuOpen &&
      (menuSubScreen === "instructions" || menuSubScreen === "options")
    ) {
      e.preventDefault();
      exitMenuSubscreen();
      return;
    }
    if (state.mode === "race" || state.mode === "countdown") {
      e.preventDefault();
      if (state.menuOpen) resumeFromGameMenu();
      else openRaceOrCountdownMenu();
      return;
    }
  }

  if (e.code === "Space") {
    const st = /** @type {EventTarget | null} */ (e.target);
    if (
      st instanceof HTMLInputElement ||
      st instanceof HTMLTextAreaElement ||
      (st instanceof HTMLElement && st.isContentEditable)
    ) {
      return;
    }
    e.preventDefault();
    if (state.menuOpen) {
      if (menuSubScreen === "editor") {
        return;
      }
      if (menuSubScreen === "instructions" || menuSubScreen === "options") {
        exitMenuSubscreen();
        return;
      }
      if (menuSubScreen === "levels") {
        startRaceFromLevelSelect();
        return;
      }
      if (state.menuContext === "title") {
        showLevelSelectMenu();
        return;
      }
      resumeFromGameMenu();
      return;
    }
  }

  if (
    state.mode === "race" &&
    !state.paused &&
    !e.repeat &&
    !player.wrecked
  ) {
    if (e.code === "KeyF" || e.code === "Space") trySpawnProjectile(player, "cannon");
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

/** Grid positions + world reset; call before pre-race or restart countdown */
function prepareGridForRaceStart() {
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
    c.aiWp = nearestCenterIndex(c.x, c.y);
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
    c.nextCheckpointIndex = 0;
    c.trackSegHint = -1;
    c.lastArcPlace = null;
    c.prevX = c.x;
    c.prevY = c.y;
  }

  state.prevPos.x = player.x;
  state.prevPos.y = player.y;
  updateHud();
}

/** After 3–2–1–GO; starts lap clock and green-flag messaging */
function beginRaceFromGrid() {
  state.lap = 1;
  state.lastLapTime = null;
  state.lapStartTime = performance.now() / 1000;
  state.raceStartTime = state.lapStartTime;
  state.raceElapsedSec = 0;
  state.raceTotalTimeAtFinish = null;
  state.mode = "race";
  state.paused = false;
  state.menuOpen = false;
  state.menuContext = "race";
  showOverlay("", "", false, "");
  countdownEl.classList.add("hidden");
  viewportEl?.classList.remove("race-paused");
  if (gameMenuOverlayEl) hideGameMenuOverlay(gameMenuOverlayEl);
  state.prevPos.x = player.x;
  state.prevPos.y = player.y;
  chatLines.length = 0;
  chatTauntAcc = 0;
  chatTauntNext = 3 + Math.random() * 6;
  addChatLine("Race", "#6b7a8f", "Green flag — good luck!");
  updateHud();
  renderLeaderboard(null);
}

function startSequence() {
  menuSubScreen = "main";
  showOverlay("", "", false, "");
  clearPreRaceCountdown();
  clearResumeRaceCountdown();
  state.paused = false;
  state.menuOpen = false;
  viewportEl?.classList.remove("race-paused");
  if (gameMenuOverlayEl) hideGameMenuOverlay(gameMenuOverlayEl);
  prepareGridForRaceStart();
  state.mode = "countdown";
  countdownEl.classList.remove("hidden");
  const labels = ["3", "2", "1", "GO"];
  let step = 0;
  countdownEl.textContent = labels[0];
  preRaceCountdownIntervalId = window.setInterval(() => {
    step += 1;
    if (step < labels.length) {
      countdownEl.textContent = labels[step];
    } else {
      clearInterval(preRaceCountdownIntervalId);
      preRaceCountdownIntervalId = null;
      preRaceCountdownTimeoutId = window.setTimeout(() => {
        preRaceCountdownTimeoutId = null;
        countdownEl.classList.add("hidden");
        beginRaceFromGrid();
      }, 420);
    }
  }, 820);
}

if (sfxVolumeEl) {
  sfxVolumeEl.addEventListener("input", () => {
    try {
      audio.ensureAudio();
    } catch (_) {}
    const v = Number(sfxVolumeEl.value) / 100;
    audio.setSfxVolume(v);
    localStorage.setItem("aneRacingSfxVol", String(v));
  });
}
if (musicVolumeEl) {
  musicVolumeEl.addEventListener("input", () => {
    try {
      audio.ensureAudio();
    } catch (_) {}
    const v = Number(musicVolumeEl.value) / 100;
    audio.setMusicVolume(v);
    localStorage.setItem("aneRacingMusicVol", String(v));
  });
}
if (gameMenuOverlayEl) {
  gameMenuOverlayEl.addEventListener("click", (e) => {
    if (e.target !== gameMenuOverlayEl) return;
    if (menuSubScreen === "editor") {
      closeTrackEditorFromBack();
      return;
    }
    if (
      menuSubScreen === "instructions" ||
      menuSubScreen === "options"
    ) {
      exitMenuSubscreen();
      return;
    }
    if (menuSubScreen === "levels") {
      menuSubScreen = "main";
      updateGameMenuPanels();
      return;
    }
    if (state.menuContext === "title") return;
    resumeFromGameMenu();
  });
}

document.getElementById("btn-new-game")?.addEventListener("click", () => {
  if (state.mode === "title") showLevelSelectMenu();
});
document.getElementById("btn-title-track-editor")?.addEventListener("click", () => {
  if (state.mode === "title") openTrackEditor(null, { fromTitle: true });
});
document.getElementById("btn-level-edit-track")?.addEventListener("click", () => {
  if (menuSubScreen !== "levels") return;
  if (LEVELS.some((L) => L.uid === levelSelectUid)) return;
  const rec = findCustomRecord(levelSelectUid);
  if (!rec) return;
  if (
    !window.confirm(
      "Editing changes this layout. Saved top times and your best lap for this track will be cleared. Continue?"
    )
  ) {
    return;
  }
  clearSavedRaceTimesForLevelUid(rec.uid);
  trackCache.delete(rec.uid);
  openTrackEditor(rec, { fromTitle: false });
});
document.getElementById("btn-level-delete-track")?.addEventListener("click", () => {
  if (menuSubScreen !== "levels") return;
  if (LEVELS.some((L) => L.uid === levelSelectUid)) return;
  if (!isCustomTrackUid(levelSelectUid)) return;
  const L = getLevelDef(levelSelectUid);
  if (!window.confirm(`Delete "${L.name}"? This removes it from your device.`)) return;
  const removed = levelSelectUid;
  deleteCustomTrack(removed);
  trackCache.delete(removed);
  populateLevelSelectList();
  levelSelectUid = LEVELS[0].uid;
  if (activeLevelUid === removed) {
    setActiveLevel(LEVELS[0].uid);
  }
  syncLevelSelectUi();
});
document.getElementById("track-editor-save-race")?.addEventListener("click", () => {
  if (menuSubScreen !== "editor") return;
  trySaveAndRaceFromEditor();
});
document.getElementById("btn-level-back")?.addEventListener("click", () => {
  if (menuSubScreen === "levels") {
    menuSubScreen = "main";
    updateGameMenuPanels();
  }
});
document.getElementById("btn-level-start")?.addEventListener("click", () => {
  if (menuSubScreen === "levels" && state.mode === "title") {
    startRaceFromLevelSelect();
  }
});
document.getElementById("btn-finish-restart")?.addEventListener("click", () => {
  finishScreenRestartRace();
});
document.getElementById("btn-finish-main-menu")?.addEventListener("click", () => {
  finishScreenGoToMainMenu();
});
overlayLbNameInputEl?.addEventListener("input", () => {
  if (pendingLeaderboardEntryTs == null || !overlayLbNameInputEl) return;
  let v = overlayLbNameInputEl.value;
  if (v.length > LEADERBOARD_NAME_MAX) {
    v = v.slice(0, LEADERBOARD_NAME_MAX);
    overlayLbNameInputEl.value = v;
  }
  updateLeaderboardEntryName(pendingLeaderboardEntryTs, v);
});
overlayLbNameInputEl?.addEventListener("keydown", (e) => {
  if (e.code !== "Enter") return;
  e.preventDefault();
  if (pendingLeaderboardEntryTs == null || !overlayLbNameInputEl) return;
  flushPendingLeaderboardName();
  overlayLbNameInputEl.blur();
});
overlayLbNameInputEl?.addEventListener("blur", () => {
  if (pendingLeaderboardEntryTs == null || !overlayLbNameInputEl) return;
  flushPendingLeaderboardName();
});
document.getElementById("btn-title-instructions")?.addEventListener("click", () => showInstructionsSubmenu());
document.getElementById("btn-pause-instructions")?.addEventListener("click", () => showInstructionsSubmenu());
document.getElementById("btn-title-options")?.addEventListener("click", () => showOptionsSubmenu());
document.getElementById("btn-pause-options")?.addEventListener("click", () => showOptionsSubmenu());
document.getElementById("btn-instructions-back")?.addEventListener("click", () => exitMenuSubscreen());
document.getElementById("btn-options-back")?.addEventListener("click", () => exitMenuSubscreen());
document.getElementById("opt-show-checkpoints")?.addEventListener("change", (e) => {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  gameOptions.showCheckpointRings = on;
  try {
    localStorage.setItem(CHECKPOINT_RINGS_KEY, on ? "1" : "0");
  } catch (_) {}
});
document.getElementById("opt-force-mobile")?.addEventListener("change", (e) => {
  const on = /** @type {HTMLInputElement} */ (e.target).checked;
  gameOptions.forceMobileMode = on;
  try {
    localStorage.setItem(FORCE_MOBILE_MODE_KEY, on ? "1" : "0");
  } catch (_) {}
  syncForceMobileClass();
  syncTouchRaceHud();
  syncPortraitOrientationHint();
});
document
  .getElementById("btn-options-fullscreen")
  ?.addEventListener("click", () => toggleFullscreenGame());
document.getElementById("btn-title-exit")?.addEventListener("click", () => exitGame());
document.getElementById("btn-pause-main-menu")?.addEventListener("click", () => returnToMainMenuFromPause());
document.getElementById("btn-resume")?.addEventListener("click", () => resumeFromGameMenu());
document.getElementById("btn-restart-race")?.addEventListener("click", () => restartRaceFromMenu());

try {
  audio.ensureAudio();
  const ss = localStorage.getItem("aneRacingSfxVol");
  const sm = localStorage.getItem("aneRacingMusicVol");
  if (ss != null) {
    const v = parseFloat(ss);
    if (!Number.isNaN(v)) audio.setSfxVolume(v);
  }
  if (sm != null) {
    const v = parseFloat(sm);
    if (!Number.isNaN(v)) audio.setMusicVolume(v);
  }
  syncPauseSliderElements();
} catch (_) {}

document.addEventListener("fullscreenchange", () => void syncFullscreenButtonLabels());
if (window.electronShell?.onFullscreenChange) {
  window.electronShell.onFullscreenChange(() => void syncFullscreenButtonLabels());
}
void syncFullscreenButtonLabels();

populateLevelSelectList();
initPickups();
showTitleMenu();

document.getElementById("portrait-orient-hint-dismiss")?.addEventListener("click", () => {
  try {
    sessionStorage.setItem(PORTRAIT_HINT_DISMISS_KEY, "1");
  } catch (_) {}
  syncPortraitOrientationHint();
});
window.addEventListener("orientationchange", () => {
  requestAnimationFrame(() => syncPortraitOrientationHint());
});
window.addEventListener("resize", () => {
  requestAnimationFrame(() => syncPortraitOrientationHint());
});
requestAnimationFrame(() => syncPortraitOrientationHint());

let lastFrame = performance.now();

/** Rounded car silhouette (local space); does not fill. */
function carBodyPath(ctx, rx, ry, rw, rh, rr) {
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.lineTo(rx + rw - rr, ry);
  ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rr);
  ctx.lineTo(rx + rw, ry + rh - rr);
  ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
  ctx.lineTo(rx + rr, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rr);
  ctx.lineTo(rx, ry + rr);
  ctx.quadraticCurveTo(rx, ry, rx + rr, ry);
  ctx.closePath();
}

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

  // Track fill (true road union — same silhouette as wall collision)
  const ro = roadOutlineForTrack(track);
  ctx.beginPath();
  appendRoadOutlineToCanvasPath(ctx, ro);
  const grd = ctx.createLinearGradient(-1200, -800, 1200, 800);
  grd.addColorStop(0, "#2d333f");
  grd.addColorStop(1, "#1e222b");
  ctx.fillStyle = grd;
  ctx.fill("evenodd");

  // Edge lines (outer + hole perimeters)
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 3 / z;
  ctx.lineJoin = "round";
  strokeRoadOutlineBoundaries(ctx, ro);

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

  // Kerbs (every 4th outer segment) — skip near checkpoints so rumble doesn't read as a barrier
  const outerEdge = ro.outer;
  const nEdge = outerEdge.length;
  const cps = track.checkpoints || [];
  for (let i = 0; i < nEdge; i += 4) {
    const j = (i + 1) % nEdge;
    const o0 = outerEdge[i];
    const o1 = outerEdge[j];
    let nearCp = false;
    for (const cp of cps) {
      if (
        distPointSegment(cp.x, cp.y, o0.x, o0.y, o1.x, o1.y) <
        cp.r + track.width * 0.55
      ) {
        nearCp = true;
        break;
      }
    }
    if (nearCp) continue;
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
  const cpsGate = track.checkpoints || [];
  const needSfToCompleteLap =
    state.mode === "race" &&
    cpsGate.length > 0 &&
    player.nextCheckpointIndex >= cpsGate.length;

  ctx.strokeStyle = "#fff59d";
  ctx.lineWidth = 5 / z;
  ctx.beginPath();
  ctx.moveTo(fl.a.x, fl.a.y);
  ctx.lineTo(fl.b.x, fl.b.y);
  ctx.stroke();
  if (needSfToCompleteLap) {
    ctx.strokeStyle = "rgba(255, 213, 79, 0.92)";
    ctx.lineWidth = 8 / z;
    ctx.setLineDash([12 / z, 8 / z]);
    ctx.beginPath();
    ctx.moveTo(fl.a.x, fl.a.y);
    ctx.lineTo(fl.b.x, fl.b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "rgba(255,245,157,0.35)";
  ctx.font = `${14 / z}px Orbitron,sans-serif`;
  ctx.save();
  ctx.translate((fl.a.x + fl.b.x) / 2, (fl.a.y + fl.b.y) / 2);
  ctx.rotate(Math.atan2(fl.tangent.y, fl.tangent.x));
  ctx.fillText("S/F", -12 / z, -8 / z);
  ctx.restore();

  // Checkpoint drivethrough disks (must cross in order — skipping a disk means S/F won’t count a lap)
  const cpsDraw = cpsGate;
  if (gameOptions.showCheckpointRings && cpsDraw.length > 0) {
    const inRace = state.mode === "race";
    const nextIdx = inRace ? player.nextCheckpointIndex : -1;
    for (let i = 0; i < cpsDraw.length; i++) {
      const cp = cpsDraw[i];
      const passed = inRace && i < nextIdx;
      const isNext = inRace && i === nextIdx;
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, cp.r, 0, TAU);
      if (passed) {
        ctx.strokeStyle = "rgba(129, 199, 132, 0.88)";
        ctx.fillStyle = "rgba(129, 199, 132, 0.1)";
      } else if (isNext) {
        ctx.strokeStyle = "rgba(77, 208, 225, 0.95)";
        ctx.fillStyle = "rgba(77, 208, 225, 0.16)";
      } else {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
        ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      }
      ctx.lineWidth = (isNext ? 3.5 : 2.2) / z;
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.fillStyle = isNext
        ? "rgba(200, 245, 255, 0.95)"
        : passed
          ? "rgba(200, 230, 200, 0.75)"
          : "rgba(255, 255, 255, 0.5)";
      ctx.font = `${13 / z}px Orbitron,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), cp.x, cp.y);
      ctx.restore();
    }
  }

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
    grd.addColorStop(1, armed ? hexDarken(col, 0.45) : hexDarken(col, 0.7));
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.strokeStyle = armed ? col : "rgba(255,255,255,0.35)";
    ctx.globalAlpha = armed ? 0.92 : 0.55;
    ctx.lineWidth = 2.2 / z;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (armed) {
      const pulse = 0.35 + Math.sin(performance.now() * 0.012) * 0.25;
      ctx.strokeStyle = col;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(0, 0, ro + 5, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
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

  // Cars
  for (const car of cars) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    ctx.shadowColor = car.color;
    ctx.shadowBlur = 12 / z;

    const rx = -16;
    const ry = -8;
    const rw = 32;
    const rh = 16;
    const rr = 3;
    const hullFrac = car.wrecked ? 0 : car.hp / car.maxHp;

    ctx.fillStyle = car.isPlayer ? "#000000" : "#111111";
    ctx.fillRect(-18, -10, 36, 20);

    const h = clamp(hullFrac, 0, 1);
    if (h > 0.003) {
      ctx.save();
      ctx.beginPath();
      /* Hull infill: rear (−x) → front (+x), like a bar along the car */
      ctx.rect(rx - 0.5, ry - 0.5, rw * h + 0.5, rh + 1);
      ctx.clip();
      carBodyPath(ctx, rx, ry, rw, rh, rr);
      ctx.fillStyle = car.color;
      ctx.fill();
      ctx.restore();
    }

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
  ctx.shadowBlur = 0;

  // Player: compact shield / boost timers under car (world space)
  if (state.mode === "race" || state.mode === "finished") {
    const pl = player;
    if (!pl.wrecked && (pl.shieldT > 0 || pl.boostT > 0)) {
      const fs = Math.max(8 / z, 7);
      const lineGap = (fs + 3) / z;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      let y = pl.y + CAR_R + 5 / z;
      ctx.font = `700 ${fs}px Orbitron,sans-serif`;
      if (pl.shieldT > 0) {
        const label = `S ${pl.shieldT.toFixed(1)}s`;
        ctx.fillStyle = "rgba(8,10,18,0.82)";
        const w = Math.max(ctx.measureText(label).width + 8 / z, 52 / z);
        roundRect(ctx, pl.x - w / 2, y - 1 / z, w, fs + 5 / z, 4 / z);
        ctx.fill();
        ctx.fillStyle = "#c5ceff";
        ctx.fillText(label, pl.x, y);
        y += lineGap;
      }
      if (pl.boostT > 0) {
        const label = `B ${pl.boostT.toFixed(1)}s`;
        ctx.fillStyle = "rgba(8,10,18,0.82)";
        const w = Math.max(ctx.measureText(label).width + 8 / z, 52 / z);
        roundRect(ctx, pl.x - w / 2, y - 1 / z, w, fs + 5 / z, 4 / z);
        ctx.fill();
        ctx.fillStyle = "#ffd699";
        ctx.fillText(label, pl.x, y);
      }
    }
  }

  ctx.restore();
}

/** Rounded rect fill (current fillStyle). */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  refreshMergedKeys();

  if (state.mode === "race" && !state.paused) {
    const nowSec = now / 1000;

    for (const car of cars) {
      updateCarCombatTimers(car, dt);
    }
    for (const car of cars) {
      updateCar(car, dt, mergedKeys);
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

    const cps = track.checkpoints || [];
    accumulateCheckpointsForCars(cars, cps);

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      checkCarLap(c, { x: c.prevX, y: c.prevY }, { x: c.x, y: c.y });
    }

    // After S/F may reset index K→0 in the same frame; run CP logic again so lap 2+ can start at CP1 immediately.
    accumulateCheckpointsForCars(cars, cps);
    for (const car of cars) {
      car.prevX = car.x;
      car.prevY = car.y;
    }
    state.prevPos.x = player.x;
    state.prevPos.y = player.y;

    const t = now / 1000;
    state.currentLapTime = t - state.lapStartTime;
    if (state.mode === "race") {
      state.raceElapsedSec += dt;
    }
    updateHud();
  } else if (state.mode === "race" && state.paused) {
    updateHud();
  } else if (state.mode === "countdown") {
    updateHud();
  } else {
    for (const car of cars) {
      updateCar(car, dt, mergedKeys);
    }
    updateParticles(dt);
    updateHud();
  }

  const musicInMenu =
    state.menuOpen &&
    (state.menuContext === "title" ||
      state.menuContext === "race" ||
      state.menuContext === "countdown");
  const musicInRace = state.mode === "race" && !state.paused;
  if (musicInMenu || musicInRace) {
    try {
      audio.updateMusic(dt);
    } catch (_) {}
  }

  // Camera follow player
  state.camera.x = lerp(state.camera.x, player.x, 1 - Math.pow(0.002, dt));
  state.camera.y = lerp(state.camera.y, player.y, 1 - Math.pow(0.002, dt));
  state.camera.zoom = lerp(state.camera.zoom, 1, dt * 3);

  ctx.fillStyle = "#0d1018";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawWorld();
  /* Subtle dim when the race is paused or the race/countdown menu is open */
  const menuDimCanvas =
    (state.mode === "race" && state.paused) ||
    (state.menuOpen &&
      (state.menuContext === "race" || state.menuContext === "countdown"));
  if (menuDimCanvas) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgba(5, 8, 14, 0.22)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  requestAnimationFrame(frame);
}

syncOptionsUi();
updateHud();
requestAnimationFrame(frame);
