// Testa grupos (Sender Keys): criação a 3, troca de mensagens, e saída de um
// membro com rotação de chaves a trancá-lo fora. Usa relay simulado + as
// sessões 1-para-1 reais para distribuir as sender keys.
import * as Session from "../public/session.js";
import * as R from "../public/ratchet.js";
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
function makeRelay() {
  const clients = {}, bundles = {};
  return {
    add: c => { clients[c.name] = c; },
    publish: (n, b) => { bundles[n] = b; },
    fetch: n => { const b = bundles[n]; if (!b) return null; const opk = b.opks.length ? b.opks.shift() : null; return { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk, dn: b.dn }; },
    deliver: async (to, from, env) => { if (clients[to]) await clients[to].onDeliver(from, env); },
  };
}
function makeClient(name, relay) {
  const store = memStore(); const log = [];
  const sendRaw = (to, env) => relay.deliver(to, name, env);
  async function sendPairwise(to, obj) {
    if (!await store.getSession(to)) { const b = relay.fetch(to); if (!b) return; if (b.dn) {} await Session.startSession(store, to, b); }
    const env = await Session.encrypt(store, to, "\u0001" + JSON.stringify(obj));
    await sendRaw(to, env);
  }
  const sendGroup = (to, grp) => sendRaw(to, { grp });
  const gm = createGroupManager({
    me: name, sendPairwise, sendGroup, myDn: () => name,
    onMessage: (gid, from, dn, text, mine) => log.push({ gid, from, text }),
    onSystem: () => {},
  });
  async function onDeliver(from, env) {
    if (env.grp) { await gm.handleGroupMessage(env.grp); return; }
    const d = await Session.decrypt(store, from, env);
    if (d.plaintext[0] === "\u0001") {
      const c = JSON.parse(d.plaintext.slice(1));
      if (c.grpInvite) await gm.handleInvite(from, c.grpInvite);
      else if (c.skdm) await gm.handleSKDM(from, c.skdm);
      else if (c.grpLeave) await gm.handleLeave(from, c.grpLeave);
      else if (c.grpAdd) await gm.handleAdd(from, c.grpAdd);
    }
  }
  const c = { name, store, gm, log, onDeliver };
  relay.add(c); return c;
}

(async () => {
  let fails = 0;
  const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };
  const relay = makeRelay();
  const alice = makeClient("alice", relay), bob = makeClient("bob", relay), carol = makeClient("carol", relay);
  for (const c of [alice, bob, carol]) relay.publish(c.name, await Session.buildBundle(c.store, 8));

  // --- criar grupo a 3 ---
  await alice.gm.create("g1", "Equipa", ["bob", "carol"]);
  check(bob.gm.has("g1") && carol.gm.has("g1"), "bob e carol entraram no grupo");
  check(alice.gm.members("g1").length === 3, "alice vê 3 membros");

  // --- toda a gente envia, toda a gente recebe ---
  await alice.gm.send("g1", "olá equipa");
  await bob.gm.send("g1", "oi, daqui o bob");
  await carol.gm.send("g1", "carol presente");
  const got = (c, t) => c.log.some(m => m.text === t);
  check(got(bob, "olá equipa") && got(carol, "olá equipa"), "msg da alice chegou aos dois");
  check(got(alice, "oi, daqui o bob") && got(carol, "oi, daqui o bob"), "msg do bob chegou aos dois");
  check(got(alice, "carol presente") && got(bob, "carol presente"), "msg da carol chegou aos dois");

  // --- carol sai: alice e bob rodam as chaves ---
  console.log("\n** carol sai do grupo **");
  await carol.gm.leave("g1");
  check(!alice.gm.members("g1").includes("carol"), "alice removeu a carol");
  check(!carol.gm.has("g1"), "carol já não tem o grupo");

  const before = carol.log.length;
  await alice.gm.send("g1", "agora só nós os dois");
  check(got(bob, "agora só nós os dois"), "bob continua a receber (recebeu a chave nova)");
  check(carol.log.length === before, "carol não recebeu nada (fora do fan-out)");

  // --- e mesmo que interceptasse: a rotação cripto tranca-a fora ---
  console.log("\n** prova da rotação (nível cripto) **");
  const skOld = await R.groupSenderKey();
  const m1 = await R.groupSeal(skOld.chainKey, skOld.sign, "antes da rotação");
  const o1 = await R.groupOpen(skOld.chainKey, skOld.sign.pub, m1.iv, m1.ct, m1.sig);
  check(o1.pt === "antes da rotação", "com a chave certa abre");
  const skNew = await R.groupSenderKey();              // rotação
  const m2 = await R.groupSeal(skNew.chainKey, skNew.sign, "depois da rotação");
  let locked = false;
  try { await R.groupOpen(skOld.chainKey, skOld.sign.pub, m2.iv, m2.ct, m2.sig); } catch { locked = true; }
  check(locked, "com a chave antiga NÃO abre a mensagem pós-rotação");

  console.log(fails === 0 ? "\n✅ GRUPOS OK" : `\n❌ ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
