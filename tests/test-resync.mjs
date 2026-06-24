// Simula uma sessão dessincronizada (um lado perde a sessão) e confirma que a
// recuperação — apagar a sessão local e reiniciar o X3DH — volta a pôr os dois
// lados a entenderem-se, em vez de ficar preso no "não há sessão".
import * as S from "../public/session.js";

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); }, delSession: async p => { sessions.delete(p); },
    _wipeSession: p => sessions.delete(p),
  };
}
const server = new Map();
const publish = (u, b) => server.set(u, b);
const fetchBundle = u => { const b = server.get(u); const opk = b.opks.length ? b.opks.shift() : null; return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk }; };

let fails = 0;
const ok = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };

// imita o recoverSession da app: apaga a sessão local e reinicia o X3DH
async function recover(store, peer) {
  await store.delSession(peer);
  await S.startSession(store, peer, fetchBundle(peer));
  return S.encrypt(store, peer, "\u0001{\"resync\":1}");
}

(async () => {
  const aS = memStore(), bS = memStore();
  publish("alice", await S.buildBundle(aS, 5));
  publish("bob", await S.buildBundle(bS, 5));

  await S.startSession(aS, "bob", fetchBundle("bob"));
  // troca normal
  ok((await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", "m1"))).plaintext === "m1", "troca normal antes da falha");
  ok((await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", "m2"))).plaintext === "m2", "resposta normal antes da falha");

  // DESYNC: alice perde a sessão (ex.: apagou a conversa de um lado só)
  aS._wipeSession("bob");

  // bob envia sem saber; alice não consegue decifrar
  let threw = false;
  try { await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", "vais falhar")); } catch { threw = true; }
  ok(threw, "sem recuperação, a mensagem do bob falha na alice");

  // recuperação: alice reabre a sessão e avisa o bob
  const resyncEnv = await recover(aS, "bob");
  const r = await S.decrypt(bS, "alice", resyncEnv); // bob adota a sessão nova
  ok(!r.ignored, "bob recebe o resync e refaz a sessão");

  // a partir daqui voltam a entender-se nos dois sentidos
  let after = 0;
  const aSend = async t => { try { return (await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", t))).plaintext; } catch { after++; return "ERRO"; } };
  const bSend = async t => { try { return (await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", t))).plaintext; } catch { after++; return "ERRO"; } };
  ok(await aSend("ok1") === "ok1", "alice -> bob depois de recuperar");
  ok(await bSend("ok2") === "ok2", "bob -> alice depois de recuperar");
  ok(await aSend("ok3") === "ok3", "alice -> bob outra vez");
  ok(after === 0, "nenhuma falha depois de recuperar");

  console.log(fails === 0 ? "\u2705 RECUPERACAO OK" : `\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
