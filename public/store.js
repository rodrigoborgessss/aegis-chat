// store.js — persistência local em IndexedDB, UMA base por utilizador.
// Assim dois separadores no mesmo browser são dois dispositivos independentes
// (não partilham identidade nem sessões).
//
// O conteúdo é cifrado em repouso: quando o cofre está desbloqueado (vaultKey
// definida), cada valor passa por encryptValue/decryptValue (AES-256-GCM, chave
// derivada da passphrase com Argon2id). Os metadados do cofre (salt + verificador)
// ficam EM CLARO numa chave reservada — são precisos para derivar a chave.
import { encryptValue, decryptValue } from "./vault.js";

const VER = 2;
const dbName = user => `aegis-chat-${user}`;
const VAULT_KEY = "__vault";              // chave reservada (não cifrada) no store "kv"
const STORES = ["meta", "opks", "sessions", "threads", "groups", "kv"];
let _db = null, _dbName = null;

function open(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
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
  let vaultKey = null;                                          // bytes da chave do cofre (null = bloqueado/sem cofre)
  const reserved = (s, k) => s === "kv" && k === VAULT_KEY;

  const rawGet = (s, k) => done(db.transaction(s, "readonly").objectStore(s).get(k));
  const rawGetAll = s => done(db.transaction(s, "readonly").objectStore(s).getAll());
  const rawGetAllKeys = s => done(db.transaction(s, "readonly").objectStore(s).getAllKeys());
  const rawPut = (s, k, v) => done(db.transaction(s, "readwrite").objectStore(s).put(v, k));
  const del = (s, k) => done(db.transaction(s, "readwrite").objectStore(s).delete(k));

  async function get(s, k) {
    const raw = await rawGet(s, k);
    if (raw == null || reserved(s, k)) return raw;
    if (raw && raw.__enc) return vaultKey ? await decryptValue(vaultKey, raw) : null; // cifrado mas trancado
    return raw;                                                 // legado em claro (pré-cofre)
  }
  async function getAll(s) {
    const arr = await rawGetAll(s);
    const out = [];
    for (const v of arr) out.push(v && v.__enc ? (vaultKey ? await decryptValue(vaultKey, v) : null) : v);
    return out.filter(v => v != null);
  }
  async function put(s, k, v) {
    if (vaultKey && !reserved(s, k)) v = await encryptValue(vaultKey, v);
    return rawPut(s, k, v);
  }

  // cifra à força tudo o que esteja em claro (na ativação do cofre)
  async function reencryptAll() {
    for (const s of STORES) {
      for (const k of await rawGetAllKeys(s)) {
        if (reserved(s, k)) continue;
        const raw = await rawGet(s, k);
        if (raw == null || raw.__enc) continue;
        await rawPut(s, k, await encryptValue(vaultKey, raw));
      }
    }
  }

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
    // ---- cofre ----
    getVaultMeta: () => rawGet("kv", VAULT_KEY).then(v => v || null),
    setVaultMeta: m => rawPut("kv", VAULT_KEY, m),
    unlock: key => { vaultKey = key; },
    isUnlocked: () => !!vaultKey,
    reencryptAll,
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
