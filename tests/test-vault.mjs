// Cofre: prova que serializar+cifrar+decifrar TODO o estado (que tem CryptoKey,
// Uint8Array, Map, Set) não parte a cripto. Cada valor escrito no store é cifrado
// e cada leitura é decifrada — exatamente como o store.js faz em repouso. Se o
// X3DH + Double Ratchet sobreviver a isto, a serialização está correta.
import * as S from "../public/session.js";
import * as R from "../public/ratchet.js";
import { encryptValue, decryptValue, pack, unpack } from "../public/vault.js";

const KEY = crypto.getRandomValues(new Uint8Array(32));

// store em memória onde cada valor é guardado CIFRADO e decifrado ao ler
function encStore() {
  const meta = new Map(), opks = new Map(), sessions = new Map();
  const put = async (m, k, v) => { m.set(k, await encryptValue(KEY, v)); };
  const get = async (m, k) => m.has(k) ? await decryptValue(KEY, m.get(k)) : null;
  return {
    getIdentity: () => get(meta, "id"), setIdentity: v => put(meta, "id", v),
    getSPK: () => get(meta, "spk"), setSPK: v => put(meta, "spk", v),
    addOPK: (id, kp) => put(opks, id, kp), getOPK: id => get(opks, id), removeOPK: async id => { opks.delete(id); },
    getSession: p => get(sessions, p), setSession: (p, v) => put(sessions, p, v),
  };
}

const server = new Map();
function fetchBundle(u) { const b = server.get(u); if (!b) return null; const opk = b.opks.length ? b.opks.shift() : null; return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk }; }

(async () => {
  let fails = 0;
  const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };

  // --- 1) round-trip cru de tipos especiais ---
  const kp = await R.genX();
  const rtKp = await unpack(await pack(kp));
  const peer = await R.genX();
  const s1 = await R.dh(kp, peer.pub), s2 = await R.dh(rtKp, peer.pub);
  check(R.b64(s1) === R.b64(s2), "CryptoKey privada sobrevive (ECDH dá o mesmo segredo)");

  const m = new Map([["a", new Uint8Array([1, 2, 3])], ["b", new Uint8Array([9])]]);
  const rtM = await unpack(await pack(m));
  check(rtM instanceof Map && R.b64(rtM.get("a")) === R.b64(m.get("a")), "Map<Uint8Array> sobrevive");
  const set = new Set(["alice", "bob"]);
  const rtSet = await unpack(await pack(set));
  check(rtSet instanceof Set && rtSet.has("alice") && rtSet.has("bob"), "Set sobrevive");

  // --- 2) fluxo completo X3DH + Double Ratchet através do store CIFRADO ---
  const aS = encStore(), bS = encStore();
  server.set("bob", await S.buildBundle(bS, 3));
  await S.startSession(aS, "bob", fetchBundle("bob"));

  const aliceSend = async t => (await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", t))).plaintext;
  const bobSend = async t => (await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", t))).plaintext;

  check(await aliceSend("olá bob") === "olá bob", "1ª mensagem (X3DH) decifra com store cifrado");
  check(await bobSend("olá alice") === "olá alice", "resposta vira o ratchet");
  check(await aliceSend("tudo bem?") === "tudo bem?", "continua depois da viragem");

  // fora de ordem (exercita o MKSKIPPED, que é um Map de Uint8Array dentro da sessão)
  const e1 = await S.encrypt(aS, "bob", "um");
  const e2 = await S.encrypt(aS, "bob", "dois");
  const d2 = await S.decrypt(bS, "alice", e2);       // chega o 2º primeiro
  const d1 = await S.decrypt(bS, "alice", e1);       // depois o 1º (chave saltada, em cache cifrada)
  check(d2.plaintext === "dois" && d1.plaintext === "um", "fora de ordem com skipped keys cifradas em repouso");

  console.log(fails === 0 ? "\n\u2705 COFRE OK" : `\n\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
