/**
 * Track layout from a closed control polygon (piecewise-linear centerline).
 *
 * Road = { points whose distance to the center polyline ≤ half width } — a “metaball” union along segments.
 * Boundaries come from a distance field + marching squares (iso at half-width), so overlaps (cross, figure-8) and
 * sharp sparse corners behave without folded parallel offsets.
 */

export const DEFAULT_SUBDIV = 40;
export const FIXED_EDGE_SUBDIV = 40;
export const TRACK_WIDTH = 162;

function hypotXY(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function polygonSignedArea(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a * 0.5;
}

/** Point-in-polygon (non-zero, works for both canvas y-up and y-down winding). */
export function pointInPolygon(px, py, ring) {
  let c = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-30) + xi) {
      c = !c;
    }
  }
  return c;
}

function ringCentroid(ring) {
  let sx = 0;
  let sy = 0;
  for (const p of ring) {
    sx += p.x;
    sy += p.y;
  }
  const n = ring.length || 1;
  return { x: sx / n, y: sy / n };
}

/**
 * Samples only along control edges (sharp corners stay sharp in the center polyline; thickness is unioned later).
 */
function densifyClosedPolygon(control, targetSegLen, maxSegPerEdge) {
  const n = control.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = control[i];
    const b = control[(i + 1) % n];
    const len = hypotXY(b.x - a.x, b.y - a.y);
    let ss = Math.max(1, Math.min(maxSegPerEdge, Math.ceil(len / targetSegLen)));
    const tiny = len < targetSegLen * 0.65 && ss > 1;
    if (tiny) ss = 1;
    out.push({ x: a.x, y: a.y });
    for (let s = 1; s < ss; s++) {
      const t = s / ss;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function rotateClosedPolyline(pts, k) {
  const n = pts.length;
  if (n === 0) return pts;
  k = ((k % n) + n) % n;
  if (k === 0) return pts.slice();
  return [...pts.slice(k), ...pts.slice(0, k)];
}

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

function ringPerimeter(pts) {
  const n = pts.length;
  if (n < 2) return 0;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    L += hypotXY(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return L;
}

function pointOnClosedRing(pts, dist) {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  const total = ringPerimeter(pts);
  if (total < 1e-9) return { x: pts[0].x, y: pts[0].y };
  let u = ((dist % total) + total) % total;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const sx = pts[j].x - pts[i].x;
    const sy = pts[j].y - pts[i].y;
    const len = hypotXY(sx, sy);
    if (acc + len >= u - 1e-9) {
      const t = len > 1e-12 ? (u - acc) / len : 0;
      return { x: pts[i].x + sx * t, y: pts[i].y + sy * t };
    }
    acc += len;
  }
  return { x: pts[0].x, y: pts[0].y };
}

function resampleClosedRing(pts, count) {
  if (pts.length < 3 || count < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const total = ringPerimeter(pts);
  if (total < 1e-9) return pts.slice(0, count);
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push(pointOnClosedRing(pts, (k / count) * total));
  }
  return out;
}

/** Distance from point to every segment of a closed polyline. */
function minDistToClosedPolyline(px, py, pts) {
  const n = pts.length;
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d = Math.min(d, distPointSegment(px, py, pts[i].x, pts[i].y, pts[j].x, pts[j].y));
  }
  return d;
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

function lerp2(ax, ay, bx, by, t) {
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
}

function edgeCross(ax, ay, fa, bx, by, fb, level) {
  const den = fa - fb;
  if (Math.abs(den) < 1e-14) return { x: (ax + bx) * 0.5, y: (ay + by) * 0.5 };
  const t = (fa - level) / den;
  return lerp2(ax, ay, bx, by, clamp(t, 0, 1));
}

/**
 * One iso crossing per grid edge (shared by two adjacent marching-squares cells).
 * Without this, the same geometric point is interpolated twice with tiny float drift and stitching splits contours.
 */
function precomputeGridEdgeIsoPoints(val, nx, ny, ox, oy, cellW, cellH, level) {
  const inside = (fv) => fv <= level;
  const nH = (nx - 1) * ny;
  const nV = nx * (ny - 1);
  const horiz = new Array(nH);
  const vert = new Array(nV);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const fa = val[j * nx + i];
      const fb = val[j * nx + i + 1];
      const ha = inside(fa);
      const hb = inside(fb);
      let p = null;
      if (ha !== hb) {
        p = edgeCross(ox + i * cellW, oy + j * cellH, fa, ox + (i + 1) * cellW, oy + j * cellH, fb, level);
      }
      horiz[j * (nx - 1) + i] = p;
    }
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx; i++) {
      const fa = val[j * nx + i];
      const fb = val[(j + 1) * nx + i];
      const ha = inside(fa);
      const hb = inside(fb);
      let p = null;
      if (ha !== hb) {
        p = edgeCross(ox + i * cellW, oy + j * cellH, fa, ox + i * cellW, oy + (j + 1) * cellH, fb, level);
      }
      vert[i * (ny - 1) + j] = p;
    }
  }
  return { horiz, vert };
}

