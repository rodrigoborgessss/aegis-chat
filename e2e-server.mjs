// e2e contra o servidor real: dois clientes WS, X3DH + Double Ratchet pelo relay.
import * as Session from "./public/session.js";

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); },
  };
}

function client(name) {
  const store = memStore();
  const ws = new WebSocket("ws://localhost:8080");
  const pending = new Map(); const inbox = [];
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "bundle") { const r = pending.get(m.user); if (r) { pending.delete(m.user); r(m.bundle); } }
    else if (m.type === "deliver") { const d = await Session.decrypt(store, m.from, m.envelope); inbox.push({ from: m.from, text: d.plaintext }); }
  };
  const ready = new Promise(res => { ws.onopen = async () => { const bundle = await Session.buildBundle(store, 3); ws.send(JSON.stringify({ type: "register", user: name, bundle })); res(); }; });
  return {
    store, ready, inbox,
    fetch: u => new Promise(res => { pending.set(u, res); ws.send(JSON.stringify({ type: "fetchBundle", user: u })); }),
    sendTo: async (to, text) => {
      if (!await store.getSession(to)) { const b = await client._fetchVia(ws, pending, to); await Session.startSession(store, to, b); }
      const env = await Session.encrypt(store, to, text);
      ws.send(JSON.stringify({ type: "send", to, envelope: env }));
    },
    _ws: ws, _pending: pending,
  };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const alice = client("alice"), bob = client("bob");
  await Promise.all([alice.ready, bob.ready]);
  await wait(100);

  // Alice abre sessão com Bob (fetch + startSession) e envia
  const bobBundle = await alice.fetch("bob");
  await Session.startSession(alice.store, "bob", bobBundle);
  let env = await Session.encrypt(alice.store, "bob", "olá Bob, daqui Alice");
  alice._ws.send(JSON.stringify({ type: "send", to: "bob", envelope: env }));
  await wait(120);

  // Bob responde
  env = await Session.encrypt(bob.store, "alice", "recebido, daqui Bob");
  bob._ws.send(JSON.stringify({ type: "send", to: "alice", envelope: env }));
  await wait(120);

  // Alice de novo (ratchet)
  env = await Session.encrypt(alice.store, "bob", "boa, funciona!");
  alice._ws.send(JSON.stringify({ type: "send", to: "bob", envelope: env }));
  await wait(120);

  console.log("Bob recebeu:  ", bob.inbox.map(x => `"${x.text}"`).join(", "));
  console.log("Alice recebeu:", alice.inbox.map(x => `"${x.text}"`).join(", "));
  const ok = bob.inbox.length === 2 && bob.inbox[0].text === "olá Bob, daqui Alice" && bob.inbox[1].text === "boa, funciona!"
    && alice.inbox.length === 1 && alice.inbox[0].text === "recebido, daqui Bob";
  console.log(ok ? "\n✅ E2E PELO SERVIDOR REAL: OK" : "\n❌ E2E FALHOU");
  process.exit(ok ? 0 : 1);
})();
