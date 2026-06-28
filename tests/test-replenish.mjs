// Reposição de prekeys: quando as OPKs de A descem abaixo do limite, o servidor
// avisa A ("lowOPKs"); A gera e envia mais ("addOPKs"); o servidor passa a ter
// OPKs de novo. Tudo já autenticado.
import { WebSocket } from "ws";
const URL = "ws://localhost:8080", API = "http://localhost:8080", PW = "segredo123";

async function getToken(user) {
  let r = await fetch(`${API}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, pass: PW }) });
  if (r.status === 409) r = await fetch(`${API}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, pass: PW }) });
  return (await r.json()).token;
}
async function connect(user) {
  const token = await getToken(user);
  const ws = new WebSocket(URL);
  await new Promise(r => ws.on("open", r));
  const authed = new Promise(r => { const h = d => { if (JSON.parse(d).type === "authed") { ws.off("message", h); r(); } }; ws.on("message", h); });
  ws.send(JSON.stringify({ type: "auth", token }));
  await authed;
  return ws;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const opk = (i) => ({ id: "id" + i, pub: "pub" + i });

// A regista-se só com 2 OPKs para esgotar depressa
const a = await connect("repla");
let gotLow = false;
a.on("message", d => {
  const m = JSON.parse(d);
  if (m.type === "lowOPKs") { gotLow = true; a.send(JSON.stringify({ type: "addOPKs", opks: [opk(10), opk(11), opk(12), opk(13), opk(14)] })); }
});
a.send(JSON.stringify({ type: "register", bundle: { ik: "x", ikSig: "x", spk: "x", spkSig: "x", opks: [opk(1), opk(2)] } }));
await wait(150);

// B consome OPKs de A duas vezes -> desce abaixo de 2 -> dispara lowOPKs
const b = await connect("replb");
b.send(JSON.stringify({ type: "register", bundle: { ik: "x", ikSig: "x", spk: "x", spkSig: "x", opks: [] } }));
await wait(100);
let lastOpk = "init";
b.on("message", d => { const m = JSON.parse(d); if (m.type === "bundle" && m.user === "repla") lastOpk = m.bundle ? m.bundle.opk : null; });
b.send(JSON.stringify({ type: "fetchBundle", user: "repla" })); await wait(120); // resta 1 -> avisa
b.send(JSON.stringify({ type: "fetchBundle", user: "repla" })); await wait(250); // resta 0; A já repôs

// depois da reposição, B deve voltar a receber uma OPK
b.send(JSON.stringify({ type: "fetchBundle", user: "repla" })); await wait(200);
const refilled = lastOpk && lastOpk.id && lastOpk.id.startsWith("id1");

const ok = gotLow && refilled;
console.log(ok ? "\u2705 REPOSIÇÃO DE PREKEYS OK" : `\u274c falhou (low=${gotLow}, refilled=${!!refilled})`);
a.close(); b.close(); process.exit(ok ? 0 : 1);
