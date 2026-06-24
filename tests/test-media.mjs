// Anexos viajam como texto: "\u0002" + JSON com o base64. Este teste confirma
// que um payload de média (incluindo um base64 grande) atravessa o X3DH + Double
// Ratchet e é reconstruído tal e qual do outro lado.
import * as S from "../public/session.js";

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); },
  };
}
const server = new Map();
const publish = (u, b) => server.set(u, b);
const fetchBundle = u => { const b = server.get(u); const opk = b.opks.length ? b.opks.shift() : null; return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk }; };
const mediaPlaintext = m => "\u0002" + JSON.stringify(m);

let fails = 0;
const ok = (c, l) => { if (!c) fails++; console.log(`  ${c ? "\u2705" : "\u274c"}  ${l}`); };

(async () => {
  const aS = memStore(), bS = memStore();
  publish("alice", await S.buildBundle(aS, 3));
  publish("bob", await S.buildBundle(bS, 3));
  await S.startSession(aS, "bob", fetchBundle("bob"));

  // base64 grande (~2 MB de bytes => ~2.7 MB de base64) para garantir que o
  // caminho de cifra aguenta payloads grandes sem rebentar a pilha no base64.
  const data = Buffer.alloc(2 * 1024 * 1024, 0xAB).toString("base64");
  const media = { kind: "image", name: "foto.jpg", mime: "image/jpeg", data };

  const env = await S.encrypt(aS, "bob", mediaPlaintext(media));
  const { plaintext } = await S.decrypt(bS, "alice", env);
  ok(plaintext[0] === "\u0002", "chega marcado como média");
  const got = JSON.parse(plaintext.slice(1));
  ok(got.kind === "image" && got.name === "foto.jpg" && got.mime === "image/jpeg", "metadados intactos");
  ok(got.data === data, "base64 do anexo idêntico depois de decifrar");

  // e um áudio a seguir, na mesma sessão (ratchet continua a funcionar)
  const audio = { kind: "audio", name: "audio", mime: "audio/webm", data: Buffer.alloc(20 * 1024, 7).toString("base64") };
  const env2 = await S.encrypt(aS, "bob", mediaPlaintext(audio));
  const p2 = JSON.parse((await S.decrypt(bS, "alice", env2)).plaintext.slice(1));
  ok(p2.kind === "audio" && p2.data === audio.data, "segundo anexo (áudio) também ok");

  console.log(fails === 0 ? "\u2705 ANEXOS OK" : `\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
