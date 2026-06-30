// server.js — relay "burro". Guarda bundles de prekeys, entrega uma OPK por
// pedido, e reencaminha envelopes (ciphertext opaco) entre clientes. Quando o
// destinatário está offline, guarda numa mailbox até ele aparecer.
// O servidor NUNCA vê chaves privadas nem texto em claro — só públicas, headers
// e ciphertext. Estado em memória: reiniciar o servidor limpa tudo.
import { createServer } from "http";
import { readFile } from "fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { extname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import * as auth from "./auth.js";
import { initVapid, vapidPublicKey, sendPush } from "./push.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.PORT || 8080;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

// --- ficheiros estáticos + API de autenticação ---
const USER_RE = /^[a-z0-9_]{2,20}$/;
const readJson = req => new Promise(resolve => { let d = ""; req.on("data", c => { d += c; if (d.length > 10000) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
const jsonRes = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(obj)); };

async function handleApi(req, res) {
  const body = await readJson(req);
  const u = (body.user || "").trim().toLowerCase();
  const pw = body.pass || "";
  if (req.url === "/api/logout") { if (body.token) auth.dropSession(body.token); return jsonRes(res, 200, { ok: true }); }
  if (req.url !== "/api/signup" && req.url !== "/api/login") return jsonRes(res, 404, { error: "não encontrado" });
  if (!USER_RE.test(u)) return jsonRes(res, 400, { error: "username inválido (2-20: minúsculas, números, _)" });
  if (pw.length < 6) return jsonRes(res, 400, { error: "palavra-passe com pelo menos 6 caracteres" });
  if (req.url === "/api/signup") {
    const r = auth.signup(u, pw);
    if (r.error) return jsonRes(res, 409, { error: r.error });
    log(`conta criada: ${u}`);
    return jsonRes(res, 200, { user: u, token: auth.createSession(u) });
  }
  if (!auth.verify(u, pw)) { log(`login falhado: ${u}`); return jsonRes(res, 401, { error: "username ou palavra-passe errados" }); }
  log(`login: ${u}`);
  return jsonRes(res, 200, { user: u, token: auth.createSession(u) });
}

const http = createServer(async (req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/")) { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "POST" && req.url.startsWith("/api/")) return handleApi(req, res);
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/") path = "/index.html";
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404).end("não encontrado"); }
});

// --- relay WebSocket ---
const wss = new WebSocketServer({ server: http });
// Bundles e mailbox persistem em disco para sobreviverem a reinícios do processo
// (em discos efémeros como o free tier do Render, perdem-se na hibernação — por
// isso o cliente também re-tenta sozinho de tempos a tempos).
const DATA = process.env.DATA_DIR || join(__dirname, "data");
try { mkdirSync(DATA, { recursive: true }); } catch {}
const BUNDLES_F = join(DATA, "bundles.json"), MAILBOX_F = join(DATA, "mailbox.json"), SUBS_F = join(DATA, "pushsubs.json");
const loadMap = f => { try { return new Map(Object.entries(JSON.parse(readFileSync(f, "utf8")))); } catch { return new Map(); } };
const saveMap = (f, m) => { try { writeFileSync(f, JSON.stringify(Object.fromEntries(m))); } catch (e) { console.error("guardar falhou", f, e.message); } };
const bundles = loadMap(BUNDLES_F); // nome -> bundle (público; sobrevive offline)
const online = new Map();     // nome -> ws (só quem está ligado agora)
const waiting = new Map();     // nome ainda desconhecido -> quem quer falar com ele
const mailbox = loadMap(MAILBOX_F); // nome -> [envelopes pendentes]
const pushSubs = loadMap(SUBS_F);   // nome -> [subscrições Web Push]
const saveBundles = () => saveMap(BUNDLES_F, bundles);
const saveMailbox = () => saveMap(MAILBOX_F, mailbox);
const saveSubs = () => saveMap(SUBS_F, pushSubs);
const VAPID_PUB = initVapid(join(DATA, "vapid.json")); // par estável em disco
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

// avisa (sem conteúdo) todas as subscrições de um utilizador offline; remove as mortas
async function notifyPush(user) {
  const subs = pushSubs.get(user); if (!subs || !subs.length) return;
  const alive = [], out = [];
  for (const s of subs) { const r = await sendPush(s); out.push(r.reason ? `${r.status}(${r.reason})` : `${r.status}`); if (r.status !== 404 && r.status !== 410) alive.push(s); }
  if (alive.length) pushSubs.set(user, alive); else pushSubs.delete(user);
  saveSubs();
  log(`push → ${user}: ${out.join(" , ")}`);
}