function contoursMarchingSquares(val, nx, ny, ox, oy, cellW, cellH, level, cellCenterVal) {
  const segs = [];
  const inside = (x) => x <= level;
  const { horiz, vert } = precomputeGridEdgeIsoPoints(val, nx, ny, ox, oy, cellW, cellH, level);

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const ii = j * nx + i;
      const v0 = val[ii];
      const v1 = val[ii + 1];
      const v2 = val[ii + 1 + nx];
      const v3 = val[ii + nx];

      const b0 = inside(v0) ? 1 : 0;
      const b1 = inside(v1) ? 2 : 0;
      const b2 = inside(v2) ? 4 : 0;
      const b3 = inside(v3) ? 8 : 0;
      const idx = b0 | b1 | b2 | b3;
      if (idx === 0 || idx === 15) continue;

      const pB = horiz[j * (nx - 1) + i];
      const pR = vert[(i + 1) * (ny - 1) + j];
      const pT = horiz[(j + 1) * (nx - 1) + i];
      const pL = vert[i * (ny - 1) + j];

      function pushSeg(a, b) {
        if (!a || !b) return;
        // Reuse {x,y} from grid-edge cache so shared vertices are identical by reference for stitching.
        segs.push({ a, b });
      }

      const vMid =
        cellCenterVal != null
          ? cellCenterVal[j * (nx - 1) + i]
          : (v0 + v1 + v2 + v3) * 0.25;
      /* Corners v0..v3 = BL, BR, TR, TL. Only emit segments along edges that actually cross the iso. */
      switch (idx) {
        case 1:
          pushSeg(pL, pB);
          break;
        case 2:
          pushSeg(pB, pR);
          break;
        case 3:
          pushSeg(pL, pR);
          break;
        case 4:
          pushSeg(pR, pT);
          break;
        case 5:
          if (inside(vMid)) {
            pushSeg(pL, pB);
            pushSeg(pT, pR);
          } else {
            pushSeg(pL, pT);
            pushSeg(pB, pR);
          }
          break;
        case 6:
          pushSeg(pB, pT);
          break;
        case 7:
          pushSeg(pL, pT);
          break;
        case 8:
          pushSeg(pT, pL);
          break;
        case 9:
          pushSeg(pB, pT);
          break;
        case 10:
          if (inside(vMid)) {
            pushSeg(pT, pR);
            pushSeg(pL, pB);
          } else {
            pushSeg(pL, pT);
            pushSeg(pB, pR);
          }
          break;
        case 11:
          pushSeg(pR, pT);
          break;
        case 12:
          pushSeg(pL, pR);
          break;
        case 13:
          pushSeg(pB, pR);
          break;
        case 14:
          pushSeg(pL, pB);
          break;
        default:
          break;
      }
    }
  }

  return segs;
}

function pointIdFactory() {
  const pid = new WeakMap();
  let n = 0;
  return function id(p) {
    if (!pid.has(p)) pid.set(p, n++);
    return pid.get(p);
  };
}

/** Coalesce {x,y} objects that are bitwise-equal but distinct instances (e.g. cell corner from H vs V edge). */
function weldSegmentEndpointsByCoordinate(segs) {
  const pool = new Map();
  function weld(p) {
    const k = `${p.x},${p.y}`;
    let q = pool.get(k);
    if (!q) {
      q = { x: p.x, y: p.y };
      pool.set(k, q);
    }
    return q;
  }
  for (const s of segs) {
    s.a = weld(s.a);
    s.b = weld(s.b);
  }
}

function dedupeUndirectedPointSegments(segs) {
  const id = pointIdFactory();
  function undirectedId(a, b) {
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? `${ia}::${ib}` : `${ib}::${ia}`;
  }
  const seenSeg = new Set();
  const uniq = [];
  for (const s of segs) {
    const uid = undirectedId(s.a, s.b);
    if (seenSeg.has(uid)) continue;
    seenSeg.add(uid);
    uniq.push(s);
  }
  return { uniq, id, undirectedId };
}

