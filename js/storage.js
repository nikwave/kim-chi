// Хранилище сессий в IndexedDB. При любой ошибке — работаем в памяти и сообщаем об этом.
const DB = "finch-companion", STORE = "sessions", VERSION = 1;

let dbp = null;
let memory = new Map();
export let storageError = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { storageError = String(req.error || "ошибка IndexedDB"); resolve(null); };
      req.onblocked = () => { storageError = "IndexedDB заблокирована"; resolve(null); };
    } catch (e) { storageError = String(e); resolve(null); }
  });
  return dbp;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveSession(s) {
  memory.set(s.id, s);
  const db = await open();
  if (!db) return false;
  try { await tx(db, "readwrite", st => st.put(s)); return true; }
  catch (e) { storageError = String(e); return false; }
}

export async function listSessions() {
  const db = await open();
  let rows = [];
  if (db) {
    try { rows = await tx(db, "readonly", st => st.getAll()); }
    catch (e) { storageError = String(e); }
  }
  const byId = new Map((rows || []).map(r => [r.id, r]));
  for (const [k, v] of memory) if (!byId.has(k)) byId.set(k, v);
  return [...byId.values()].sort((a, b) => b.id.localeCompare(a.id));
}

export async function deleteAllSessions() {
  memory = new Map();
  const db = await open();
  if (db) { try { await tx(db, "readwrite", st => st.clear()); } catch (e) { storageError = String(e); } }
}
