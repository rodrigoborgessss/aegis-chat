// Mensagens fora de ordem: o Double Ratchet tem de guardar as chaves das que
// faltam e decifrá-las quando chegam — na mesma cadeia e através de um ratchet
// de DH. Antes disto, qualquer reordenação dava OperationError no AES-GCM.
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

let fails = 0;
const ok = (c, l) => { if (!c) fails++; console.log(`  ${c ? "\u2705" : "\u274c"}  ${l}`); };

(async () => {
  const aS = memStore(), bS = memStore();
  publish("alice", await S.buildBundle(aS, 5));
  publish("bob", await S.buildBundle(bS, 5));
  await S.startSession(aS, "bob", fetchBundle("bob"));

  // Alice cifra 4. A 1.ª leva o X3DH e tem de chegar primeiro (estabelece a sessão).
  const e = [];
  for (const t of ["m1", "m2", "m3", "m4"]) e.push(await S.encrypt(aS, "bob", t));
  const got = [];
  for (const i of [0, 3, 1, 2]) got.push((await S.decrypt(bS, "alice", e[i])).plaintext); // m1, m4, m2, m3
  ok(got.join(",") === "m1,m4,m2,m3", "fora de ordem na mesma cadeia (m1,m4,m2,m3)");

  // Bob responde 3. Alice recebe-as fora de ordem — e a 1.ª que chega força um
  // ratchet de DH, com a anterior (n=0) a ser guardada e usada quando chega.
  const r = [];
  for (const t of ["r1", "r2", "r3"]) r.push(await S.encrypt(bS, "alice", t));
  const ro = [];
  for (const i of [1, 0, 2]) ro.push((await S.decrypt(aS, "bob", r[i])).plaintext); // r2, r1, r3
  ok(ro.join(",") === "r2,r1,r3", "fora de ordem através do ratchet de DH (r2,r1,r3)");

  // E continua coerente nos dois sentidos depois disto.
  ok((await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", "m5"))).plaintext === "m5", "continua a funcionar: alice -> bob");
  ok((await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", "r4"))).plaintext === "r4", "continua a funcionar: bob -> alice");

  console.log(fails === 0 ? "\u2705 FORA DE ORDEM OK" : `\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