/** Number of connected components in the undirected segment graph (before stitching). */
function countSegmentGraphComponents(segs) {
  const { uniq, id } = dedupeUndirectedPointSegments(segs);
  const nNodes =
    uniq.length === 0
      ? 0
      : Math.max(...uniq.flatMap((s) => [id(s.a), id(s.b)])) + 1;
  const parent = [];
  function find(a) {
    if (parent[a] === undefined) parent[a] = a;
    let p = a;
    while (parent[p] !== p) p = parent[p];
    while (parent[a] !== p) {
      const t = parent[a];
      parent[a] = p;
      a = t;
    }
    return p;
  }
  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  }
  for (const s of uniq) {
    union(id(s.a), id(s.b));
  }
  const roots = new Set();
  for (let i = 0; i < nNodes; i++) roots.add(find(i));
  return roots.size;
}

/** Sorted list of edge counts per connected component (for diagnostics). */
function segmentComponentSizes(segs) {
  const { uniq, id } = dedupeUndirectedPointSegments(segs);
  const nNodes =
    uniq.length === 0
      ? 0
      : Math.max(...uniq.flatMap((s) => [id(s.a), id(s.b)])) + 1;
  const parent = [];
  function find(a) {
    if (parent[a] === undefined) parent[a] = a;
    let p = a;
    while (parent[p] !== p) p = parent[p];
    while (parent[a] !== p) {
      const t = parent[a];
      parent[a] = p;
      a = t;
    }
    return p;
  }
  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  }
  for (const s of uniq) {
    union(id(s.a), id(s.b));
  }
  const size = new Map();
  for (const s of uniq) {
    const r = find(id(s.a));
    size.set(r, (size.get(r) || 0) + 1);
  }
  return [...size.values()].sort((a, b) => b - a);
}

function stitchSegmentsToPolygons(segs) {
  const { uniq, undirectedId } = dedupeUndirectedPointSegments(segs);

  const adj = new Map();
  for (const s of uniq) {
    const a = s.a;
    const b = s.b;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ k: b, x: b.x, y: b.y });
    adj.get(b).push({ k: a, x: a.x, y: a.y });
  }

  const usedEdge = new Set();
  const polys = [];

  for (const s of uniq) {
    const k0 = s.a;
    const k1 = s.b;
    const id01 = undirectedId(k0, k1);
    if (usedEdge.has(id01)) continue;

    const poly = [];
    let prevK = k0;
    let curK = k1;
    poly.push({ x: k0.x, y: k0.y }, { x: k1.x, y: k1.y });
    usedEdge.add(id01);

    let guard = 0;
    while (guard++ < 500000) {
      if (curK === k0 && poly.length >= 3) break;
      const outs = adj.get(curK) || [];
      let next = null;
      for (const o of outs) {
        if (o.k === prevK) continue;
        const eid = undirectedId(curK, o.k);
        if (usedEdge.has(eid)) continue;
        next = o;
        break;
      }
      if (!next) break;
      usedEdge.add(undirectedId(curK, next.k));
      prevK = curK;
      curK = next.k;
      poly.push({ x: next.x, y: next.y });
    }
    if (poly.length >= 4) {
      polys.push(poly);
    }
  }
  return polys;
}

function sampleDistanceGrid(center, hw, cellScale) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of center) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = hw * 3 + 40;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const W = maxX - minX;
  const H = maxY - minY;
  const base = Math.max(hw * 0.16, Math.min(W, H) / 420);
  const targetCell = base * cellScale;
  let nx = Math.floor(W / targetCell) + 1;
  let ny = Math.floor(H / targetCell) + 1;
  nx = clamp(nx, 80, 380);
  ny = clamp(ny, 80, 380);
  const cellW = W / (nx - 1);
  const cellH = H / (ny - 1);

  const val = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const wx = minX + i * cellW;
      const wy = minY + j * cellH;
      val[j * nx + i] = minDistToClosedPolyline(wx, wy, center) - hw;
    }
  }

  const ncx = nx - 1;
  const ncy = ny - 1;
  const cellCenterVal = new Float64Array(ncx * ncy);
  for (let j = 0; j < ncy; j++) {
    for (let i = 0; i < ncx; i++) {
      const cx = minX + i * cellW + cellW * 0.5;
      const cy = minY + j * cellH + cellH * 0.5;
      cellCenterVal[j * ncx + i] = minDistToClosedPolyline(cx, cy, center) - hw;
    }
  }

  return { val, nx, ny, minX, minY, cellW, cellH, cellCenterVal };
}

