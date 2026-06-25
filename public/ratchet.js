// ratchet.js — motor partilhado: primitivas, X3DH e Double Ratchet.
// Corre tal e qual no Node (>=18) e no browser, porque só usa WebCrypto.
// O Double Ratchet trata mensagens fora de ordem guardando as chaves das
// mensagens saltadas (MKSKIPPED), como no spec do Signal.

const enc = new TextEncoder(), dec = new TextDecoder();
export const rand = n => crypto.getRandomValues(new Uint8Array(n));
export const eq = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const hexs = u8 => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
export const fp = u8 => u8 ? hexs(u8.slice(0, 3)) + "…" + hexs(u8.slice(-1)) : "—";
const cat = (...a) => { let n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n), k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

// base64 (bytes <-> string, p/ JSON). Em blocos: espalhar um array enorme com
// String.fromCharCode(...u8) rebenta a pilha (fotos de vários MB).
export const b64 = u8 => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ---- primitivas ----
export async function genX() { const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]); return { kp, pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) }; }
export async function genEd() { const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); return { kp, pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) }; }
export async function dh(my, peerPub) { const peer = await crypto.subtle.importKey("raw", peerPub, { name: "X25519" }, false, []); return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, my.kp.privateKey, 256)); }
export async function edSign(my, data) { return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, my.kp.privateKey, data)); }
export async function edVerify(pub, sig, data) { try { const k = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, data); } catch { return false; } }

async function hmac(key, msg) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(msg))); }
async function hkdf(ikm, salt, info, len = 64) { const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]); return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, k, len * 8)); }
async function kdfRK(rk, d) { const o = await hkdf(d, rk, "DR_ROOT"); return { rk: o.slice(0, 32), ck: o.slice(32, 64) }; }
async function kdfCK(ck) { return { ck: await hmac(ck, [0x02]), mk: await hmac(ck, [0x01]) }; }
const adOf = h => enc.encode([...h.dh].join(",") + "|" + h.pn + "|" + h.n);
async function aesEnc(mk, pt, a) { const key = await crypto.subtle.importKey("raw", mk, { name: "AES-GCM" }, false, ["encrypt"]); const iv = rand(12); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: a }, key, enc.encode(pt))); return { iv, ct }; }
async function aesDec(mk, iv, ct, a) { const key = await crypto.subtle.importKey("raw", mk, { name: "AES-GCM" }, false, ["decrypt"]); return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: a }, key, ct)); }

// ---- X3DH ----
const F = new Uint8Array(32).fill(0xFF); // separação de domínio curve25519
async function kdfSK(km) { const k = await crypto.subtle.importKey("raw", km, "HKDF", false, ["deriveBits"]); return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("X3DH") }, k, 256)); }

// Iniciador (quem começa a conversa). Verifica a assinatura da SPK e deriva o SK.
// bundle: { ik, ikSig, spk, spkSig, opk:{id,pub} | null }
export async function x3dhInitiator(myIK, bundle) {
  const ok = await edVerify(bundle.ikSig, bundle.spkSig, bundle.spk);
  if (!ok) throw new Error("assinatura da SPK inválida — possível MITM");
  const EK = await genX();
  const dh1 = await dh(myIK, bundle.spk);
  const dh2 = await dh(EK, bundle.ik);
  const dh3 = await dh(EK, bundle.spk);
  const parts = [F, dh1, dh2, dh3];
  if (bundle.opk) parts.push(await dh(EK, bundle.opk.pub));
  const SK = await kdfSK(cat(...parts));
  return { SK, EKpub: EK.pub, opkId: bundle.opk ? bundle.opk.id : null, theirSPK: bundle.spk };
}

// Recetor. Recompõe o mesmo SK. spkPriv/opkPriv são os keypairs guardados localmente.
export async function x3dhResponder(myIK, mySPK, opkPriv, initial) {
  const dh1 = await dh(mySPK, initial.ika);
  const dh2 = await dh(myIK, initial.eka);
  const dh3 = await dh(mySPK, initial.eka);
  const parts = [F, dh1, dh2, dh3];
  if (opkPriv) parts.push(await dh(opkPriv, initial.eka));
  return await kdfSK(cat(...parts));
}

// ---- Double Ratchet (estado seedado pelo SK do X3DH) ----
export async function initAlice(SK, theirSPKpub) {
  const DHs = await genX();
  const r = await kdfRK(SK, await dh(DHs, theirSPKpub));
  return { RK: r.rk, DHs, DHr: theirSPKpub, CKs: r.ck, CKr: null, Ns: 0, Nr: 0, PN: 0, MKSKIPPED: {} };
}
export function initBob(SK, mySPKkeypair) {
  return { RK: SK, DHs: mySPKkeypair, DHr: null, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, MKSKIPPED: {} };
}
async function dhRatchet(s, header) {
  let RK = s.RK;
  let r1 = await kdfRK(RK, await dh(s.DHs, header.dh)); const CKr = r1.ck; RK = r1.rk;
  const DHs = await genX();
  let r2 = await kdfRK(RK, await dh(DHs, header.dh)); const CKs = r2.ck; RK = r2.rk;
  return { ...s, RK, DHs, DHr: header.dh, CKr, CKs, PN: s.Ns, Ns: 0, Nr: 0 };
}
export async function drEncrypt(s, pt) {
  const { ck, mk } = await kdfCK(s.CKs);
  const header = { dh: s.DHs.pub, pn: s.PN, n: s.Ns };
  const { iv, ct } = await aesEnc(mk, pt, adOf(header));
  return { state: { ...s, CKs: ck, Ns: s.Ns + 1 }, header, iv, ct };
}
const MAX_SKIP = 1000;       // teto de mensagens saltadas de uma vez (anti-abuso)
const MAX_STORED = 2000;     // teto de chaves guardadas à espera (limita memória)
const skipId = (dhPub, n) => b64(dhPub) + ":" + n;

