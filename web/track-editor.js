/**
 * Interactive track editor: place points or sketch a loop, save/export compatible with game Track.
 */

import { exportTrackJson, downloadBlob, importTrackFromJson } from "./custom-tracks.js";
import {
  appendRoadOutlineToCanvasPath,
  boundsRoadOutline,
  buildTrackLayout,
  strokeRoadOutlineBoundaries,
  TRACK_WIDTH,
} from "./track-geometry.js";

function hypot(a, b) {
  return Math.sqrt(a * a + b * b);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function perpDist(p, a, b) {
  const nx = b.y - a.y;
  const ny = a.x - b.x;
  const nl = hypot(nx, ny) || 1;
  return Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny) / nl;
}

/** Minimum anchor spacing (world coords) — stops stacked points that kink sharp geometry. */
const MIN_CTRL_SEGMENT = 70;
/** Merge vertices closer than this on closed loops after simplify / close. */
const MERGE_EDGE_MIN = 58;
/** Max distance from pointer to an edge (world units) to count as “on the line” for insertion. */
const EDGE_INSERT_PICK_DIST = 76;
/** Don’t insert a midpoint glued to an existing vertex. */
const EDGE_INSERT_ENDPOINT_PAD = 22;
/** Sketch simplification tolerance (higher = smoother, fewer anchors). */
const RDP_SKETCH_LOOSE = 40;
const RDP_SKETCH_TIGHT = 30;

/**
 * Repeatedly removes the vertex that closes the shortest edge until all edges ≥ minD (keeps ≥4).
 * @param {{x:number,y:number}[]} ring
 */
function distPointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 1e-12 ? (apx * abx + apy * aby) / ab2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return { dist: hypot(px - qx, py - qy), qx, qy, t };
}

/**
 * @returns {{ segStart: number, dist: number, qx: number, qy: number } | null}
 */
function getClosestEdgeInfo(wx, wy, ring, isClosed) {
  const n = ring.length;
  if (n < 2) return null;
  const nSeg = isClosed ? n : n - 1;
  let best = null;
  for (let i = 0; i < nSeg; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const { dist, qx, qy } = distPointToSegment(wx, wy, a.x, a.y, b.x, b.y);
    if (!best || dist < best.dist) {
      best = { segStart: i, dist, qx, qy, ax: a.x, ay: a.y, bx: b.x, by: b.y };
    }
  }
  return best;
}

function mergeCloseControlRing(ring, minD) {
  const out = ring.map((p) => ({ x: p.x, y: p.y }));
  for (let guard = 0; guard < 600; guard++) {
    if (out.length <= 4) break;
    let minEdge = Infinity;
    let minI = -1;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d = hypot(out[j].x - out[i].x, out[j].y - out[i].y);
      if (d < minEdge) {
        minEdge = d;
        minI = i;
      }
    }
    if (minEdge >= minD) break;
    out.splice((minI + 1) % out.length, 1);
  }
  return out;
}

/** Ramer–Douglas–Peucker */
function simplifyRDP(points, epsilon) {
  if (points.length <= 2) return points.slice();
  let dmax = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }
  if (dmax > epsilon) {
    const r1 = simplifyRDP(points.slice(0, index + 1), epsilon);
    const r2 = simplifyRDP(points.slice(index), epsilon);
    return r1.slice(0, -1).concat(r2);
  }
  return [points[0], points[end]];
}

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   onClose: () => void,
 *   onSave: (p: { name: string, control: {x:number,y:number}[], widthScale: number, uid?: string }) => void,
 *   initial?: { uid?: string, name?: string, control?: {x:number,y:number}[], widthScale?: number } | null,
 * }} opts
 */
