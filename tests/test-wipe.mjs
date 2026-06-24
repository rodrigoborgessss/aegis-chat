// Reproduz "esquecer dispositivo": a Alice apaga tudo, volta com o mesmo nome
// (identidade NOVA) e tem de reabrir a conversa com o Bob.
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
const server = { bundles: new Map() };
const publish = (u, b) => server.bundles.set(u, b);
const fetchBundle = u => { const b = server.bundles.get(u); if (!b) return null; const opk = b.opks.length ? b.opks.shift() : null; return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk }; };

(async () => {
  let fails = 0;
  const check = (c, lbl, extra = "") => { if (!c) fails++; console.log(`  ${c ? "OK " : "ERRO"}  ${lbl}${extra ? " — " + extra : ""}`); };

  // --- antes do wipe: conversa normal ---
  let aS = memStore(); const bS = memStore();
  publish("bob", await S.buildBundle(bS, 3));
  await S.startSession(aS, "bob", fetchBundle("bob"));
  let r = await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", "olá antes do reset"));
  check(r.plaintext === "olá antes do reset", "conversa inicial funciona");
  r = await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", "tudo bem"));
  check(r.plaintext === "tudo bem", "resposta do Bob funciona");

  // --- WIPE: a Alice apaga o dispositivo. store nova e vazia, mesma alcunha ---
  aS = memStore();
  console.log("\n** Alice esqueceu o dispositivo (identidade nova) **");

  // a Alice tem de (re)iniciar: vai buscar o bundle do Bob e manda a 1.ª mensagem
  await S.startSession(aS, "bob", fetchBundle("bob"));
  r = await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", "voltei, sou eu outra vez"));
  check(r.plaintext === "voltei, sou eu outra vez", "Bob reabre a sessão e lê", "antes da correção isto falhava");
  check(r.identityChanged === true, "Bob deteta que a identidade da Alice mudou");

  // e a conversa continua nos dois sentidos
  r = await S.decrypt(aS, "bob", await S.encrypt(bS, "alice", "boa, recebi"));
  check(r.plaintext === "boa, recebi", "Bob -> Alice volta a funcionar");
  r = await S.decrypt(bS, "alice", await S.encrypt(aS, "bob", "e mais uma"));
  check(r.plaintext === "e mais uma", "Alice -> Bob continua");

  console.log(fails === 0 ? "\n✅ WIPE RESOLVIDO" : `\n❌ ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
