// Simula "sair e voltar a entrar": grava o estado do grupo, recria o gestor a
// partir do guardado, e confirma que a conversa continua a decifrar.
import * as Session from "../public/session.js";
import { createGroupManager } from "../public/group.js";

function memStore() {
  let id = null, spk = null; const opks = new Map(), s = new Map();
  return {
    getIdentity: async () => id, setIdentity: async v => { id = v; },
    getSPK: async () => spk, setSPK: async v => { spk = v; },
    addOPK: async (k, v) => { opks.set(k, v); }, getOPK: async k => opks.get(k) || null, removeOPK: async k => { opks.delete(k); },
    getSession: async p => s.get(p) || null, setSession: async (p, v) => { s.set(p, v); },
  };
}
function makeRelay() {
  const c = {}, b = {};
  return {
    add: x => { c[x.name] = x; }, publish: (n, v) => { b[n] = v; },
    fetch: n => { const v = b[n]; if (!v) return null; const opk = v.opks.length ? v.opks.shift() : null; return { ik: v.ik, ikSig: v.ikSig, spk: v.spk, spkSig: v.spkSig, opk, dn: v.dn }; },
    deliver: async (to, from, env) => { if (c[to]) await c[to].onDeliver(from, env); },
  };
}
function makeClient(name, relay) {
  const store = memStore(); const log = []; const saved = new Map();
  const sendRaw = (to, env) => relay.deliver(to, name, env);
  async function sendPairwise(to, obj) { if (!await store.getSession(to)) { const b = relay.fetch(to); if (!b) return; await Session.startSession(store, to, b); } await sendRaw(to, await Session.encrypt(store, to, "\u0001" + JSON.stringify(obj))); }
  const mkGm = () => createGroupManager({
    me: name, sendPairwise, sendGroup: (to, grp) => sendRaw(to, { grp }), myDn: () => name,
    onMessage: (gid, from, dn, text) => log.push({ from, text }), onSystem: () => {},
    saveGroup: (gid, g) => saved.set(gid, g), deleteGroup: gid => saved.delete(gid),
  });
  const c = { name, store, log, saved, mkGm };
  c.gm = mkGm();
  c.onDeliver = async (from, env) => {
    if (env.grp) { await c.gm.handleGroupMessage(env.grp); return; }
    const d = await Session.decrypt(store, from, env);
    if (d.plaintext[0] === "\u0001") { const o = JSON.parse(d.plaintext.slice(1)); if (o.grpInvite) await c.gm.handleInvite(from, o.grpInvite); else if (o.skdm) await c.gm.handleSKDM(from, o.skdm); }
  };
  relay.add(c); return c;
}

(async () => {
  let fails = 0; const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };
  const relay = makeRelay();
  const alice = makeClient("alice", relay), bob = makeClient("bob", relay);
  for (const c of [alice, bob]) relay.publish(c.name, await Session.buildBundle(c.store, 6));

  await alice.gm.create("g", "Equipa", ["bob"]);
  await alice.gm.send("g", "antes do reload");
  check(bob.log.some(m => m.text === "antes do reload"), "bob recebeu antes do reload");

  // --- a Alice "sai e volta a entrar": novo gestor a partir do guardado ---
  console.log("\n** alice sai e volta a entrar (restore) **");
  const savedSnapshot = [...alice.saved.values()];
  alice.gm = alice.mkGm();
  alice.gm.restore(savedSnapshot);
  check(alice.gm.has("g") && alice.gm.members("g").length === 2, "grupo recuperado com os membros");

  await alice.gm.send("g", "depois do reload");
  check(bob.log.some(m => m.text === "depois do reload"), "bob recebe mensagem da alice já recuperada (cadeia continuou)");

  await bob.gm.send("g", "resposta do bob");
  check(alice.log.some(m => m.text === "resposta do bob"), "alice recuperada decifra o bob (sender key restaurada)");

  console.log(fails === 0 ? "\n✅ PERSISTÊNCIA OK" : `\n❌ ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
