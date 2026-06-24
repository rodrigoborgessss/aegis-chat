// Testa a autenticação: criar conta, duplicados, login certo/errado, validação,
// e o WebSocket a recusar ações sem token válido. Precisa do relay a correr.
import { WebSocket } from "ws";
const API = "http://localhost:8080";
const u = "authtest_" + Math.random().toString(36).slice(2, 8);
const post = (path, body) => fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, l) => { if (!c) fails++; console.log(`  ${c ? "\u2705" : "\u274c"}  ${l}`); };

let r = await post("/api/signup", { user: u, pass: "segredo123" });
let d = await r.json();
ok(r.status === 200 && !!d.token, "criar conta devolve token");

r = await post("/api/signup", { user: u, pass: "segredo123" });
ok(r.status === 409, "criar conta repetida é recusada");

r = await post("/api/login", { user: u, pass: "segredo123" });
const good = await r.json();
ok(r.status === 200 && !!good.token, "login com password certa devolve token");

r = await post("/api/login", { user: u, pass: "errada99" });
ok(r.status === 401, "login com password errada é recusado");

r = await post("/api/login", { user: "ghost" + Math.random().toString(36).slice(2, 7), pass: "segredo123" });
ok(r.status === 401, "login de user inexistente é recusado");

r = await post("/api/signup", { user: "A B", pass: "segredo123" });
ok(r.status === 400, "username inválido é recusado");

r = await post("/api/signup", { user: u + "z", pass: "123" });
ok(r.status === 400, "password curta é recusada");

const ws = new WebSocket("ws://localhost:8080");
await new Promise(res => ws.on("open", res));
let authErr = false, authed = false;
ws.on("message", m => { const x = JSON.parse(m); if (x.type === "authErr") authErr = true; if (x.type === "authed") authed = true; });
ws.send(JSON.stringify({ type: "register", bundle: { ik: "x", ikSig: "x", spk: "x", spkSig: "x", opks: [] } })); // sem auth
await wait(150);
ok(authErr, "WS recusa register sem autenticação");
ws.send(JSON.stringify({ type: "auth", token: good.token }));
await wait(150);
ok(authed, "WS aceita auth com token válido");
ws.close();

console.log(fails === 0 ? "\n\u2705 AUTH OK" : `\n\u274c ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
