/**
 * User-drawn tracks: local persistence and import/export for sharing.
 */

export const CUSTOM_STORAGE_KEY = "aneRacingCustomTracks_v1";
export const TRACK_FILE_MAGIC = "ane-racing-track";
export const TRACK_FILE_VERSION = 1;

/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ uid: string, name: string, control: Pt[], subdiv?: number, widthScale?: number, createdAt?: string }} CustomTrackRecord */

function newUid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `custom_${crypto.randomUUID()}`;
  }
  return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function loadCustomTracks() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecord);
  } catch {
    return [];
  }
}

function isValidRecord(x) {
  if (!x || typeof x.uid !== "string" || !x.uid.startsWith("custom_")) return false;
  if (typeof x.name !== "string" || x.name.length > 80) return false;
  if (!Array.isArray(x.control) || x.control.length < 4) return false;
  for (const p of x.control) {
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") return false;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) return false;
  }
  return true;
}

function saveCustomTracks(list) {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(list));
  } catch (_) {}
}

/** @param {CustomTrackRecord} rec */
export function upsertCustomTrack(rec) {
  const list = loadCustomTracks();
  const i = list.findIndex((t) => t.uid === rec.uid);
  if (i >= 0) {
    rec.createdAt = list[i].createdAt || rec.createdAt;
    list[i] = rec;
  } else {
    list.push(rec);
  }
  saveCustomTracks(list);
}

/**
 * @param {Omit<CustomTrackRecord, 'uid'|'createdAt'> & { uid?: string }} data
 * @returns {string} uid
 */
export function createCustomTrack(data) {
  const list = loadCustomTracks();
  const uid = data.uid && data.uid.startsWith("custom_") ? data.uid : newUid();
  const existing = list.find((t) => t.uid === uid);
  const rec = {
    uid,
    name: String(data.name || "Untitled track").slice(0, 80),
    control: data.control.map((p) => ({ x: p.x, y: p.y })),
    subdiv: clamp(Math.round(data.subdiv ?? 14), 8, 20),
    widthScale: clamp(Number(data.widthScale ?? 1), 0.75, 1.35),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  upsertCustomTrack(rec);
  return uid;
}

export function deleteCustomTrack(uid) {
  const list = loadCustomTracks().filter((t) => t.uid !== uid);
  saveCustomTracks(list);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * @returns {string} JSON text suitable for a .json file
 */
export function exportTrackJson(rec) {
  const payload = {
    format: TRACK_FILE_MAGIC,
    version: TRACK_FILE_VERSION,
    uid: rec.uid,
    name: rec.name,
    control: rec.control.map((p) => ({ x: p.x, y: p.y })),
    subdiv: rec.subdiv ?? 14,
    widthScale: rec.widthScale ?? 1,
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * @param {string} jsonText
 * @returns {CustomTrackRecord}
 */
export function importTrackFromJson(jsonText) {
  let o;
  try {
    o = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON");
  }
  if (!o || o.format !== TRACK_FILE_MAGIC) {
    throw new Error("Not an Ane Racing track file");
  }
  if (o.version !== TRACK_FILE_VERSION) {
    throw new Error(`Unsupported track format version: ${o.version}`);
  }
  const control = o.control;
  if (!Array.isArray(control) || control.length < 4) {
    throw new Error("Track needs at least 4 control points");
  }
  const pts = [];
  for (const p of control) {
    if (typeof p.x !== "number" || typeof p.y !== "number") {
      throw new Error("Invalid point in track");
    }
    pts.push({ x: p.x, y: p.y });
  }
  return {
    uid: newUid(),
    name: String(o.name || "Imported track").slice(0, 80),
    control: pts,
    subdiv: clamp(Math.round(o.subdiv ?? 14), 8, 20),
    widthScale: clamp(Number(o.widthScale ?? 1), 0.75, 1.35),
    createdAt: new Date().toISOString(),
  };
}

export function downloadBlob(filename, text, mime = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