export function initTrackEditor(opts) {
  const canvas = opts.canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };

  let dpr = Math.min(2, window.devicePixelRatio || 1);

  /** @type {{x:number,y:number}[]} */
  let points = [];
  let closed = false;
  let mode = "points"; // 'points' | 'draw'
  /** @type {{x:number,y:number}[]} */
  let strokeBuf = [];
  let dragging = -1;
  let view = { cx: 0, cy: 0, scale: 0.38 };
  let hoverIdx = -1;
  /** Selected anchor index for Delete / toolbar removal; -1 if none. */
  let selectedIdx = -1;
  let editUid = opts.initial?.uid;
  const undoStack = [];

  function canRemoveOnePoint() {
    if (points.length === 0) return false;
    if (closed) return points.length > 4;
    return points.length > 2;
  }

  function syncDeletePointButton() {
    const btn = document.getElementById("track-editor-delete-point");
    if (!btn) return;
    const can = selectedIdx >= 0 && canRemoveOnePoint();
    btn.disabled = !can;
    if (selectedIdx < 0) {
      btn.removeAttribute("title");
      return;
    }
    if (can) {
      btn.title = "Remove selected control point";
      return;
    }
    btn.title = closed
      ? "Can't delete — a closed track must keep at least 4 control points."
      : "Can't delete — an open path must keep at least 3 control points.";
  }

  /** @param {number} idx */
  function deletePointAt(idx) {
    if (idx < 0 || idx >= points.length) return;
    if (!canRemoveOnePoint()) return;
    pushUndo();
    points.splice(idx, 1);
    if (closed && points.length < 4) closed = false;
    else if (idx === 0) closed = false;
    selectedIdx = -1;
    setHint("Point removed");
    scheduleDraw();
  }

  function deleteSelectedPoint() {
    if (selectedIdx < 0) return;
    deletePointAt(selectedIdx);
  }

  function onEditorKeyDown(ev) {
    const el = ev.target;
    if (
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable)
    ) {
      return;
    }
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    ev.preventDefault();
    if (selectedIdx >= 0 && !canRemoveOnePoint()) {
      setHint(
        closed
          ? "Can't delete — a closed track needs at least 4 control points."
          : "Can't delete — an open path needs at least 3 control points."
      );
      return;
    }
    deleteSelectedPoint();
  }

  const nameInput = /** @type {HTMLInputElement} */ (
    document.getElementById("track-editor-name")
  );
  const widthInput = /** @type {HTMLInputElement} */ (
    document.getElementById("track-editor-width")
  );
  const hintEl = document.getElementById("track-editor-hint");

  if (nameInput) nameInput.value = opts.initial?.name || "My track";
  if (widthInput) widthInput.value = String(opts.initial?.widthScale ?? 1);

  function onRoadParamInput() {
    scheduleDraw();
  }
  widthInput?.addEventListener("input", onRoadParamInput);

  if (opts.initial?.control?.length) {
    points = opts.initial.control.map((p) => ({ x: p.x, y: p.y }));
    closed = points.length >= 4;
  }

  function getFormPayload() {
    const name = nameInput?.value?.trim() || "Untitled track";
    const widthScale = clamp(parseFloat(String(widthInput?.value ?? "1")) || 1, 0.75, 1.35);
    return { name, widthScale };
  }

  /** Same road mesh as in-game; `null` if loop not ready. */
  function computeEditorMesh() {
    if (!closed || points.length < 4) return null;
    const { widthScale } = getFormPayload();
    return buildTrackLayout(points, {
      trackWidth: TRACK_WIDTH * widthScale,
    });
  }

  function pushUndo() {
    undoStack.push({
      points: points.map((p) => ({ x: p.x, y: p.y })),
      closed,
    });
    if (undoStack.length > 40) undoStack.shift();
  }

  function fitView() {
    if (points.length === 0) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const mesh = computeEditorMesh();
    if (mesh) {
      const b = boundsRoadOutline(mesh.roadOutline);
      minX = b.minX;
      minY = b.minY;
      maxX = b.maxX;
      maxY = b.maxY;
    } else {
      for (const p of points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const pad = 140;
    view.cx = (minX + maxX) / 2;
    view.cy = (minY + maxY) / 2;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const sw = canvas.clientWidth / Math.max(w, 400);
    const sh = canvas.clientHeight / Math.max(h, 400);
    view.scale = Math.min(sw, sh, 0.55);
  }

  function worldFromEvent(ev) {
    const r = canvas.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) * canvas.width) / r.width;
    const sy = ((ev.clientY - r.top) * canvas.height) / r.height;
    const wx = (sx - canvas.width / 2) / view.scale + view.cx;
    const wy = (sy - canvas.height / 2) / view.scale + view.cy;
    return { x: wx, y: wy };
  }

  function nearestVertex(wx, wy, maxD) {
    let best = -1;
    let bd = maxD;
    for (let i = 0; i < points.length; i++) {
      const d = hypot(points[i].x - wx, points[i].y - wy);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  function setHint(t) {
    if (hintEl) hintEl.textContent = t;
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0e14";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.cx, -view.cy);

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1 / view.scale;
    const grid = 120;
    for (let g = -3000; g < 3000; g += grid) {
      ctx.beginPath();
      ctx.moveTo(g, -3000);
      ctx.lineTo(g, 3000);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3000, g);
      ctx.lineTo(3000, g);
      ctx.stroke();
    }

    const mesh = computeEditorMesh();
    const z = view.scale;
    if (mesh) {
      const b = boundsRoadOutline(mesh.roadOutline);
      const minX = b.minX;
      const minY = b.minY;
      const maxX = b.maxX;
      const maxY = b.maxY;
      const ro = mesh.roadOutline;

      ctx.beginPath();
      appendRoadOutlineToCanvasPath(ctx, ro);
      const grd = ctx.createLinearGradient(minX, minY, maxX, maxY);
      grd.addColorStop(0, "#2d333f");
      grd.addColorStop(1, "#1e222b");
      ctx.fillStyle = grd;
      ctx.fill("evenodd");

      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = 3 / z;
      ctx.lineJoin = "round";
      strokeRoadOutlineBoundaries(ctx, ro);

      ctx.setLineDash([14 / z, 12 / z]);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.moveTo(mesh.center[0].x, mesh.center[0].y);
      for (let i = 1; i <= mesh.n; i++) {
        const p = mesh.center[i % mesh.n];
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const fl = mesh.finishLine;
      ctx.strokeStyle = "#fff59d";
      ctx.lineWidth = 4 / z;
      ctx.beginPath();
      ctx.moveTo(fl.a.x, fl.a.y);
      ctx.lineTo(fl.b.x, fl.b.y);
      ctx.stroke();

      ctx.setLineDash([5 / z, 5 / z]);
      ctx.strokeStyle = "rgba(0, 229, 255, 0.4)";
      ctx.lineWidth = 1.75 / z;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (closed && points.length > 2) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (points.length >= 2) {
      ctx.strokeStyle = "rgba(0,229,255,0.45)";
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (closed && points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();
    }

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const sel = selectedIdx === i;
      const rad = i === 0 ? 9 : hoverIdx === i || dragging === i ? 8.5 : 7;
      ctx.fillStyle =
        i === 0
          ? "rgba(255,213,79,0.95)"
          : "rgba(0,229,255,0.9)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad / view.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = sel ? "rgba(255,193,7,0.95)" : "rgba(255,255,255,0.6)";
      ctx.lineWidth = (sel ? 2.75 : 1.5) / view.scale;
      ctx.stroke();
      if (sel) {
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1.25 / view.scale;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (rad + 9) / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
    syncDeletePointButton();
  }

  function scheduleDraw() {
    requestAnimationFrame(draw);
  }

  function clearAll() {
    pushUndo();
    points = [];
    closed = false;
    selectedIdx = -1;
    setHint(
      mode === "points"
        ? "Click to place points (need ≥4 before closing) · click yellow start to close the loop"
        : "Hold drag to sketch · release to simplify (sketch needs enough corners for a ≥4-point loop)"
    );
    scheduleDraw();
  }

  function tryCloseLoop(wx, wy) {
    if (closed || points.length === 0) return false;
    const d = hypot(wx - points[0].x, wy - points[0].y);
    const nearStart = d < 42 / view.scale + 18;
    if (points.length < 4) {
      if (nearStart && points.length > 0) {
        setHint("Need at least 4 control points — place more corners, then close on the yellow start.");
      }
      return false;
    }
    if (!nearStart) return false;
    const last = points[points.length - 1];
    if (hypot(last.x - points[0].x, last.y - points[0].y) < MIN_CTRL_SEGMENT * 0.85) {
      setHint("Last point too close to start — add spacing before closing the loop.");
      return false;
    }
    pushUndo();
    closed = true;
    points = mergeCloseControlRing(points, MERGE_EDGE_MIN);
    setHint("Loop closed — preview matches race geometry · Save or Test drive");
    return true;
  }

  let sketching = false;

  function onDown(ev) {
    const { x, y } = worldFromEvent(ev);
    if (mode === "draw") {
      sketching = true;
      strokeBuf = [{ x, y }];
      pushUndo();
      return;
    }
    if (closed) {
      const hit = nearestVertex(x, y, 44);
      if (hit >= 0) {
        selectedIdx = hit;
        dragging = hit;
      } else {
        selectedIdx = -1;
      }
      scheduleDraw();
      return;
    }
    if (tryCloseLoop(x, y)) {
      selectedIdx = -1;
      scheduleDraw();
      return;
    }
    const hit = nearestVertex(x, y, 40 / view.scale + 8);
    if (hit >= 0) {
      selectedIdx = hit;
      dragging = hit;
      scheduleDraw();
      return;
    }
    const edgePick = getClosestEdgeInfo(x, y, points, closed);
    if (mode === "points" && edgePick && edgePick.dist < EDGE_INSERT_PICK_DIST) {
      return;
    }
    if (points.length > 0) {
      const last = points[points.length - 1];
      if (hypot(x - last.x, y - last.y) < MIN_CTRL_SEGMENT) {
        setHint(
          "Too close to the last point — space anchors more in corners so the smoothed road stays valid."
        );
        return;
      }
    }
    selectedIdx = -1;
    pushUndo();
    points.push({ x, y });
    setHint(
      points.length < 4
        ? `Place at least 4 corners (${points.length}/4) — then click the yellow start to close`
        : "Click near yellow dot to close the loop"
    );
    scheduleDraw();
  }

  function onMove(ev) {
    const { x, y } = worldFromEvent(ev);
    if (mode === "draw" && sketching) {
      const last = strokeBuf[strokeBuf.length - 1];
      if (!last || hypot(x - last.x, y - last.y) > 18) {
        strokeBuf.push({ x, y });
      }
      points = strokeBuf.slice();
      closed = false;
      scheduleDraw();
      return;
    }
    if (dragging >= 0) {
      points[dragging] = { x, y };
      selectedIdx = dragging;
      scheduleDraw();
      return;
    }
    hoverIdx = nearestVertex(x, y, 36 / view.scale + 6);
    scheduleDraw();
  }

  function onUp() {
    if (mode === "draw" && sketching) {
      sketching = false;
      if (strokeBuf.length >= 8) {
        let simp = simplifyRDP(strokeBuf, RDP_SKETCH_LOOSE);
        const a = simp[0];
        const b = simp[simp.length - 1];
        if (hypot(a.x - b.x, a.y - b.y) > 35) {
          simp.push({ x: a.x, y: a.y });
        }
        if (simp.length >= 4) {
          points = mergeCloseControlRing(simp, MERGE_EDGE_MIN);
          closed = true;
          fitView();
          setMode("points");
          selectedIdx = -1;
          setHint("Sketch converted — points mode — drag anchors to tweak corners");
        }
      } else if (strokeBuf.length >= 4) {
        let simp = simplifyRDP(strokeBuf, RDP_SKETCH_TIGHT);
        closed =
          hypot(simp[0].x - simp[simp.length - 1].x, simp[0].y - simp[simp.length - 1].y) <
          50;
        if (!closed) simp.push({ x: simp[0].x, y: simp[0].y });
        closed = true;
        points = mergeCloseControlRing(simp, MERGE_EDGE_MIN);
        fitView();
        setMode("points");
        selectedIdx = -1;
        setHint("Sketch converted — points mode — drag anchors to tweak corners");
      }
      strokeBuf = [];
      scheduleDraw();
    }
    dragging = -1;
  }

  function onWheel(ev) {
    ev.preventDefault();
    const z = ev.deltaY > 0 ? 0.92 : 1.09;
    view.scale = clamp(view.scale * z, 0.12, 1.2);
    scheduleDraw();
  }

  function onCtxMenu(ev) {
    ev.preventDefault();
    const { x, y } = worldFromEvent(ev);
    const hit = nearestVertex(x, y, 40 / view.scale + 10);
    if (hit < 0) return;
    selectedIdx = hit;
    if (canRemoveOnePoint()) {
      deletePointAt(hit);
    } else {
      setHint(
        closed
          ? "Can't delete that point — a closed track must keep at least 4 control points."
          : "Can't delete that point — an open path must keep at least 3 control points."
      );
      scheduleDraw();
    }
  }

  function onDblClick(ev) {
    ev.preventDefault();
    if (mode === "draw" && sketching) return;
    if (points.length < 2) return;
    const { x, y } = worldFromEvent(ev);
    const pick = getClosestEdgeInfo(x, y, points, closed);
    if (!pick || pick.dist > EDGE_INSERT_PICK_DIST * 1.1) return;
    const da = hypot(pick.qx - pick.ax, pick.qy - pick.ay);
    const db = hypot(pick.qx - pick.bx, pick.qy - pick.by);
    if (da < EDGE_INSERT_ENDPOINT_PAD || db < EDGE_INSERT_ENDPOINT_PAD) return;
    for (let i = 0; i < points.length; i++) {
      if (hypot(pick.qx - points[i].x, pick.qy - points[i].y) < EDGE_INSERT_ENDPOINT_PAD) {
        return;
      }
    }
    pushUndo();
    points.splice(pick.segStart + 1, 0, { x: pick.qx, y: pick.qy });
    selectedIdx = -1;
    setHint("Point added on edge — double-click another span to add more");
    scheduleDraw();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onCtxMenu);
  window.addEventListener("keydown", onEditorKeyDown);

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(canvas);
  fitView();
  scheduleDraw();

  setHint(
    mode === "points"
      ? "Place ≥4 corners and close on yellow start · Delete / right‑click removes anchors · double‑click edge to split · wheel zoom"
      : "Sketch a loop with enough corners for ≥4 points · wheel zoom · right‑click: select or remove"
  );

  function getSnapshot() {
    const { name, widthScale } = getFormPayload();
    return {
      name,
      widthScale,
      uid: editUid,
      control: points.map((p) => ({ x: p.x, y: p.y })),
      closed,
      valid: closed && points.length >= 4,
    };
  }

  function saveClicked() {
    if (!closed || points.length < 4) {
      setHint("Close the loop with at least 4 control points before saving");
      return;
    }
    const { name, widthScale } = getFormPayload();
    const control = points.map((p) => ({ x: p.x, y: p.y }));
    opts.onSave({
      name,
      control,
      widthScale,
      uid: editUid,
    });
  }

  function exportClicked() {
    if (!closed || points.length < 4) {
      setHint("Need a closed loop with at least 4 control points");
      return;
    }
    const { name, widthScale } = getFormPayload();
    const rec = {
      uid: editUid || `custom_export_${Date.now()}`,
      name,
      control: points.map((p) => ({ x: p.x, y: p.y })),
      widthScale,
    };
    const safe = name.replace(/[^\w\-]+/g, "_").slice(0, 40) || "track";
    downloadBlob(`${safe}.json`, exportTrackJson(rec));
    setHint("Downloaded JSON — share this file");
  }

  function setMode(m) {
    mode = m;
    if (m === "draw") selectedIdx = -1;
    if (btnPoints) btnPoints.classList.toggle("menu-btn-primary", m === "points");
    if (btnDraw) btnDraw.classList.toggle("menu-btn-primary", m === "draw");
    setHint(
      m === "points"
        ? "≥4 corners, close on yellow · click to select · Delete removes · double-click edge adds"
        : "Sketch so the simplified loop has ≥4 corners"
    );
  }

  function onToolbarModePoints() {
    setMode("points");
  }
  function onToolbarModeDraw() {
    setMode("draw");
  }
  function onToolbarUndo() {
    const u = undoStack.pop();
    if (u) {
      points = u.points;
      closed = u.closed;
      selectedIdx = -1;
      scheduleDraw();
    }
  }
  function onToolbarDeletePoint() {
    if (selectedIdx >= 0 && !canRemoveOnePoint()) {
      setHint(
        closed
          ? "Can't delete — a closed track needs at least 4 control points."
          : "Can't delete — an open path needs at least 3 control points."
      );
      return;
    }
    deleteSelectedPoint();
  }
  function onToolbarFit() {
    fitView();
    scheduleDraw();
  }
  function onToolbarClose() {
    opts.onClose();
  }

  const btnPoints = document.getElementById("track-editor-mode-points");
  const btnDraw = document.getElementById("track-editor-mode-draw");
  const btnClear = document.getElementById("track-editor-clear");
  const btnUndo = document.getElementById("track-editor-undo");
  const btnDeletePoint = document.getElementById("track-editor-delete-point");
  const btnFit = document.getElementById("track-editor-fit");
  const btnSave = document.getElementById("track-editor-save");
  const btnExport = document.getElementById("track-editor-export");
  const btnClose = document.getElementById("track-editor-close");
  const btnImport = document.getElementById("track-editor-import");
  const fileImport = /** @type {HTMLInputElement | null} */ (
    document.getElementById("track-editor-import-file")
  );

  btnPoints?.addEventListener("click", onToolbarModePoints);
  btnDraw?.addEventListener("click", onToolbarModeDraw);
  btnClear?.addEventListener("click", clearAll);
  btnUndo?.addEventListener("click", onToolbarUndo);
  btnDeletePoint?.addEventListener("click", onToolbarDeletePoint);
  btnFit?.addEventListener("click", onToolbarFit);
  btnSave?.addEventListener("click", saveClicked);
  btnExport?.addEventListener("click", exportClicked);
  btnClose?.addEventListener("click", onToolbarClose);

  function importEditorRecord(rec) {
    if (!rec?.control || rec.control.length < 4) {
      setHint("Need at least 4 control points in the file");
      return;
    }
    pushUndo();
    points = rec.control.map((p) => ({ x: p.x, y: p.y }));
    closed = true;
    editUid = typeof rec.uid === "string" && rec.uid.startsWith("custom_") ? rec.uid : editUid;
    if (nameInput) nameInput.value = rec.name || "Imported track";
    if (widthInput)
      widthInput.value = String(clamp(parseFloat(String(rec.widthScale ?? 1)) || 1, 0.75, 1.35));
    points = mergeCloseControlRing(points, MERGE_EDGE_MIN);
    selectedIdx = -1;
    fitView();
    scheduleDraw();
    setHint("Imported — Save to keep a copy on this device");
  }

  function onEditorImportBrowse() {
    fileImport?.click();
  }

  function onEditorImportFileChange(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importEditorRecord(importTrackFromJson(String(reader.result || "")));
      } catch (err) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? /** @type {{ message: string }} */ (err).message
            : String(err);
        setHint(msg);
      }
      input.value = "";
    };
    reader.readAsText(f);
  }

  btnImport?.addEventListener("click", onEditorImportBrowse);
  fileImport?.addEventListener("change", onEditorImportFileChange);

  function destroy() {
    btnPoints?.removeEventListener("click", onToolbarModePoints);
    btnDraw?.removeEventListener("click", onToolbarModeDraw);
    btnClear?.removeEventListener("click", clearAll);
    btnUndo?.removeEventListener("click", onToolbarUndo);
    btnDeletePoint?.removeEventListener("click", onToolbarDeletePoint);
    btnFit?.removeEventListener("click", onToolbarFit);
    btnSave?.removeEventListener("click", saveClicked);
    btnExport?.removeEventListener("click", exportClicked);
    btnClose?.removeEventListener("click", onToolbarClose);
    btnImport?.removeEventListener("click", onEditorImportBrowse);
    fileImport?.removeEventListener("change", onEditorImportFileChange);
    widthInput?.removeEventListener("input", onRoadParamInput);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("wheel", onWheel, { passive: false });
    canvas.removeEventListener("contextmenu", onCtxMenu);
    window.removeEventListener("keydown", onEditorKeyDown);
    ro.disconnect();
  }

  return {
    destroy,
    saveClicked,
    exportClicked,
    getSnapshot,
    importRecord: importEditorRecord,
  };
}
