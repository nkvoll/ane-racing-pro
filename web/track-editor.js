/**
 * Interactive track editor: place points or sketch a loop, save/export compatible with game Track.
 */

import { exportTrackJson, downloadBlob } from "./custom-tracks.js";
import { buildTrackLayout, TRACK_WIDTH } from "./track-geometry.js";

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
 *   onSave: (p: { name: string, control: {x:number,y:number}[], subdiv: number, widthScale: number, uid?: string }) => void,
 *   initial?: { uid?: string, name?: string, control?: {x:number,y:number}[], subdiv?: number, widthScale?: number } | null,
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
  let editUid = opts.initial?.uid;
  const undoStack = [];

  const nameInput = /** @type {HTMLInputElement} */ (
    document.getElementById("track-editor-name")
  );
  const subdivInput = /** @type {HTMLInputElement} */ (
    document.getElementById("track-editor-subdiv")
  );
  const widthInput = /** @type {HTMLInputElement} */ (
    document.getElementById("track-editor-width")
  );
  const hintEl = document.getElementById("track-editor-hint");

  if (nameInput) nameInput.value = opts.initial?.name || "My track";
  if (subdivInput) subdivInput.value = String(opts.initial?.subdiv ?? 14);
  if (widthInput) widthInput.value = String(opts.initial?.widthScale ?? 1);

  function onRoadParamInput() {
    scheduleDraw();
  }
  subdivInput?.addEventListener("input", onRoadParamInput);
  widthInput?.addEventListener("input", onRoadParamInput);

  if (opts.initial?.control?.length) {
    points = opts.initial.control.map((p) => ({ x: p.x, y: p.y }));
    closed = points.length >= 4;
  }

  function getFormPayload() {
    const name = nameInput?.value?.trim() || "Untitled track";
    const subdiv = clamp(parseInt(String(subdivInput?.value ?? "14"), 10) || 14, 8, 20);
    const widthScale = clamp(parseFloat(String(widthInput?.value ?? "1")) || 1, 0.75, 1.35);
    return { name, subdiv, widthScale };
  }

  /** Same road mesh as in-game; `null` if loop not ready. */
  function computeEditorMesh() {
    if (!closed || points.length < 4) return null;
    const { subdiv, widthScale } = getFormPayload();
    return buildTrackLayout(points, {
      subdiv,
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
      for (const p of mesh.outer) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      for (const p of mesh.inner) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
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
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of mesh.outer) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      for (const p of mesh.inner) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }

      ctx.beginPath();
      ctx.moveTo(mesh.outer[0].x, mesh.outer[0].y);
      for (let i = 1; i <= mesh.n; i++) {
        const p = mesh.outer[i % mesh.n];
        ctx.lineTo(p.x, p.y);
      }
      ctx.moveTo(mesh.inner[0].x, mesh.inner[0].y);
      for (let i = 1; i <= mesh.n; i++) {
        const p = mesh.inner[i % mesh.n];
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      const grd = ctx.createLinearGradient(minX, minY, maxX, maxY);
      grd.addColorStop(0, "#2d333f");
      grd.addColorStop(1, "#1e222b");
      ctx.fillStyle = grd;
      ctx.fill("evenodd");

      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = 3 / z;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(mesh.outer[0].x, mesh.outer[0].y);
      for (let i = 1; i <= mesh.n; i++) {
        ctx.lineTo(mesh.outer[i % mesh.n].x, mesh.outer[i % mesh.n].y);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mesh.inner[0].x, mesh.inner[0].y);
      for (let i = 1; i <= mesh.n; i++) {
        ctx.lineTo(mesh.inner[i % mesh.n].x, mesh.inner[i % mesh.n].y);
      }
      ctx.stroke();

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

      const mc = mesh.midCheckpoint;
      ctx.strokeStyle = "rgba(255, 152, 67, 0.45)";
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      ctx.arc(mc.x, mc.y, mc.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

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
      const rad = i === 0 ? 9 : hoverIdx === i || dragging === i ? 8.5 : 7;
      ctx.fillStyle =
        i === 0
          ? "rgba(255,213,79,0.95)"
          : "rgba(0,229,255,0.9)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad / view.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1.5 / view.scale;
      ctx.stroke();
    }

    ctx.restore();
  }

  function scheduleDraw() {
    requestAnimationFrame(draw);
  }

  function clearAll() {
    pushUndo();
    points = [];
    closed = false;
    setHint(
      mode === "points"
        ? "Click to place points · click yellow start to close loop"
        : "Hold drag to sketch · release to simplify"
    );
    scheduleDraw();
  }

  function tryCloseLoop(wx, wy) {
    if (closed || points.length < 3) return false;
    const d = hypot(wx - points[0].x, wy - points[0].y);
    if (d < 42 / view.scale + 18) {
      pushUndo();
      closed = true;
      setHint("Loop closed — Save track or Test drive");
      return true;
    }
    return false;
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
      if (hit >= 0) dragging = hit;
      return;
    }
    if (tryCloseLoop(x, y)) {
      scheduleDraw();
      return;
    }
    const hit = nearestVertex(x, y, 40 / view.scale + 8);
    if (hit >= 0) {
      dragging = hit;
      return;
    }
    pushUndo();
    points.push({ x, y });
    setHint(
      points.length < 3
        ? "Add more points, then click the yellow start to close"
        : "Click near yellow dot to close the loop"
    );
    scheduleDraw();
  }

  function onMove(ev) {
    const { x, y } = worldFromEvent(ev);
    if (mode === "draw" && sketching) {
      const last = strokeBuf[strokeBuf.length - 1];
      if (!last || hypot(x - last.x, y - last.y) > 10) {
        strokeBuf.push({ x, y });
      }
      points = strokeBuf.slice();
      closed = false;
      scheduleDraw();
      return;
    }
    if (dragging >= 0) {
      points[dragging] = { x, y };
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
        let simp = simplifyRDP(strokeBuf, 28);
        const a = simp[0];
        const b = simp[simp.length - 1];
        if (hypot(a.x - b.x, a.y - b.y) > 35) {
          simp.push({ x: a.x, y: a.y });
        }
        if (simp.length >= 4) {
          points = simp;
          closed = true;
          fitView();
          setHint("Sketch converted — adjust points or Save");
        }
      } else if (strokeBuf.length >= 4) {
        points = simplifyRDP(strokeBuf, 22);
        closed =
          hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <
          50;
        if (!closed) points.push({ x: points[0].x, y: points[0].y });
        closed = true;
        fitView();
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
    if (hit >= 0 && points.length > 4) {
      pushUndo();
      points.splice(hit, 1);
      if (hit === 0) closed = false;
      scheduleDraw();
    }
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onCtxMenu);

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(canvas);
  fitView();
  scheduleDraw();

  setHint(
    mode === "points"
      ? "Click to add corners · click yellow start to close · wheel zoom"
      : "Drag to draw · wheel zoom · right-click deletes a point"
  );

  function destroy() {
    subdivInput?.removeEventListener("input", onRoadParamInput);
    widthInput?.removeEventListener("input", onRoadParamInput);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onCtxMenu);
    ro.disconnect();
  }

  function getSnapshot() {
    const { name, subdiv, widthScale } = getFormPayload();
    return {
      name,
      subdiv,
      widthScale,
      uid: editUid,
      control: points.map((p) => ({ x: p.x, y: p.y })),
      closed,
      valid: closed && points.length >= 4,
    };
  }

  function saveClicked() {
    if (!closed || points.length < 4) {
      setHint("Close the loop (≥4 points) before saving");
      return;
    }
    const { name, subdiv, widthScale } = getFormPayload();
    const control = points.map((p) => ({ x: p.x, y: p.y }));
    opts.onSave({
      name,
      control,
      subdiv,
      widthScale,
      uid: editUid,
    });
  }

  function exportClicked() {
    if (!closed || points.length < 4) {
      setHint("Need a closed loop first");
      return;
    }
    const { name, subdiv, widthScale } = getFormPayload();
    const rec = {
      uid: editUid || `custom_export_${Date.now()}`,
      name,
      control: points.map((p) => ({ x: p.x, y: p.y })),
      subdiv,
      widthScale,
    };
    const safe = name.replace(/[^\w\-]+/g, "_").slice(0, 40) || "track";
    downloadBlob(`${safe}.json`, exportTrackJson(rec));
    setHint("Downloaded JSON — share this file");
  }

  const btnPoints = document.getElementById("track-editor-mode-points");
  const btnDraw = document.getElementById("track-editor-mode-draw");
  const btnClear = document.getElementById("track-editor-clear");
  const btnUndo = document.getElementById("track-editor-undo");
  const btnFit = document.getElementById("track-editor-fit");
  const btnSave = document.getElementById("track-editor-save");
  const btnExport = document.getElementById("track-editor-export");
  const btnClose = document.getElementById("track-editor-close");

  function setMode(m) {
    mode = m;
    if (btnPoints) btnPoints.classList.toggle("menu-btn-primary", m === "points");
    if (btnDraw) btnDraw.classList.toggle("menu-btn-primary", m === "draw");
    setHint(
      m === "points"
        ? "Click corners · click yellow to close"
        : "Drag freehand to sketch a loop"
    );
  }
  btnPoints?.addEventListener("click", () => setMode("points"));
  btnDraw?.addEventListener("click", () => setMode("draw"));

  btnClear?.addEventListener("click", clearAll);
  btnUndo?.addEventListener("click", () => {
    const u = undoStack.pop();
    if (u) {
      points = u.points;
      closed = u.closed;
      scheduleDraw();
    }
  });
  btnFit?.addEventListener("click", () => {
    fitView();
    scheduleDraw();
  });
  btnSave?.addEventListener("click", saveClicked);
  btnExport?.addEventListener("click", exportClicked);
  btnClose?.addEventListener("click", () => opts.onClose());

  return {
    destroy,
    saveClicked,
    exportClicked,
    getSnapshot,
  };
}
