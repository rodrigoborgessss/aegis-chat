// Confirma o aviso "available": quem pede o bundle de alguém ainda desconhecido
// fica à espera e é avisado mal essa pessoa entre. Tudo já autenticado.
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
const fakeBundle = { ik: "x", ikSig: "x", spk: "x", spkSig: "x", opks: [] };

const a = await connect("availa");
let gotAvailable = false;
a.on("message", d => { const m = JSON.parse(d); if (m.type === "available" && m.user === "availb") gotAvailable = true; });
a.send(JSON.stringify({ type: "register", bundle: fakeBundle }));
await wait(150);
a.send(JSON.stringify({ type: "fetchBundle", user: "availb" })); // ainda desconhecido -> fica à espera
await wait(150);

const b = await connect("availb");
b.send(JSON.stringify({ type: "register", bundle: fakeBundle }));
await wait(300);

console.log(gotAvailable ? "\u2705 AVISO 'available' RECEBIDO" : "\u274c não recebeu aviso");
a.close(); b.close(); process.exit(gotAvailable ? 0 : 1);
