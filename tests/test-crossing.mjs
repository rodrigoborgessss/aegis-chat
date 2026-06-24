// Testa iniciação simultânea: alice e bob abrem sessão um para o outro ao mesmo
// tempo (cruzamento). Antes do fix, ficavam com sessões diferentes e deixavam de
// se entender ("chegou algo... não há sessão"). Agora há desempate determinístico.
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
const ok = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };

(async () => {
  const aS = memStore(), bS = memStore();
  publish("alice", await S.buildBundle(aS, 3));
  publish("bob", await S.buildBundle(bS, 3));

  // cruzamento: ambos abrem sessão antes de receber o X3DH um do outro
  await S.startSession(aS, "bob", fetchBundle("bob"));
  await S.startSession(bS, "alice", fetchBundle("alice"));

  // ambos cifram a 1.ª mensagem (cada uma leva o seu X3DH)
  const Ea1 = await S.encrypt(aS, "bob", "ola do alice");
  const Eb1 = await S.encrypt(bS, "alice", "ola do bob");

  // entrega cruzada
  const rb = await S.decrypt(bS, "alice", Ea1); // bob recebe do alice
  const ra = await S.decrypt(aS, "bob", Eb1);   // alice recebe do bob

  const ignoredCount = (rb.ignored ? 1 : 0) + (ra.ignored ? 1 : 0);
  ok(ignoredCount === 1, "exatamente um lado ignora o X3DH cruzado (desempate)");
  const delivered = [rb, ra].find(r => !r.ignored);
  ok(delivered && (delivered.plaintext === "ola do alice" || delivered.plaintext === "ola do bob"), "o lado vencedor decifra a 1.ª mensagem do par");

  // a partir daqui têm de se entender nos dois sentidos, várias rondas
  let crossFails = 0;
  const aSend = async t => { try { const r = await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", t)); return r.ignored ? null : r.plaintext; } catch { crossFails++; return "ERRO"; } };
  const bSend = async t => { try { const r = await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", t)); return r.ignored ? null : r.plaintext; } catch { crossFails++; return "ERRO"; } };

  ok(await aSend("a2") === "a2", "alice -> bob: a2");
  ok(await bSend("b2") === "b2", "bob -> alice: b2");
  ok(await aSend("a3") === "a3", "alice -> bob: a3");
  ok(await bSend("b3") === "b3", "bob -> alice: b3");
  ok(await bSend("b4") === "b4", "bob -> alice: b4 (rajada)");
  ok(await bSend("b5") === "b5", "bob -> alice: b5 (rajada)");
  ok(await aSend("a4") === "a4", "alice -> bob: a4 (vira o sentido)");
  ok(crossFails === 0, "nenhuma falha de decifragem depois de convergir");

  console.log(fails === 0 ? "\u2705 CRUZAMENTO RESOLVIDO" : `\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
