// Grupos fora de ordem: a alice envia 4 mensagens; entregamo-las ao bob trocadas
// (2, 0, 3, 1). Com a cache de skipped keys, o bob abre todas, com o texto certo.
import * as Session from "../public/session.js";
import { createGroupManager } from "../public/group.js";

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); },
  };
}

const bundles = {};
const groupQueue = {};                                  // recetor -> [grp] (controlamos a ordem)
function makeClient(name) {
  const store = memStore(); const log = []; const sys = [];
  async function sendPairwise(to, obj) {
    if (!await store.getSession(to)) { const b = bundles[to]; if (!b) return; const opk = b.opks.length ? b.opks.shift() : null; await Session.startSession(store, to, { ...b, opk }); }
    const env = await Session.encrypt(store, to, "\u0001" + JSON.stringify(obj));
    await clients[to].onDeliver(name, env);
  }
  const sendGroup = (to, grp) => { (groupQueue[to] ||= []).push({ from: name, grp }); }; // não entrega já
  const gm = createGroupManager({
    me: name, sendPairwise, sendGroup, myDn: () => name,
    onMessage: (gid, from, dn, text) => log.push({ from, text }),
    onSystem: (gid, t) => sys.push(t),
  });
  async function onDeliver(from, env) {
    if (env.grp) { await gm.handleGroupMessage(env.grp); return; }
    const d = await Session.decrypt(store, from, env);
    if (d.plaintext[0] === "\u0001") {
      const c = JSON.parse(d.plaintext.slice(1));
      if (c.grpInvite) await gm.handleInvite(from, c.grpInvite);
      else if (c.skdm) await gm.handleSKDM(from, c.skdm);
    }
  }
  return { name, store, gm, log, sys, onDeliver };
}

const clients = {};
(async () => {
  let fails = 0;
  const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };
  const alice = makeClient("alice"), bob = makeClient("bob");
  clients.alice = alice; clients.bob = bob;
  bundles.alice = await Session.buildBundle(alice.store, 8);
  bundles.bob = await Session.buildBundle(bob.store, 8);

  await alice.gm.create("g1", "Equipa", ["bob"]);         // distribui sender keys via pairwise (entregue já)
  check(bob.gm.has("g1"), "bob entrou no grupo");

  const msgs = ["m0", "m1", "m2", "m3"];
  for (const t of msgs) await alice.gm.send("g1", t);      // ficam na fila do bob por ordem 0,1,2,3
  const q = groupQueue.bob;
  check(q.length === 4, "4 mensagens de grupo em fila para o bob");

  // entregar trocadas: 2, 0, 3, 1
  for (const i of [2, 0, 3, 1]) await bob.onDeliver(q[i].from, { grp: q[i].grp });

  const got = t => bob.log.some(m => m.text === t);
  check(got("m0") && got("m1") && got("m2") && got("m3"), "bob abriu as 4 mensagens apesar da ordem trocada");
  check(bob.log.length === 4, "sem duplicados nem perdidas (exatamente 4)");

  // reentregar uma já vista não deve duplicar
  await bob.onDeliver(q[0].from, { grp: q[0].grp });
  check(bob.log.length === 4, "reentrega da mesma mensagem é ignorada (anti-replay)");

  console.log(fails === 0 ? "\n\u2705 GRUPO FORA DE ORDEM OK" : `\n\u274c ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