function extractContoursLoop(center, hw, cellScale) {
  const { val, nx, ny, minX, minY, cellW, cellH, cellCenterVal } = sampleDistanceGrid(center, hw, cellScale);
  const segs = contoursMarchingSquares(val, nx, ny, minX, minY, cellW, cellH, 0, cellCenterVal);
  weldSegmentEndpointsByCoordinate(segs);
  return stitchSegmentsToPolygons(segs);
}

function ensureCCW(ring) {
  const a = polygonSignedArea(ring);
  if (a < 0) return ring.map((p) => ({ x: p.x, y: p.y })).reverse();
  return ring.map((p) => ({ x: p.x, y: p.y }));
}

function ensureCW(ring) {
  const a = polygonSignedArea(ring);
  if (a > 0) return ring.map((p) => ({ x: p.x, y: p.y })).reverse();
  return ring.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Largest |area| loop that contains ref is the road’s outer boundary; other loops inside that ring are holes (grass).
 */
function classifyRoadRings(loops, ref) {
  if (loops.length === 0) {
    return { outer: [], holes: [] };
  }
  const oriented = loops.map((L) => ensureCCW(L));
  const withRef = oriented.filter((L) => pointInPolygon(ref.x, ref.y, L));
  let outer;
  if (withRef.length > 0) {
    outer = withRef.reduce((best, L) =>
      Math.abs(polygonSignedArea(L)) > Math.abs(polygonSignedArea(best)) ? L : best
    );
  } else {
    outer = oriented.reduce((best, L) =>
      Math.abs(polygonSignedArea(L)) > Math.abs(polygonSignedArea(best)) ? L : best
    );
  }

  const holesRaw = oriented.filter((L) => {
    if (L === outer) return false;
    const c = ringCentroid(L);
    return pointInPolygon(c.x, c.y, outer);
  });

  const holes = holesRaw.map((h) => ensureCW(h));
  return { outer: ensureCCW(outer), holes };
}

function ringsToWallSegments(outer, holes) {
  const wallSegments = [];
  function addRing(ring, inner) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      wallSegments.push({ a: ring[i], b: ring[j], inner });
    }
  }
  if (outer.length >= 3) addRing(outer, false);
  for (const h of holes) {
    if (h.length >= 3) addRing(h, true);
  }
  return wallSegments;
}

/** When there is no interior hole loop (single-contour road), approximate an “inner” ribbon for dashed line / legacy draw. */
function pseudoInnerFromCenter(center, hw, insideHint) {
  const n = center.length;
  const out = [];
  const t0 = tangentDir(center, 0, n);
  const refX = insideHint.x - center[0].x;
  const refY = insideHint.y - center[0].y;
  let flip = -t0.y * refX + t0.x * refY < 0;
  for (let i = 0; i < n; i++) {
    const t = tangentDir(center, i, n);
    let nx = -t.y;
    let ny = t.x;
    if (flip) {
      nx = -nx;
      ny = -ny;
    }
    out.push({ x: center[i].x + nx * hw * 0.92, y: center[i].y + ny * hw * 0.92 });
  }
  return out;
}

function tangentDir(center, i, n) {
  const p0 = center[(i - 1 + n) % n];
  const p2 = center[(i + 1) % n];
  let tx = p2.x - p0.x;
  let ty = p2.y - p0.y;
  const len = hypotXY(tx, ty) || 1;
  return { x: tx / len, y: ty / len };
}

/* ——— Fallback: round-join strip if distance field fails (should be rare) ——— */

function edgeNormalsForRing(pts, outward) {
  const n = pts.length;
  const normals = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j].x - pts[i].x;
    const dy = pts[j].y - pts[i].y;
    const len = hypotXY(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (!outward) {
      nx = -nx;
      ny = -ny;
    }
    normals.push({ x: nx, y: ny });
  }
  return normals;
}

function outerEdgeIsLeftOfPath(pts) {
  const n = pts.length;
  if (n < 2) return true;
  const t0 = tangentDir(pts, 0, n);
  const left = { x: -t0.y, y: t0.x };
  const t1 = tangentDir(pts, 1, n);
  return left.x * (-t1.y) + left.y * t1.x > 0;
}