// log com hora local — só metadados (quem, para quem, tamanho do ciphertext);
// o servidor não tem acesso ao conteúdo, por isso nunca pode registá-lo.
const ts = () => new Date().toLocaleTimeString("pt-PT", { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

wss.on("connection", ws => {
  let me = null; // username autenticado (só fica definido depois de um token válido)
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "auth") {
      const u = auth.sessionUser(m.token);
      if (!u) { send(ws, { type: "authErr" }); return; }
      me = u; send(ws, { type: "authed", user: me });
      send(ws, { type: "pushKey", key: VAPID_PUB }); // para o cliente poder subscrever notificações
      return;
    }
    if (!me) { send(ws, { type: "authErr" }); return; } // tudo o resto exige sessão válida

    if (m.type === "register") {
      bundles.set(me, m.bundle); saveBundles(); // o servidor ignora qualquer username no pedido — usa o autenticado
      online.set(me, ws);
      send(ws, { type: "registered", user: me });
      const pending = mailbox.get(me) || [];
      log(`entrou: ${me}  (online: ${online.size})${pending.length ? `  — ${pending.length} msg(s) em espera` : ""}`);
      for (const env of pending) send(ws, { type: "deliver", from: env.from, envelope: env.envelope });
      mailbox.delete(me); saveMailbox();
      const waiters = waiting.get(me);
      if (waiters) { for (const w of waiters) { const wsock = online.get(w); if (wsock) send(wsock, { type: "available", user: me }); } waiting.delete(me); }
      return;
    }

    if (m.type === "fetchBundle") {
      const target = (m.user || "").toLowerCase();
      const b = bundles.get(target);
      if (!b) { log(`${me} pediu bundle de ${target} — desconhecido (fica à espera)`); if (!waiting.has(target)) waiting.set(target, new Set()); waiting.get(target).add(me); send(ws, { type: "bundle", user: target, bundle: null }); return; }
      const opk = (b.opks && b.opks.length) ? b.opks.shift() : null; // uso único, consumida
      if (opk) saveBundles();
      const left = b.opks ? b.opks.length : 0;
      log(`${me} pediu bundle de ${target}  (OPK ${opk ? "entregue" : "esgotada"}, restam ${left})`);
      send(ws, { type: "bundle", user: target, bundle: { ik: b.ik, ikSig: b.ikSig, spk: b.spk, spkSig: b.spkSig, opk, dn: b.dn } });
      if (left < 2) { const owner = online.get(target); if (owner) send(owner, { type: "lowOPKs", have: left }); } // pede reposição ao dono se estiver online
      return;
    }

    if (m.type === "addOPKs") {
      const b = bundles.get(me);
      if (b && Array.isArray(m.opks)) { b.opks = (b.opks || []).concat(m.opks).slice(-30); saveBundles(); log(`${me} repôs prekeys  (tem agora ${b.opks.length})`); }
      return;
    }

    if (m.type === "pushSub") {
      if (m.sub && m.sub.endpoint) {
        const subs = (pushSubs.get(me) || []).filter(s => s.endpoint !== m.sub.endpoint);
        subs.push(m.sub); pushSubs.set(me, subs.slice(-5)); saveSubs(); // no máximo 5 dispositivos
        log(`${me} subscreveu notificações (${pushSubs.get(me).length})`);
      }
      return;
    }
    if (m.type === "pushUnsub") {
      const subs = (pushSubs.get(me) || []).filter(s => s.endpoint !== m.endpoint);
      if (subs.length) pushSubs.set(me, subs); else pushSubs.delete(me);
      saveSubs();
      return;
    }

    if (m.type === "send") {
      const to = (m.to || "").toLowerCase();
      const size = m.envelope?.dr?.ct ? m.envelope.dr.ct.length : 0;
      const dest = online.get(to);
      if (dest) { send(dest, { type: "deliver", from: me, envelope: m.envelope }); log(`${me} → ${to}: cifrado (${size} B)${m.envelope.x3dh ? " [+X3DH]" : ""}`); }
      else { if (!mailbox.has(to)) mailbox.set(to, []); mailbox.get(to).push({ from: me, envelope: m.envelope }); saveMailbox(); notifyPush(to); log(`${me} → ${to}: cifrado (${size} B) — ${to} offline, guardado na mailbox`); }
      return;
    }
  });

  ws.on("close", () => { if (me && online.get(me) === ws) { online.delete(me); log(`saiu: ${me}  (online: ${online.size})`); } });
});

http.listen(PORT, () => console.log(`relay em http://localhost:${PORT}  (abre em dois separadores)`));
