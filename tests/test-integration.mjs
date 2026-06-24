// Testa o fluxo completo (X3DH -> Double Ratchet) com store em memória e um
// "servidor" simulado que guarda bundles e consome OPKs. Sem sockets.
import * as S from "../public/session.js";

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); },
    _opksLeft: () => opks.size,
  };
}

const server = { bundles: new Map() };
const publish = (user, b) => server.bundles.set(user, b);
function fetchBundle(user) {
  const b = server.bundles.get(user); if (!b) return null;
  const opk = b.opks.length ? b.opks.shift() : null; // consome uma OPK
  return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk };
}

(async () => {
  const aS = memStore(), bS = memStore();
  let fails = 0;
  const check = (got, want, lbl) => { const ok = got === want; if (!ok) fails++; console.log(`  ${ok ? "OK " : "ERRO"}  ${lbl}: "${got}"${ok ? "" : ' (esperado "' + want + '")'}`); };

  // Bob publica o bundle e fica offline
  publish("bob", await S.buildBundle(bS, 3));
  console.log("Bob publicou bundle (3 OPKs).");

  // Alice descarrega o bundle do Bob e abre sessão
  const pb = fetchBundle("bob");
  await S.startSession(aS, "bob", pb);
  console.log("Alice abriu sessão; OPKs restantes no servidor:", server.bundles.get("bob").opks.length);

  // troca de mensagens: rajadas e viragens de sentido
  const aliceSend = async t => S.decrypt(bS, "alice", await S.encrypt(aS, "bob", t));
  const bobSend = async t => S.decrypt(aS, "bob", await S.encrypt(bS, "alice", t));

  console.log("\nTroca:");
  check((await aliceSend("olá Bob, sou a Alice")).plaintext, "olá Bob, sou a Alice", "A->B #1 (com X3DH)");
  check((await aliceSend("segunda seguida")).plaintext, "segunda seguida", "A->B #2 (mesma cadeia)");
  check((await bobSend("recebi as duas 👍")).plaintext, "recebi as duas 👍", "B->A #1 (ratchet DH)");
  check((await bobSend("e mais esta")).plaintext, "e mais esta", "B->A #2");
  check((await aliceSend("boa, e agora eu")).plaintext, "boa, e agora eu", "A->B #3 (ratchet DH)");
  check((await bobSend("combinado")).plaintext, "combinado", "B->A #3 (ratchet DH)");

  // verificação: OPK consumida do lado do Bob
  const opkConsumed = bS._opksLeft() === 2; // tinha 3, uma usada no handshake
  console.log("\nOPK consumida no handshake:", opkConsumed ? "OK" : "ERRO");
  if (!opkConsumed) fails++;

  console.log(fails === 0 ? "\n✅ FLUXO COMPLETO VÁLIDO" : `\n❌ ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