const RJ_STEP = 0.085;

function buildRoundJoinOffsetRing(pts, w, outward) {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const edgeN = edgeNormalsForRing(pts, outward);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nPrev = edgeN[(i - 1 + n) % n];
    const nCurr = edgeN[i];
    const a0 = Math.atan2(nPrev.y, nPrev.x);
    const a1 = Math.atan2(nCurr.y, nCurr.x);
    let sweep = a1 - a0;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / RJ_STEP));
    for (let s = out.length === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const ang = a0 + sweep * t;
      out.push({ x: p.x + w * Math.cos(ang), y: p.y + w * Math.sin(ang) });
    }
    const j = (i + 1) % n;
    const pN = pts[j];
    out.push({ x: pN.x + nCurr.x * w, y: pN.y + nCurr.y * w });
  }
  return out;
}

function fallbackRoundJoinRings(center, hw) {
  const outerLeft = outerEdgeIsLeftOfPath(center);
  return {
    outer: buildRoundJoinOffsetRing(center, hw, outerLeft),
    holes: [buildRoundJoinOffsetRing(center, hw, !outerLeft)],
  };
}

/**
 * @param {{x:number,y:number}[]} control closed control polygon (≥4 points)
 * @param {{ trackWidth?: number }} [opts]
 */
export function buildTrackLayout(control, opts = {}) {
  const width = opts.trackWidth != null ? opts.trackWidth : TRACK_WIDTH;
  const hw = width * 0.5;
  const targetSegLen = Math.max(14, hw * 0.2);
  const maxSeg = Math.max(FIXED_EDGE_SUBDIV + 12, 72);
  const raw = densifyClosedPolygon(control, targetSegLen, maxSeg);
  const rot = findLongestEdgeStartIndex(raw);
  const center = rotateClosedPolyline(raw, rot);
  const n = center.length;
  const insideHint = ringCentroid(control);

  let loops = [];
  for (const scale of [1, 0.52, 0.28]) {
    loops = extractContoursLoop(center, hw, scale);
    if (loops.length > 0) break;
  }

  let roadOutline;
  if (loops.length === 0) {
    const fb = fallbackRoundJoinRings(center, hw);
    roadOutline = { outer: fb.outer, holes: fb.holes.filter((h) => h.length >= 4) };
  } else {
    const ref = center[0];
    roadOutline = classifyRoadRings(loops, ref);
    if (roadOutline.outer.length < 6) {
      const fb = fallbackRoundJoinRings(center, hw);
      roadOutline = { outer: fb.outer, holes: fb.holes.filter((h) => h.length >= 4) };
    }
  }

  let { outer: outlineOuter, holes: outlineHoles } = roadOutline;

  const wallSegments = ringsToWallSegments(outlineOuter, outlineHoles);

  const outer = resampleClosedRing(outlineOuter, n);
  let inner;
  if (outlineHoles.length > 0) {
    inner = resampleClosedRing(outlineHoles[0], n);
  } else {
    inner = pseudoInnerFromCenter(center, hw, insideHint);
  }

  const t0 = tangentDir(center, 0, n);
  let snx = -t0.y;
  let sny = t0.x;
  const c0 = center[0];
  const fw = hw * 1.12;
  const finishLine = {
    a: { x: c0.x + snx * fw, y: c0.y + sny * fw },
    b: { x: c0.x - snx * fw, y: c0.y - sny * fw },
    tangent: { x: t0.x, y: t0.y },
  };

  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    acc += hypotXY(center[j].x - center[i].x, center[j].y - center[i].y);
  }
  const length = acc;

  const checkpoints = checkpointsFromControlPolygon(control, center, width);

  return {
    center,
    inner,
    outer,
    roadOutline: { outer: outlineOuter, holes: outlineHoles },
    n,
    width,
    wallSegments,
    finishLine,
    checkpoints,
    length,
  };
}

