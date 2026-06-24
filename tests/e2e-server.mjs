// e2e contra o servidor real: dois clientes WS autenticados, X3DH + Double
// Ratchet pelo relay. Passa pela API de login (cria conta ou entra) e só depois
// abre a sessão WebSocket — espelha o que a app faz.
import * as Session from "../public/session.js";

const API = "http://localhost:8080";
const PW = "segredo123";
async function getToken(user) {
  let r = await fetch(`${API}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, pass: PW }) });
  if (r.status === 409) r = await fetch(`${API}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, pass: PW }) });
  return (await r.json()).token;
}

function memStore() {
  let identity = null, spk = null; const opks = new Map(), sessions = new Map();
  return {
    getIdentity: async () => identity, setIdentity: async i => { identity = i; },
    getSPK: async () => spk, setSPK: async s => { spk = s; },
    addOPK: async (id, kp) => { opks.set(id, kp); }, getOPK: async id => opks.get(id) || null, removeOPK: async id => { opks.delete(id); },
    getSession: async p => sessions.get(p) || null, setSession: async (p, s) => { sessions.set(p, s); },
  };
}

async function client(name) {
  const store = memStore();
  const token = await getToken(name);
  const ws = new WebSocket("ws://localhost:8080");
  const pending = new Map(); const inbox = [];
  let onAuthed; const authed = new Promise(r => (onAuthed = r));
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "authed") onAuthed();
    else if (m.type === "bundle") { const r = pending.get(m.user); if (r) { pending.delete(m.user); r(m.bundle); } }
    else if (m.type === "deliver") { const d = await Session.decrypt(store, m.from, m.envelope); inbox.push({ from: m.from, text: d.plaintext }); }
  };
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
  await authed;
  ws.send(JSON.stringify({ type: "register", bundle: await Session.buildBundle(store, 3) }));
  return {
    store, inbox, _ws: ws,
    fetch: u => new Promise(res => { pending.set(u, res); ws.send(JSON.stringify({ type: "fetchBundle", user: u })); }),
  };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const alice = await client("alice"), bob = await client("bob");
  await wait(120);

  const bobBundle = await alice.fetch("bob");
  await Session.startSession(alice.store, "bob", bobBundle);
  alice._ws.send(JSON.stringify({ type: "send", to: "bob", envelope: await Session.encrypt(alice.store, "bob", "olá Bob, daqui Alice") }));
  await wait(120);

  bob._ws.send(JSON.stringify({ type: "send", to: "alice", envelope: await Session.encrypt(bob.store, "alice", "recebido, daqui Bob") }));
  await wait(120);

  alice._ws.send(JSON.stringify({ type: "send", to: "bob", envelope: await Session.encrypt(alice.store, "bob", "boa, funciona!") }));
  await wait(120);

  console.log("Bob recebeu:  ", bob.inbox.map(x => `"${x.text}"`).join(", "));
  console.log("Alice recebeu:", alice.inbox.map(x => `"${x.text}"`).join(", "));
  const ok = bob.inbox.length === 2 && bob.inbox[0].text === "olá Bob, daqui Alice" && bob.inbox[1].text === "boa, funciona!"
    && alice.inbox.length === 1 && alice.inbox[0].text === "recebido, daqui Bob";
  console.log(ok ? "\n\u2705 E2E PELO SERVIDOR REAL: OK" : "\n\u274c E2E FALHOU");
  process.exit(ok ? 0 : 1);
})();
