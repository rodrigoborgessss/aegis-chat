// store.js — persistência local em IndexedDB, UMA base por utilizador.
// Assim dois separadores no mesmo browser são dois dispositivos independentes
// (não partilham identidade nem sessões). Guarda CryptoKey diretamente.
const VER = 2;
const dbName = user => `aegis-chat-${user}`;
let _db = null, _dbName = null;

function open(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ["meta", "opks", "sessions", "threads", "groups", "kv"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      // se outra aba pedir para apagar/atualizar, fecha esta ligação (não bloqueia)
      db.onversionchange = () => { db.close(); if (_db === db) _db = null; };
      res(db);
    };
    r.onerror = () => rej(r.error);
  });
}
const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function createStore(user) {
  const name = dbName(user);
  const db = await open(name);
  _db = db; _dbName = name;
  const get = (s, k) => done(db.transaction(s, "readonly").objectStore(s).get(k));
  const getAll = s => done(db.transaction(s, "readonly").objectStore(s).getAll());
  const put = (s, k, v) => done(db.transaction(s, "readwrite").objectStore(s).put(v, k));
  const del = (s, k) => done(db.transaction(s, "readwrite").objectStore(s).delete(k));
  return {
    getIdentity: () => get("meta", "identity").then(v => v || null),
    setIdentity: v => put("meta", "identity", v),
    getSPK: () => get("meta", "spk").then(v => v || null),
    setSPK: v => put("meta", "spk", v),
    addOPK: (id, kp) => put("opks", id, kp),
    getOPK: id => get("opks", id).then(v => v || null),
    removeOPK: id => del("opks", id),
    getSession: peer => get("sessions", peer).then(v => v || null),
    setSession: (peer, v) => put("sessions", peer, v),
    delSession: peer => del("sessions", peer),
    // histórico de mensagens
    getThreads: () => getAll("threads"),
    saveThread: (key, msgs) => put("threads", key, { key, msgs }),
    deleteThread: key => del("threads", key),
    // estado dos grupos
    getGroups: () => getAll("groups"),
    saveGroup: (gid, g) => put("groups", gid, g),
    deleteGroupRec: gid => del("groups", gid),
    // metadados da app (nomes públicos, temporizadores, verificações)
    getKv: k => get("kv", k).then(v => v || null),
    setKv: (k, v) => put("kv", k, v),
  };
}

// apaga só a base deste utilizador, fechando a ligação primeiro para não bloquear
export async function wipe(user) {
  const name = dbName(user);
  if (_db && _dbName === name) { _db.close(); _db = null; _dbName = null; }
  await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res;
  });
}
