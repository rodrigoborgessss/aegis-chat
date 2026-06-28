// vault.js — cifragem do armazenamento local (IndexedDB).
//
// O estado guardado (identidade, prekeys, sessões, histórico, grupos) contém
// objetos CryptoKey, Uint8Array, Map e Set. Para o cifrar é preciso primeiro
// serializá-lo para algo que caiba em JSON: pack() exporta as CryptoKey (são
// extractable) e marca os tipos; unpack() reconstrói tudo ao ler.
//
// A chave do cofre deriva-se da passphrase com Argon2id (64 MiB, 3 passes — o
// mesmo perfil do KeyVault), via WASM vendorizado (public/vendor/argon2.min.js).
// Cada valor é cifrado com AES-256-GCM e um IV próprio.

const te = new TextEncoder(), td = new TextDecoder();
const b64 = u => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

// ---- serialização estruturada (CryptoKey / Uint8Array / Map / Set) ----
async function packCK(k) {
  const fmt = k.type === "private" ? "pkcs8" : "raw";          // EC: priv -> pkcs8, pub -> raw
  const raw = new Uint8Array(await crypto.subtle.exportKey(fmt, k));
  return { __ck: 1, fmt, d: b64(raw), alg: k.algorithm, ku: k.usages };
}
export async function pack(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Uint8Array) return { __u8: b64(v) };
  if (v instanceof ArrayBuffer) return { __u8: b64(new Uint8Array(v)) };
  if (typeof CryptoKey !== "undefined" && v instanceof CryptoKey) return await packCK(v);
  if (v instanceof Map) { const d = []; for (const [k, val] of v) d.push([k, await pack(val)]); return { __map: d }; }
  if (v instanceof Set) { const d = []; for (const x of v) d.push(await pack(x)); return { __set: d }; }
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await pack(x)); return a; }
  if (typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = await pack(v[k]); return o; }
  return v; // primitivos
}
export async function unpack(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await unpack(x)); return a; }
  if (typeof v === "object") {
    if ("__u8" in v) return unb64(v.__u8);
    if (v.__ck) return await crypto.subtle.importKey(v.fmt, unb64(v.d), v.alg, true, v.ku);
    if (v.__map) { const m = new Map(); for (const [k, val] of v.__map) m.set(k, await unpack(val)); return m; }
    if (v.__set) { const s = new Set(); for (const x of v.__set) s.add(await unpack(x)); return s; }
    const o = {}; for (const k of Object.keys(v)) o[k] = await unpack(v[k]); return o;
  }
  return v;
}

// ---- KDF ----
export async function deriveVaultKey(passphrase, salt) {
  const hw = globalThis.hashwasm;
  if (!hw || !hw.argon2id) throw new Error("Argon2 não carregado (vendor/argon2.min.js).");
  return await hw.argon2id({
    password: passphrase, salt,
    parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary",
  }); // -> Uint8Array(32)
}
export const newSalt = () => crypto.getRandomValues(new Uint8Array(16));

// ---- cifragem de valores ----
const aesKey = raw => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
export async function encryptValue(rawKey, value) {
  const key = await aesKey(rawKey);
  const pt = te.encode(JSON.stringify(await pack(value)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return { __enc: 1, iv, ct };
}
export async function decryptValue(rawKey, blob) {
  const key = await aesKey(rawKey);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv }, key, blob.ct));
  return await unpack(JSON.parse(td.decode(pt)));
}

// verificador: um valor conhecido cifrado, para confirmar a passphrase no arranque
export async function makeVerifier(rawKey) { return await encryptValue(rawKey, { v: "aegis-vault-ok" }); }
export async function checkVerifier(rawKey, ver) {
  try { const r = await decryptValue(rawKey, ver); return r && r.v === "aegis-vault-ok"; }
  catch { return false; }
}

export { b64 as vb64, unb64 as vunb64 };