/** Closest point on a closed polyline and arc length from `pts[0]` along forward traversal. */
function closestPointOnClosedPolyline(px, py, pts) {
  const n = pts.length;
  if (n < 2) return { x: px, y: py, s: 0 };
  let bestD = Infinity;
  let best = { x: pts[0].x, y: pts[0].y, s: 0 };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i].x;
    const ay = pts[i].y;
    const bx = pts[j].x;
    const by = pts[j].y;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2) || 1;
    let t = len2 > 1e-20 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d = hypotXY(px - qx, py - qy);
    if (d < bestD) {
      let acc = 0;
      for (let k = 0; k < i; k++) {
        const p0 = pts[k];
        const p1 = pts[(k + 1) % n];
        acc += hypotXY(p1.x - p0.x, p1.y - p0.y);
      }
      const s = acc + t * len;
      bestD = d;
      best = { x: qx, y: qy, s };
    }
  }
  return best;
}

/**
 * One drivethrough disk per control vertex, projected onto the smoothed centerline, in track order.
 */
function checkpointsFromControlPolygon(control, center, width) {
  const r = width * 1.2;
  const scored = [];
  const seen = new Set();
  for (const p of control) {
    const hit = closestPointOnClosedPolyline(p.x, p.y, center);
    const key = `${Math.round(hit.x * 4)},${Math.round(hit.y * 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ x: hit.x, y: hit.y, s: hit.s });
  }
  scored.sort((a, b) => a.s - b.s);
  if (scored.length === 0) {
    return [{ x: center[0].x, y: center[0].y, r }];
  }
  return scored.map(({ x, y }) => ({ x, y, r }));
}

/** Axis-aligned bounds of `roadOutline` (outer + holes), for gradients / view fitting. */
export function boundsRoadOutline(roadOutline) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  function visit(ring) {
    if (!ring) return;
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!roadOutline?.outer) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  visit(roadOutline.outer);
  for (const h of roadOutline.holes || []) visit(h);
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return { minX, minY, maxX, maxY };
}

function appendClosedRingToCanvasPath(ctx, ring) {
  if (!ring || ring.length < 3) return;
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i <= ring.length; i++) {
    const p = ring[i % ring.length];
    ctx.lineTo(p.x, p.y);
  }
}

/**
 * Append outer ring then each hole as separate subpaths. Caller should `beginPath()` first; use `fill("evenodd")`.
 * Correct for self-overlapping tracks (e.g. figure-8) — unlike resampled inner/outer ribbons.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ outer: {x:number,y:number}[], holes?: {x:number,y:number}[][] }} roadOutline
 */
export function appendRoadOutlineToCanvasPath(ctx, roadOutline) {
  if (!roadOutline?.outer || roadOutline.outer.length < 3) return;
  appendClosedRingToCanvasPath(ctx, roadOutline.outer);
  for (const h of roadOutline.holes || []) {
    appendClosedRingToCanvasPath(ctx, h);
  }
}

/**
 * Stroke each boundary ring separately (outer + hole perimeters).
 * @param {CanvasRenderingContext2D} ctx
 */
export function strokeRoadOutlineBoundaries(ctx, roadOutline) {
  if (!roadOutline?.outer || roadOutline.outer.length < 3) return;
  function strokeRing(ring) {
    if (!ring || ring.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i <= ring.length; i++) {
      const p = ring[i % ring.length];
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  strokeRing(roadOutline.outer);
  for (const h of roadOutline.holes || []) strokeRing(h);
}

/** For diagnostics: raw segment count vs stitched polygons (marching squares + stitch). */
export function debugMarchingSquareStats(control, opts = {}) {
  const width = opts.trackWidth != null ? opts.trackWidth : TRACK_WIDTH;
  const hw = width * 0.5;
  const targetSegLen = Math.max(14, hw * 0.2);
  const maxSeg = Math.max(FIXED_EDGE_SUBDIV + 12, 72);
  const raw = densifyClosedPolygon(control, targetSegLen, maxSeg);
  const rot = findLongestEdgeStartIndex(raw);
  const center = rotateClosedPolyline(raw, rot);
  const { val, nx, ny, minX, minY, cellW, cellH, cellCenterVal } = sampleDistanceGrid(center, hw, 1);
  const segs = contoursMarchingSquares(val, nx, ny, minX, minY, cellW, cellH, 0, cellCenterVal);
  weldSegmentEndpointsByCoordinate(segs);
  const polys = stitchSegmentsToPolygons(segs);
  const { uniq } = dedupeUndirectedPointSegments(segs);
  return {
    nSeg: segs.length,
    nSegUniq: uniq.length,
    segmentComponents: countSegmentGraphComponents(segs),
    segmentSizes: segmentComponentSizes(segs),
    nPoly: polys.length,
    polyLens: polys.map((p) => p.length),
    nx,
    ny,
  };
}