// Avança a cadeia de receção até `until`, guardando as chaves das mensagens que
// faltam (para poderem ser usadas quando — ou se — essas mensagens chegarem).
async function skipMessageKeys(st, until) {
  if (st.CKr === null) return st;
  if (until - st.Nr > MAX_SKIP) throw new Error("demasiadas mensagens saltadas");
  const MKSKIPPED = { ...(st.MKSKIPPED || {}) };
  let CKr = st.CKr, Nr = st.Nr;
  while (Nr < until) {
    const { ck, mk } = await kdfCK(CKr);
    MKSKIPPED[skipId(st.DHr, Nr)] = mk;
    CKr = ck; Nr++;
  }
  const keys = Object.keys(MKSKIPPED);                    // limita o crescimento
  if (keys.length > MAX_STORED) for (const k of keys.slice(0, keys.length - MAX_STORED)) delete MKSKIPPED[k];
  return { ...st, CKr, Nr, MKSKIPPED };
}

export async function drDecrypt(s, header, iv, ct) {
  let st = s, ratcheted = false;

  // 1) é uma mensagem saltada que está a chegar agora? usa a chave guardada.
  const sid = skipId(header.dh, header.n);
  if (st.MKSKIPPED && st.MKSKIPPED[sid]) {
    const mk = st.MKSKIPPED[sid];
    const pt = await aesDec(mk, iv, ct, adOf(header));     // valida o tag antes de mexer no estado
    const MKSKIPPED = { ...st.MKSKIPPED }; delete MKSKIPPED[sid];
    return { state: { ...st, MKSKIPPED }, pt, ratcheted: false };
  }

  // 2) chave de DH nova: guarda o que falta da cadeia antiga e roda.
  if (st.DHr === null || !eq(header.dh, st.DHr)) {
    st = await skipMessageKeys(st, header.pn);
    st = await dhRatchet(st, header);
    ratcheted = true;
  }
  // 3) salta até esta mensagem na cadeia atual (guarda as intermédias).
  st = await skipMessageKeys(st, header.n);
  // 4) deriva a chave desta mensagem e avança.
  const { ck, mk } = await kdfCK(st.CKr);
  const pt = await aesDec(mk, iv, ct, adOf(header));
  st = { ...st, CKr: ck, Nr: st.Nr + 1 };
  return { state: st, pt, ratcheted };
}

// ---- Safety numbers (verificação de identidade) ----
// Impressão digital numérica derivada da chave de identidade + identificador,
// por hashing iterado (como o libsignal). O Signal usa 5200 iterações; reduzi
// para o demo ser instantâneo — a ideia é idêntica.
const sha512 = async b => new Uint8Array(await crypto.subtle.digest("SHA-512", b));
async function numericFingerprint(ikPub, identifier, iterations = 1024) {
  const ver = new Uint8Array([0, 0]);
  let h = await sha512(cat(ver, ikPub, enc.encode(identifier)));
  for (let i = 0; i < iterations; i++) h = await sha512(cat(h, ikPub));
  let digits = "";
  for (let g = 0; g < 6; g++) {            // 6 grupos de 5 dígitos = 30
    let n = 0; for (let k = 0; k < 5; k++) n = (n * 256 + h[g * 5 + k]) % 100000;
    digits += String(n).padStart(5, "0");
  }
  return digits; // 30 dígitos
}
// Número combinado (60 dígitos) — ordenado para os dois lados obterem o mesmo.
export async function safetyNumber(myIK, myId, peerIK, peerId) {
  const a = await numericFingerprint(myIK, myId);
  const b = await numericFingerprint(peerIK, peerId);
  const [x, y] = a < b ? [a, b] : [b, a];
  return x + y;
}
// formata 60 dígitos em 12 grupos de 5
export const formatSafety = s => s.replace(/(.{5})/g, "$1 ").trim();

// ---- Sender Keys (grupos) ----
// Cada membro tem uma "sender key": uma cadeia simétrica (forward secrecy, como
// na fase 1) + um par de assinatura Ed25519. A chave é partilhada pelo grupo,
// por isso cada mensagem é ASSINADA para se saber quem a mandou. A mensagem é
// cifrada uma vez e reenviada a todos (fan-out).
export async function groupSenderKey() { return { chainKey: rand(32), sign: await genEd() }; }
export async function groupSeal(chainKey, signKp, pt) {
  const { ck, mk } = await kdfCK(chainKey);
  const { iv, ct } = await aesEnc(mk, pt, new Uint8Array(0));
  const sig = await edSign(signKp, ct);
  return { chainKey: ck, iv, ct, sig };
}
export async function groupOpen(chainKey, signPub, iv, ct, sig) {
  if (!(await edVerify(signPub, sig, ct))) throw new Error("assinatura de grupo inválida");
  const { ck, mk } = await kdfCK(chainKey);
  const pt = await aesDec(mk, iv, ct, new Uint8Array(0));
  return { chainKey: ck, pt };
}
export async function groupAdvance(chainKey, steps) { // saltar mensagens em falta
  let ck = chainKey;
  for (let i = 0; i < steps; i++) ck = (await kdfCK(ck)).ck;
  return ck;
}
