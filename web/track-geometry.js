/**
 * Shared Catmull–Rom track layout (centerline + offsets). Used by the game Track and the editor preview.
 */

export const DEFAULT_SUBDIV = 14;
export const TRACK_WIDTH = 162;

function hypotXY(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
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

/** Index of the vertex at the start of the longest edge. */
function findLongestEdgeStartIndex(center) {
  const n = center.length;
  let bestI = 0;
  let bestLen = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = hypotXY(center[j].x - center[i].x, center[j].y - center[i].y);
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  return bestI;
}

/** Distance from point (px,py) to segment a–b */
export function distPointSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 0 ? (apx * abx + apy * aby) / ab2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return hypotXY(px - qx, py - qy);
}

/**
 * @param {{x:number,y:number}[]} control closed control polygon (≥4 points)
 * @param {{ subdiv?: number, trackWidth?: number }} [opts]
 */
export function buildTrackLayout(control, opts = {}) {
  const subdiv = opts.subdiv != null ? opts.subdiv : DEFAULT_SUBDIV;
  const raw = buildClosedSpline(control, subdiv);
  const rot = findLongestEdgeStartIndex(raw);
  const center = rotateClosedPolyline(raw, rot);
  const n = center.length;
  const width = opts.trackWidth != null ? opts.trackWidth : TRACK_WIDTH;
  const inner = [];
  const outer = [];
  const wallSegments = [];

  for (let i = 0; i < n; i++) {
    const p0 = center[(i - 1 + n) % n];
    const p1 = center[i];
    const p2 = center[(i + 1) % n];
    let tx = p2.x - p0.x;
    let ty = p2.y - p0.y;
    const len = hypotXY(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    const hw = width * 0.5;
    outer.push({ x: p1.x + nx * hw, y: p1.y + ny * hw });
    inner.push({ x: p1.x - nx * hw, y: p1.y - ny * hw });
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    wallSegments.push(
      { a: outer[i], b: outer[j], inner: false },
      { a: inner[i], b: inner[j], inner: true }
    );
  }

  const t0 = tangentDir(center, 0, n);
  let snx = -t0.y;
  let sny = t0.x;
  const hw = width * 0.5;
  const c0 = center[0];
  const fw = hw * 1.12;
  const finishLine = {
    a: { x: c0.x + snx * fw, y: c0.y + sny * fw },
    b: { x: c0.x - snx * fw, y: c0.y - sny * fw },
    tangent: { x: t0.x, y: t0.y },
  };

  const cumLen = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    cumLen.push(acc);
    const j = (i + 1) % n;
    acc += hypotXY(center[j].x - center[i].x, center[j].y - center[i].y);
  }
  const length = acc;
  const L = length;
  const lo = L * 0.38;
  const hi = L * 0.62;
  let bestMidI = Math.floor(n * 0.5) % n;
  let bestClear = -1;
  for (let i = 0; i < n; i++) {
    const s = cumLen[i];
    if (s < lo || s > hi) continue;
    const px = center[i].x;
    const py = center[i].y;
    let dmin = Infinity;
    for (const seg of wallSegments) {
      dmin = Math.min(dmin, distPointSegment(px, py, seg.a.x, seg.a.y, seg.b.x, seg.b.y));
    }
    if (dmin > bestClear) {
      bestClear = dmin;
      bestMidI = i;
    }
  }

  const midCheckpoint = {
    x: center[bestMidI].x,
    y: center[bestMidI].y,
    r: width * 1.2,
  };

  return {
    center,
    inner,
    outer,
    n,
    width,
    wallSegments,
    finishLine,
    midCheckpoint,
    length,
  };
}

function tangentDir(center, i, n) {
  const p0 = center[(i - 1 + n) % n];
  const p2 = center[(i + 1) % n];
  let tx = p2.x - p0.x;
  let ty = p2.y - p0.y;
  const len = hypotXY(tx, ty) || 1;
  return { x: tx / len, y: ty / len };
}
