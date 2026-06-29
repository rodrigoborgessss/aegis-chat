// app.js — interface (estilo Signal): username (login) + nome público alterável,
// e mensagens temporárias por conversa. A lógica de cripto/sessão é a mesma.
import { createStore, wipe } from "./store.js";
import * as Session from "./session.js";
import { safetyNumber, groupSafetyNumber, formatSafety, unb64 } from "./ratchet.js";
import { createGroupManager } from "./group.js";
import { dmWinner } from "./dmsync.js";
import { deriveVaultKey, newSalt, makeVerifier, checkVerifier, vb64, vunb64 } from "./vault.js";

const $ = id => document.getElementById(id);
// Foca um input só com rato/teclado. No telemóvel — e em especial no PWA em
// standalone no iOS — focar por código deixa o campo "focado sem teclado": o
// toque seguinte não muda o foco e o teclado nunca abre. Em touch deixamos o
// utilizador tocar no campo (foco genuíno -> teclado abre).
const softFocus = el => { if (el && window.matchMedia && window.matchMedia("(pointer:fine)").matches) el.focus(); };

// Endereço do servidor. Na WEB (servida pelo próprio servidor, ou PWA) usa
// caminhos relativos e o host atual. EMPACOTADA numa app nativa (Capacitor), os
// assets correm de uma origem local — o location.host é "localhost", não o
// servidor — por isso o relay/API têm de apontar para o host remoto fixo.
const REMOTE = "https://aegis-chat-rvk2.onrender.com"; // <-- o teu servidor
const PACKAGED = !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
const API_BASE = PACKAGED ? REMOTE : "";
const WS_URL = PACKAGED
  ? REMOTE.replace(/^http/, "ws")
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

let store, ws, username = null, displayName = null, activePeer = null, gm = null;
const threads = new Map();        // chave (username ou "#gid") -> [msgs]
const pendingBundle = new Map();
const verified = new Map();
const convos = new Map();
const peerNames = new Map();
const dmTimer = new Map();
const dmAt = new Map(); // peer -> timestamp da última alteração ao temporizador (última ganha)
const contacts = new Set();
const peerPhotos = new Map();      // username -> dataURL da foto
const profileSentTo = new Set();   // a quem já enviei o meu perfil nesta sessão
let ngSelected = new Set();         // membros selecionados ao criar grupo
const pendingMsgs = new Map();      // peer -> [msg em espera que a pessoa entre]

// ---- helpers ----
const AV = ["#5B6CF0", "#4FC3D9", "#C98BDB", "#E0A24E", "#34B98A", "#DB5C45", "#9b8cf0"];
const avColor = n => AV[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
const initial = n => (n[0] === "#" ? n[1] : n[0] || "?").toUpperCase();
const isGroup = k => k.startsWith("#");
const gidOf = k => k.slice(1);
const fmtTime = t => new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const displayOf = peer => isGroup(peer) ? (gm ? gm.name(gidOf(peer)) : peer) : (peerNames.get(peer) || peer);
const persistThread = key => store && store.saveThread(key, threads.get(key) || []);
const persistKv = () => store && store.setKv("appmeta", { peerNames: Object.fromEntries(peerNames), dmTimer: Object.fromEntries(dmTimer), dmAt: Object.fromEntries(dmAt), verified: Object.fromEntries(verified), contacts: [...contacts], photos: Object.fromEntries(peerPhotos) });
function avatarOf(key, size = 42) {
  const photo = !isGroup(key) ? peerPhotos.get(key) : null;
  if (photo) return `<img class="avatar" src="${photo}" style="width:${size}px;height:${size}px">`;
  return `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${avColor(key)}">${esc(initial(displayOf(key)))}</div>`;
}
function setAvatarEl(el, key) {
  const photo = !isGroup(key) ? peerPhotos.get(key) : null;
  if (photo) { el.textContent = ""; el.style.background = `center/cover url(${photo})`; }
  else { el.textContent = initial(displayOf(key)); el.style.background = avColor(key); }
}
const dmLabel = s => ({ 0: "desligado", 10: "10 segundos", 60: "1 minuto", 300: "5 minutos" }[s] || s + "s");
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2600); }

// ---- ligação ----
let authToken = null, entered = false, pendingFirstTime = false, vapidKey = null;

// Web Push: converte a chave pública VAPID (base64url) em bytes para o subscribe
const urlB64ToBytes = s => {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
async function swReg() { return ("serviceWorker" in navigator) ? navigator.serviceWorker.ready : null; }
// pedido EXPLÍCITO (a partir das definições): pede permissão e subscreve
async function enablePush() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) { toast("notificações não suportadas neste dispositivo"); return false; }
  if (!vapidKey) { toast("ainda a ligar ao servidor — tenta daqui a pouco"); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("permissão de notificações negada"); return false; }
  try {
    const reg = await swReg(); if (!reg) return false;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidKey) });
    ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "pushSub", sub: sub.toJSON() }));
    localStorage.setItem("aegis-push", "1");
    toast("notificações ativadas");
    return true;
  } catch (e) { console.error("subscribe falhou", e); toast("não consegui ativar as notificações"); return false; }
}
// na reconexão, se já houver permissão, reenvia a subscrição (mantém o servidor a par)
async function maybeResubscribePush() {
  if (localStorage.getItem("aegis-push") !== "1" || Notification.permission !== "granted" || !vapidKey) return;
  try {
    const reg = await swReg(); if (!reg) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidKey) });
    ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "pushSub", sub: sub.toJSON() }));
  } catch (e) { console.error("resubscribe falhou", e); }
}
async function disablePush() {
  localStorage.removeItem("aegis-push");
  try {
    const reg = await swReg(); if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "pushUnsub", endpoint: sub.endpoint })); await sub.unsubscribe(); }
  } catch {}
  toast("notificações desativadas");
}
function register() {
  if (!ws || ws.readyState !== 1) return;
  Session.buildBundle(store, 5)
    .then(bundle => { bundle.dn = displayName; ws.send(JSON.stringify({ type: "register", bundle })); })
    .catch(err => { console.error("falha a publicar chaves:", err); setTimeout(register, 3000); });
}
let lastOPKtop = 0;
async function replenishOPKs() {
  if (!ws || ws.readyState !== 1 || !store) return;
  const now = Date.now();
  if (now - lastOPKtop < 5000) return; // no máximo uma reposição a cada 5s
  lastOPKtop = now;
  try {
    const opks = await Session.genOPKs(store, 5);
    ws.send(JSON.stringify({ type: "addOPKs", opks }));
  } catch (err) { console.error("falha a repor prekeys:", err); }
}
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: authToken }));
  ws.onclose = () => { if (authToken) setTimeout(connect, 1500); };
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.type === "authed") { if (!entered) await enterApp(m.user); else register(); }
    else if (m.type === "registered") flushAllPending(); // (re)ligámos — tenta entregar o que ficou em espera
    else if (m.type === "authErr") handleAuthFail();
    else if (m.type === "bundle") { const r = pendingBundle.get(m.user); if (r) { pendingBundle.delete(m.user); r(m.bundle); } }
    else if (m.type === "available") flushPending(m.user);
    else if (m.type === "lowOPKs") await replenishOPKs();
    else if (m.type === "pushKey") { vapidKey = m.key; maybeResubscribePush(); }
    else if (m.type === "deliver") await onDeliver(m.from, m.envelope);
  };
}
function handleAuthFail() {
  localStorage.removeItem("aegis-auth");
  authToken = null; entered = false;
  try { ws && ws.close(); } catch {}
  $("app").classList.remove("ready"); $("login").style.display = "flex";
  $("loginErr").textContent = "a sessão expirou — entra outra vez.";
}
const fetchBundle = user => new Promise(res => { pendingBundle.set(user, res); ws.send(JSON.stringify({ type: "fetchBundle", user })); });

const sessionBuilding = new Map(); // peer -> Promise<bool> (evita criar 2 sessões em corrida)
async function ensureSession(peer) {
  if (await store.getSession(peer)) return true;
  if (sessionBuilding.has(peer)) return sessionBuilding.get(peer);
  const p = (async () => {
    try {
      if (await store.getSession(peer)) return true; // recheck dentro da trava
      const bundle = await fetchBundle(peer);
      if (!bundle) return false;
      if (bundle.dn) { peerNames.set(peer, bundle.dn); persistKv(); }
      await Session.startSession(store, peer, bundle);
      sendProfileTo(peer);
      return true;
    } catch (e) { console.warn("ensureSession falhou:", e?.name || e); return false; }
    finally { sessionBuilding.delete(peer); }
  })();
  sessionBuilding.set(peer, p);
  return p;
}

// ---- receber ----
async function onDeliver(from, envelope) {
  if (envelope.grp) { await gm.handleGroupMessage(envelope.grp); return; }
  ensureConvo(from);
  addContact(from);
  if (envelope.dn) { peerNames.set(from, envelope.dn); persistKv(); if (from === activePeer) updateHeader(); renderSidebar(); }
  try {
    const res = await Session.decrypt(store, from, envelope);
    if (res.ignored) return; // mensagem cruzada (iniciação simultânea) — ignorada em silêncio
    sendProfileTo(from); // só agora — a sessão (de recetor) já existe, não cria sessão em corrida
    const { plaintext, ratcheted, identityChanged } = res;
    if (identityChanged) { verified.delete(from); persistKv(); if (from === activePeer) updateHeader(); pushSys(from, `⚠ a identidade de ${displayOf(from)} mudou (dispositivo reposto). Verifica de novo o número de segurança.`); }
    if (plaintext[0] === "\u0001") { await handleControl(from, plaintext.slice(1)); return; }
    clearActivity(from);
    if (plaintext[0] === "\u0002") { const md = JSON.parse(plaintext.slice(1)); pushMsg(from, { me: false, kind: md.kind, name: md.name, mime: md.mime, data: md.data, time: Date.now() }); return; }
    pushMsg(from, { me: false, text: plaintext, ratcheted, time: Date.now() });
  } catch (e) { console.warn("não decifrou (sessão dessincronizada), a reabrir:", e?.name || e); await recoverSession(from); }
}
// Quando uma sessão dessincroniza (não dá para decifrar), apagamos a nossa e
// reiniciamos o X3DH. O par adota a sessão nova e voltam a entender-se. Guarda
// de tempo para não entrar em ciclo se ambos os lados falharem ao mesmo tempo.
const lastResync = new Map();
async function recoverSession(peer) {
  if (isGroup(peer)) return;
  const now = Date.now();
  if (now - (lastResync.get(peer) || 0) < 8000) return;
  lastResync.set(peer, now);
  try {
    await store.delSession(peer);
    profileSentTo.delete(peer);
    const reopened = await sendControl(peer, { resync: 1, dm: dmTimer.get(peer) || 0, dmAt: dmAt.get(peer) || 0 });
    if (reopened !== false) pushSys(peer, "a conversa tinha-se dessincronizado — reabri a sessão. Se faltou alguma mensagem, reenvia.");
  } catch (err) { console.error(err); }
}
async function handleControl(from, json) {
  let c; try { c = JSON.parse(json); } catch { return; }
  if (c.dm !== undefined) {
    if (applyDm(from, c.dm, c.dmAt || Date.now()))
      pushSys(from, c.dm > 0 ? `${displayOf(from)} ativou mensagens temporárias: ${dmLabel(c.dm)}.` : `${displayOf(from)} desligou as mensagens temporárias.`);
  }
  else if (c.grpInvite) await gm.handleInvite(from, c.grpInvite);
  else if (c.skdm) await gm.handleSKDM(from, c.skdm);
  else if (c.grpLeave) await gm.handleLeave(from, c.grpLeave);
  else if (c.grpAdd) await gm.handleAdd(from, c.grpAdd);
  else if (c.grpDm) {
    const k = "#" + c.grpDm.gid;
    if (applyDm(k, c.grpDm.secs, c.grpDm.at || Date.now()))
      pushSys(k, c.grpDm.secs > 0 ? `${displayOf(from)} ativou mensagens temporárias no grupo: ${dmLabel(c.grpDm.secs)}.` : `${displayOf(from)} desligou as mensagens temporárias do grupo.`);
  }
  else if (c.profile) {
    let changed = false;
    if (c.profile.dn) { peerNames.set(from, c.profile.dn); changed = true; }
    if (c.profile.photo !== undefined) { if (c.profile.photo) peerPhotos.set(from, c.profile.photo); else peerPhotos.delete(from); changed = true; }
    if (changed) { persistKv(); if (from === activePeer) updateHeader(); renderSidebar(); }
  }
  else if (c.clearChat) { clearChatLocal(from, true); }
  else if (c.grpClear) { clearChatLocal("#" + c.grpClear.gid, true); }
  else if (c.resync) { if (c.dm !== undefined) applyDm(from, c.dm, c.dmAt || 0); }
  else if (c.typing) showActivity(from, "typing");
  else if (c.recording !== undefined) { if (c.recording) showActivity(from, "recording"); else clearActivity(from); }
}
// ---- perfil (nome + foto) ----
function ownProfile() { return { photo: peerPhotos.get(username) || null, dn: displayName }; }
async function sendProfileTo(peer) {
  if (!peer || peer === username || isGroup(peer) || profileSentTo.has(peer)) return;
  profileSentTo.add(peer);
  try { await sendControl(peer, { profile: ownProfile() }); } catch { profileSentTo.delete(peer); }
}
function broadcastProfile() {
  profileSentTo.clear();
  const targets = new Set([...contacts]);
  for (const k of convos.keys()) if (!isGroup(k)) targets.add(k);
  for (const p of targets) sendProfileTo(p);
}
function onGroupMessage(gid, from, dn, text, mine) {
  if (!mine) { peerNames.set(from, dn); persistKv(); }
  const base = { me: mine, from, fromDn: dn, time: Date.now() };
  if (typeof text === "string" && text[0] === "\u0002") { const md = JSON.parse(text.slice(1)); pushMsg("#" + gid, { ...base, kind: md.kind, name: md.name, mime: md.mime, data: md.data }); }
  else pushMsg("#" + gid, { ...base, text });
}

// ---- enviar ----
const MEDIA_LIMIT = 2 * 1024 * 1024; // 2 MB por anexo
const VIDEO_LIMIT = 16 * 1024 * 1024; // vídeos podem ser maiores (gravados curtos)
const mediaPlaintext = m => "\u0002" + JSON.stringify({ kind: m.kind, name: m.name, mime: m.mime, data: m.data });

async function sendPayload(peer, plaintext, msg) {
  if (!await ensureSession(peer)) {
    msg.pending = true;
    pushMsg(peer, msg);
    if (!pendingMsgs.has(peer)) pendingMsgs.set(peer, []);
    pendingMsgs.get(peer).push({ plaintext, msg });
    return;
  }
  const envelope = await Session.encrypt(store, peer, plaintext);
  envelope.dn = displayName;
  ws.send(JSON.stringify({ type: "send", to: peer, envelope }));
  pushMsg(peer, msg);
}
function sendMessage(text) {
  if (!activePeer) return;
  sendPayload(activePeer, text, { me: true, text, time: Date.now() });
}
function sendMediaToPeer(peer, media) {
  if (!peer) return;
  if (isGroup(peer)) { gm.send(gidOf(peer), mediaPlaintext(media)); return; }
  sendPayload(peer, mediaPlaintext(media), { me: true, kind: media.kind, name: media.name, mime: media.mime, data: media.data, time: Date.now() });
}
function sendMediaMsg(media) { if (activePeer) sendMediaToPeer(activePeer, media); }
async function flushPending(peer) {
  const queue = pendingMsgs.get(peer);
  if (!queue || !queue.length) return;
  if (!await ensureSession(peer)) return;
  pendingMsgs.delete(peer);
  for (const { plaintext, msg } of queue) {
    const envelope = await Session.encrypt(store, peer, plaintext);
    envelope.dn = displayName;
    ws.send(JSON.stringify({ type: "send", to: peer, envelope }));
    msg.pending = false;
  }
  persistThread(peer);
  if (peer === activePeer) renderStream();
  renderSidebar();
}
// Re-tenta entregar tudo o que ficou em espera. Corre ao (re)ligar e num temporizador,
// para auto-curar quando o aviso "available" se perde (ex.: servidor reiniciou no Render).
async function flushAllPending() {
  if (!ws || ws.readyState !== 1) return;
  for (const peer of [...pendingMsgs.keys()]) await flushPending(peer);
}

// ---- anexos ----
const blobToDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const splitDataURL = u => { const m = /^data:([^,]*);base64,(.*)$/s.exec(u || ""); if (!m) return null; const mime = (m[1] || "").split(";")[0] || "application/octet-stream"; return { mime, b64: m[2] }; };
const b64Bytes = b64 => Math.floor(b64.length * 0.75);

async function compressImage(file) {
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = URL.createObjectURL(file); });
  URL.revokeObjectURL(img.src);
  let maxDim = 1600, quality = 0.85;
  const render = () => {
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  };
  let out = render();
  for (let i = 0; i < 8 && b64Bytes(splitDataURL(out).b64) > MEDIA_LIMIT; i++) {
    if (quality > 0.5) quality -= 0.15; else maxDim = Math.round(maxDim * 0.8);
    out = render();
  }
  return { kind: "image", mime: "image/jpeg", data: splitDataURL(out).b64 };
}

async function fileToMedia(file) {
  if (file.type.startsWith("image/")) return await compressImage(file);
  const isVideo = file.type.startsWith("video/");
  const limit = isVideo ? VIDEO_LIMIT : MEDIA_LIMIT;
  if (file.size > limit) { toast(`ficheiro demasiado grande (máx. ${Math.round(limit / 1048576)} MB)`); return null; }
  const parts = splitDataURL(await blobToDataURL(file));
  if (!parts) { toast("não consegui ler o ficheiro"); return null; }
  const kind = isVideo ? "video" : file.type.startsWith("audio/") ? "audio" : "file";
  return { kind, name: file.name || (isVideo ? "video" : "ficheiro"), mime: parts.mime, data: parts.b64 };
}

async function handleFile(file) {
  if (!file || !activePeer) return;
  try { const m = await fileToMedia(file); if (m) sendMediaMsg(m); }
  catch { toast("não consegui anexar o ficheiro"); }
}

// captura da câmara a partir do painel inicial: escolhe-se o destino depois
let pendingSendMedia = null;
async function captureForPick(file) {
  if (!file) return;
  try { const m = await fileToMedia(file); if (m) openSendTo(m); }
  catch { toast("não consegui usar a captura"); }
}
function openSendTo(media) {
  pendingSendMedia = media;
  $("newConvPanel").classList.remove("open");
  const url = mediaUrl(media), p = $("sendToPreview");
  if (media.kind === "image") p.innerHTML = `<img src="${url}" alt="">`;
  else if (media.kind === "video") p.innerHTML = `<video src="${url}" controls muted></video>`;
  else p.innerHTML = `<div class="sendto-chip">${mediaLabel(media)}</div>`;
  const list = $("sendToList"), peers = new Set();
  for (const k of convos.keys()) peers.add(k);
  for (const u of contacts) peers.add(u);
  if (!peers.size) { list.innerHTML = '<div class="contacts-empty">Sem conversas nem contactos. Abre uma conversa primeiro.</div>'; }
  else {
    list.innerHTML = "";
    for (const u of peers) {
      const grp = isGroup(u);
      list.insertAdjacentHTML("beforeend",
        `<div class="contact" data-u="${esc(u)}">${avatarOf(u, 34)}<div class="info"><div class="n">${esc(displayOf(u))}</div><div class="h">${grp ? "grupo" : "@" + esc(u)}</div></div></div>`);
    }
    list.querySelectorAll(".contact").forEach(el => el.onclick = () => {
      const peer = el.dataset.u;
      $("sendToPanel").classList.remove("open");
      openPeer(peer);
      if (pendingSendMedia) { sendMediaToPeer(peer, pendingSendMedia); pendingSendMedia = null; }
    });
  }
  $("sendToPanel").classList.add("open");
}

let mediaRecorder = null, recChunks = [], recording = false;
let recPingTimer = null, recPeer = null;
function startRecordingPings(peer) {
  recPeer = (!peer || isGroup(peer)) ? null : peer;
  if (!recPeer) return;
  const ping = () => { if (recPeer) sendControl(recPeer, { recording: 1 }).catch(() => {}); };
  ping();
  recPingTimer = setInterval(ping, 3000);
}
function stopRecordingPings() {
  if (recPingTimer) clearInterval(recPingTimer);
  recPingTimer = null;
  const p = recPeer; recPeer = null;
  if (p) sendControl(p, { recording: 0 }).catch(() => {});
}
async function toggleRecord() {
  if (recording) { try { mediaRecorder.stop(); } catch {} return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("gravação não suportada neste browser"); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recording = false; $("micBtn").classList.remove("recording"); stopRecordingPings();
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (!blob.size) return;
      if (blob.size > MEDIA_LIMIT) { toast("áudio demasiado grande (máx. 2 MB)"); return; }
      const parts = splitDataURL(await blobToDataURL(blob));
      if (!parts) { toast("não consegui processar o áudio"); return; }
      sendMediaMsg({ kind: "audio", name: "audio", mime: parts.mime, data: parts.b64 });
    };
    mediaRecorder.start();
    recording = true; $("micBtn").classList.add("recording"); toast("a gravar… toca outra vez para enviar");
    startRecordingPings(activePeer);
  } catch { toast("não consegui aceder ao microfone"); }
}
async function sendControl(peer, obj) {
  if (!await ensureSession(peer)) return false;
  const envelope = await Session.encrypt(store, peer, "\u0001" + JSON.stringify(obj));
  envelope.dn = displayName;
  ws.send(JSON.stringify({ type: "send", to: peer, envelope }));
  return true;
}

// ---- conversas / mensagens ----
function ensureConvo(peer) { if (!convos.has(peer)) { convos.set(peer, { unread: 0, ts: Date.now() }); renderSidebar(); } }
function scheduleExpiry(peer, msg, ms) {
  setTimeout(() => {
    const arr = threads.get(peer); if (!arr) return;
    const i = arr.indexOf(msg); if (i >= 0) { arr.splice(i, 1); persistThread(peer); if (peer === activePeer) renderStream(); renderSidebar(); }
  }, ms);
}
// arranca a contagem das mensagens RECEBIDAS de uma conversa — só quando são vistas
// (conversa aberta e separador visível). As que eu enviei contam desde o envio.
function startTtlCountdowns(peer) {
  if (!peer || document.hidden) return;
  const arr = threads.get(peer); if (!arr) return;
  let changed = false;
  for (const m of arr) if (!m.me && m.ttl && !m.expireAt) { m.expireAt = Date.now() + m.ttl * 1000; scheduleExpiry(peer, m, m.ttl * 1000); changed = true; }
  if (changed) { persistThread(peer); if (peer === activePeer) renderStream(); renderSidebar(); }
}
function pushMsg(peer, msg) {
  ensureConvo(peer);
  if (!threads.has(peer)) threads.set(peer, []);
  const secs = dmTimer.get(peer) || 0;
  if (secs > 0) {
    if (msg.me) { msg.expireAt = msg.time + secs * 1000; scheduleExpiry(peer, msg, secs * 1000); } // a minha cópia conta desde o envio
    else msg.ttl = secs; // recetor: a contagem só começa quando a mensagem for vista
  }
  threads.get(peer).push(msg);
  convos.get(peer).ts = msg.time || Date.now();
  persistThread(peer);
  if (peer === activePeer) { renderStream(); if (!msg.me && document.hidden) notifyIncoming(peer); }
  else if (!msg.me) { convos.get(peer).unread++; toast(`nova mensagem de ${displayOf(peer)}`); notifyIncoming(peer); }
  renderSidebar();
  if (!msg.me && peer === activePeer && !document.hidden) startTtlCountdowns(peer); // estou a ver -> arranca já
}
function pushSys(peer, text) {
  ensureConvo(peer);
  if (!threads.has(peer)) threads.set(peer, []);
  threads.get(peer).push({ sys: true, text });
  persistThread(peer);
  if (peer === activePeer) renderStream(); else toast(text);
}

// ---- render ----
function renderSidebar() {
  const list = $("convoList");
  if (!convos.size) { list.innerHTML = '<div class="empty">Sem conversas. Adiciona um contacto acima.</div>'; return; }
  list.innerHTML = "";
  const ordered = [...convos].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  for (const [peer, info] of ordered) {
    const th = threads.get(peer) || [];
    const last = [...th].reverse().find(m => !m.sys);
    const preview = last ? (last.me ? "tu: " : "") + (last.kind ? mediaLabel(last) : last.text) : "nova conversa";
    list.insertAdjacentHTML("beforeend", `
      <div class="convo ${peer === activePeer ? "active" : ""}" data-peer="${esc(peer)}">
        ${avatarOf(peer)}
        <div class="body"><div class="name">${esc(displayOf(peer))}</div><div class="preview">${esc(preview)}</div></div>
        ${info.unread ? `<div class="unread">${info.unread}</div>` : ""}
      </div>`);
  }
  list.querySelectorAll(".convo").forEach(el => el.onclick = () => openPeer(el.dataset.peer));
}
function updateHeader() {
  const grp = isGroup(activePeer);
  $("peerName").textContent = displayOf(activePeer);
  setAvatarEl($("peerAvatar"), activePeer);
  $("verifyBtn").style.display = grp ? "none" : "grid";
  $("dmBtn").style.display = "grid";
  $("groupBtn").style.display = grp ? "grid" : "none";
  if (grp) {
    $("verifiedBadge").style.display = "none";
    const s = dmTimer.get(activePeer) || 0;
    $("dmBtn").classList.toggle("on", s > 0);
    const n = gm.members(gidOf(activePeer)).length;
    $("peerStatus").textContent = s > 0 ? `grupo · ${n} membros · ⏱ ${dmLabel(s)}` : `grupo · ${n} membros`;
    return;
  }
  $("verifiedBadge").style.display = verified.get(activePeer) ? "inline" : "none";
  $("verifyBtn").classList.toggle("on", !!verified.get(activePeer));
  const s = dmTimer.get(activePeer) || 0;
  $("dmBtn").classList.toggle("on", s > 0);
  $("peerStatus").textContent = s > 0 ? `mensagens temporárias · ${dmLabel(s)}` : "encriptado ponta-a-ponta";
}
// ---- "a escrever…" (bolha no fundo da conversa) ----
// ---- indicador de atividade: "a escrever…" / "a gravar áudio…" (bolha no fundo) ----
const activityTimers = new Map();
const activityKind = new Map(); // peer -> 'typing' | 'recording'
function activityBubbleHTML(kind) {
  if (kind === "recording")
    return `<div class="row them" id="typingRow"><div class="typing-bubble recording"><span class="act-mic">🎤</span><span class="eq"><i></i><i></i><i></i><i></i></span><span class="act-label">a gravar áudio…</span></div></div>`;
  return `<div class="row them" id="typingRow"><div class="typing-bubble"><span class="dots"><span></span><span></span><span></span></span></div></div>`;
}
function showActivityBubble(kind) {
  const s = $("stream"); if (!s) return;
  hideActivityBubble();
  s.insertAdjacentHTML("beforeend", activityBubbleHTML(kind));
  s.scrollTop = s.scrollHeight;
}
function hideActivityBubble() { const el = document.getElementById("typingRow"); if (el) el.remove(); }
function maybeShowActivity() { if (activePeer && !isGroup(activePeer) && activityTimers.has(activePeer)) showActivityBubble(activityKind.get(activePeer)); }
function showActivity(peer, kind) {
  if (isGroup(peer)) return;
  clearTimeout(activityTimers.get(peer));
  activityKind.set(peer, kind);
  activityTimers.set(peer, setTimeout(() => clearActivity(peer), 5000));
  if (peer === activePeer) showActivityBubble(kind);
}
function clearActivity(peer) {
  if (activityTimers.has(peer)) { clearTimeout(activityTimers.get(peer)); activityTimers.delete(peer); }
  activityKind.delete(peer);
  if (peer === activePeer) hideActivityBubble();
}
function mediaUrl(m) { const mime = /^[\w.+-]+\/[\w.+-]+$/.test(m.mime || "") ? m.mime : "application/octet-stream"; return `data:${mime};base64,${m.data}`; }
function mediaBubble(m) {
  const url = mediaUrl(m);
  if (m.kind === "image") return `<img class="media-img" src="${url}" alt="imagem">`;
  if (m.kind === "video") return `<video class="media-vid" src="${url}" controls preload="metadata"></video>`;
  if (m.kind === "audio") { const sig = m.data.length + "_" + m.data.slice(0, 16); return `<div class="bubble audio-player" data-sig="${sig}"><button class="ap-play" aria-label="reproduzir">▶</button><canvas class="ap-wave" width="160" height="30"></canvas><span class="ap-time">•••</span><audio class="ap-audio" src="${url}" preload="metadata"></audio></div>`; }
  return `<a class="bubble media-file" href="${url}" download="${esc(m.name || "ficheiro")}">📄 <span>${esc(m.name || "ficheiro")}</span></a>`;
}
function mediaLabel(m) { return m.kind === "image" ? "📷 Foto" : m.kind === "video" ? "🎥 Vídeo" : m.kind === "audio" ? "🎤 Áudio" : "📄 " + (m.name || "Ficheiro"); }

// ---- leitor de áudio com onda + duração ----
const waveCache = new Map(); // sig -> { peaks:[0..1], duration }
const fmtDur = s => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return m + ":" + String(sec).padStart(2, "0"); };
async function decodePeaks(src) {
  const ctx = audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
  const buf = await (await fetch(src)).arrayBuffer();
  const audioBuf = await ctx.decodeAudioData(buf);
  const ch = audioBuf.getChannelData(0), N = 48, block = Math.max(1, Math.floor(ch.length / N)), peaks = [];
  let peak = 0;
  for (let i = 0; i < N; i++) { let mx = 0; for (let j = 0; j < block; j++) { const v = Math.abs(ch[i * block + j] || 0); if (v > mx) mx = v; } peaks.push(mx); if (mx > peak) peak = mx; }
  const norm = peak > 0 ? peaks.map(v => v / peak) : peaks.map(() => 0.15);
  return { peaks: norm, duration: audioBuf.duration };
}
function drawWave(canvas, peaks, progress, mine) {
  const g = canvas.getContext("2d"), W = canvas.width, H = canvas.height, n = peaks.length, bw = W / n;
  const on = mine ? "#fff" : getCSS("--accent"), off = mine ? "rgba(255,255,255,.45)" : getCSS("--muted");
  g.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, peaks[i] * (H - 4)), x = i * bw, y = (H - h) / 2;
    g.fillStyle = (i + 0.5) / n <= progress ? on : off;
    g.beginPath(); g.roundRect(x + bw * 0.18, y, Math.max(1, bw * 0.5), h, 1); g.fill();
  }
}
function getCSS(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888"; }
function initAudioPlayers() { document.querySelectorAll(".audio-player:not([data-on])").forEach(setupAudioPlayer); }
function setupAudioPlayer(el) {
  el.setAttribute("data-on", "1");
  const audio = el.querySelector(".ap-audio"), playBtn = el.querySelector(".ap-play"), canvas = el.querySelector(".ap-wave"), timeEl = el.querySelector(".ap-time");
  const mine = !!el.closest(".row.me");
  let peaks = new Array(48).fill(0.15), duration = 0, progress = 0;
  const redraw = () => drawWave(canvas, peaks, progress, mine);
  redraw();
  const sig = el.getAttribute("data-sig");
  const apply = d => { peaks = d.peaks; duration = d.duration; timeEl.textContent = fmtDur(duration); redraw(); };
  if (waveCache.has(sig)) apply(waveCache.get(sig));
  else decodePeaks(audio.src).then(d => { waveCache.set(sig, d); apply(d); }).catch(() => { timeEl.textContent = ""; });
  playBtn.onclick = () => { if (audio.paused) { audio.play(); } else audio.pause(); };
  audio.onplay = () => { playBtn.textContent = "⏸"; };
  audio.onpause = () => { playBtn.textContent = "▶"; };
  audio.onended = () => { playBtn.textContent = "▶"; progress = 0; redraw(); timeEl.textContent = fmtDur(duration); };
  audio.ontimeupdate = () => { const d = duration || audio.duration; if (d && isFinite(d)) { progress = audio.currentTime / d; timeEl.textContent = fmtDur(d - audio.currentTime); redraw(); } };
  canvas.onclick = e => { const d = duration || audio.duration; if (d && isFinite(d)) { audio.currentTime = (e.offsetX / canvas.clientWidth) * d; } };
}
function renderStream() {
  const s = $("stream");
  const list = threads.get(activePeer) || [];
  if (!list.length) { s.innerHTML = `<div class="day">início da conversa com ${esc(displayOf(activePeer))}</div>`; maybeShowActivity(); return; }
  s.innerHTML = "";
  for (const m of list) {
    if (m.sys) { s.insertAdjacentHTML("beforeend", `<div class="sys">${esc(m.text)}</div>`); continue; }
    const ex = (m.expireAt || m.ttl) ? '<span title="apaga-se sozinha">⏱</span>' : "";
    const pend = m.pending ? '<span title="vai ser entregue quando a pessoa entrar">🕓 em espera</span>' : "";
    const sender = (!m.me && m.fromDn) ? `<div class="sender" style="color:${avColor(m.from)}">${esc(m.fromDn)}</div>` : "";
    const body = m.kind ? mediaBubble(m) : `<div class="bubble">${esc(m.text)}</div>`;
    s.insertAdjacentHTML("beforeend", `
      <div class="row ${m.me ? "me" : "them"}">
        ${sender}${body}
        <div class="stamp">${fmtTime(m.time)} ${ex} ${pend}</div>
      </div>`);
  }
  s.scrollTop = s.scrollHeight;
  initAudioPlayers();
  maybeShowActivity();
}
function openPeer(name) {
  name = (name || "").trim().toLowerCase();
  if (!name) return;
  if (name === username) { toast("escolhe um username diferente do teu"); return; }
  activePeer = name;
  if (!isGroup(name)) addContact(name);
  ensureConvo(name);
  convos.get(name).unread = 0;
  $("chatEmpty").style.display = "none";
  $("chatHeader").style.display = "flex";
  $("composer").style.display = "flex";
  $("verifyPanel").classList.remove("open"); $("dmPanel").classList.remove("open"); $("groupPanel").classList.remove("open");
  $("app").classList.add("chat-open");
  updateHeader(); renderSidebar(); renderStream();
  startTtlCountdowns(name); // vi as mensagens -> arranca a contagem das temporárias recebidas
  // Só auto-focar com rato/teclado. Em telemóvel (e sobretudo no PWA em standalone),
  // focar o input por código deixa-o "focado sem teclado": o toque seguinte não muda
  // o foco e o iOS nunca abre o teclado. Deixamos o utilizador tocar.
  softFocus($("msg"));
}

// ---- verificação ----
async function showSafetyNumber() {
  const session = await store.getSession(activePeer);
  if (!session || !session.peerIK) { toast("envia uma mensagem primeiro para abrir a sessão"); return; }
  const id = await store.getIdentity();
  const num = await safetyNumber(id.IK.pub, username, unb64(session.peerIK), activePeer);
  $("verifyNum").textContent = formatSafety(num);
  $("verifyPanel").classList.add("open");
}

// ---- mensagens temporárias ----
// Última alteração ganha (carimbo temporal). Devolve true se o valor visível mudou.
function applyDm(key, secs, at) {
  const r = dmWinner(dmTimer.get(key) || 0, dmAt.get(key) || 0, secs, at);
  dmTimer.set(key, r.secs); dmAt.set(key, r.at); persistKv();
  if (key === activePeer) updateHeader();
  return r.changed;
}
function openDm() {
  if (!activePeer) return;
  const cur = dmTimer.get(activePeer) || 0;
  $("dmOpts").querySelectorAll("button").forEach(b => b.classList.toggle("sel", Number(b.dataset.secs) === cur));
  $("dmPanel").classList.add("open");
}
async function setDisappearing(secs) {
  const conv = activePeer;
  const at = Date.now();
  applyDm(conv, secs, at);
  pushSys(conv, secs > 0 ? `Ativaste mensagens temporárias: ${dmLabel(secs)}.` : "Desligaste as mensagens temporárias.");
  if (isGroup(conv)) {
    const gid = gidOf(conv);
    for (const m of gm.members(gid)) if (m !== username) await sendControl(m, { grpDm: { gid, secs, at } });
  } else {
    await sendControl(conv, { dm: secs, dmAt: at });
  }
}

// ---- nome público ----
function setDisplayName(v) {
  displayName = (v || "").trim() || username;
  localStorage.setItem("aegis-dn-" + username, displayName);
  peerNames.set(username, displayName); persistKv();
  $("meName").textContent = displayName;
  $("acHeadName").textContent = displayName;
  setAvatarEl($("meAvatar"), username);
  setAvatarEl($("acAvatar"), username);
  register();
  broadcastProfile();
  toast("perfil atualizado");
}

// ---- foto de perfil ----
function resizePhoto(file, cb) {
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    const s = 96, c = document.createElement("canvas"); c.width = c.height = s;
    const ctx = c.getContext("2d");
    const min = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, s, s);
    cb(c.toDataURL("image/jpeg", 0.8));
  };
  img.onerror = () => toast("não consegui ler a imagem");
  img.src = URL.createObjectURL(file);
}
function setOwnPhoto(dataURL) {
  if (dataURL) peerPhotos.set(username, dataURL); else peerPhotos.delete(username);
  persistKv();
  setAvatarEl($("meAvatar"), username);
  setAvatarEl($("acAvatar"), username);
  renderSidebar();
  broadcastProfile();
}

// ---- perfil ----
function openProfile() {
  $("acHandle").textContent = "@" + username;
  $("acHeadName").textContent = displayName;
  $("acName").value = displayName;
  setAvatarEl($("acAvatar"), username);
  $("profilePanel").classList.add("open");
}

// ---- definições ----
const settings = { sound: false, notify: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem("aegis-settings") || "{}")); } catch {}
const saveSettings = () => localStorage.setItem("aegis-settings", JSON.stringify(settings));
function openSettings() {
  $("setSound").classList.toggle("on", settings.sound);
  $("setNotify").classList.toggle("on", settings.notify);
  disarmWipe();
  $("settingsPanel").classList.add("open");
}
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.16, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.26);
  } catch {}
}
function notifyIncoming(peer) {
  if (settings.sound) beep();
  if (settings.notify && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(displayOf(peer), { body: "Nova mensagem", silent: true }); } catch {}
  }
}
let wipeArmed = false;
function disarmWipe() { wipeArmed = false; $("acWipe").classList.remove("armed"); $("acWipe").textContent = "Esquecer este dispositivo (apaga tudo)"; }
function onWipeClick() {
  if (!wipeArmed) { wipeArmed = true; $("acWipe").classList.add("armed"); $("acWipe").textContent = "Carrega outra vez para apagar tudo"; setTimeout(disarmWipe, 4000); return; }
  doWipe();
}
async function doWipe() { sessionStorage.removeItem("aegis-vault-" + username); await wipe(username); localStorage.removeItem("aegis-auth"); localStorage.removeItem("aegis-dn-" + username); location.reload(); }

// ---- grupos ----
function createGroupFlow() {
  $("ngName").value = ""; $("ngMembers").value = "";
  ngSelected = new Set();
  renderNgContacts();
  $("newGroupPanel").classList.add("open");
  setTimeout(() => softFocus($("ngName")), 50);
}
function renderNgContacts() {
  const el = $("ngContacts");
  const list = [...contacts];
  if (!list.length) { el.innerHTML = '<div class="select-empty">Sem contactos guardados — escreve os usernames em baixo.</div>'; return; }
  el.innerHTML = list.map(u =>
    `<div class="select-item ${ngSelected.has(u) ? "sel" : ""}" data-u="${esc(u)}">${avatarOf(u, 30)}<span class="nm">${esc(displayOf(u))}</span><span class="check">${ngSelected.has(u) ? "✓" : "○"}</span></div>`).join("");
  el.querySelectorAll(".select-item").forEach(it => it.onclick = () => { const u = it.dataset.u; ngSelected.has(u) ? ngSelected.delete(u) : ngSelected.add(u); renderNgContacts(); });
}
async function doCreateGroup() {
  const name = $("ngName").value.trim();
  if (!name) { toast("dá um nome ao grupo"); return; }
  const extra = $("ngMembers").value.split(",").map(s => s.trim().toLowerCase()).filter(m => m && m !== username);
  const members = [...new Set([...ngSelected, ...extra])];
  if (!members.length) { toast("escolhe pelo menos um membro"); return; }
  const gid = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
  $("newGroupPanel").classList.remove("open");
  ensureConvo("#" + gid);
  await gm.create(gid, name, members);
  openPeer("#" + gid);
}
function openGroupPanel() {
  const gid = gidOf(activePeer);
  $("grpTitle").textContent = gm.name(gid);
  $("grpMembers").innerHTML = gm.members(gid).map(m =>
    `<div class="mem${m === username ? "" : " tappable"}" data-u="${esc(m)}">${avatarOf(m, 28)}<span>${esc(m === username ? "tu" : displayOf(m))}</span></div>`).join("");
  $("grpMembers").querySelectorAll(".mem.tappable").forEach(el => el.onclick = () => { $("groupPanel").classList.remove("open"); openPeer(el.dataset.u); });
  $("grpVerifyBox").style.display = "none";
  $("groupPanel").classList.add("open");
}

// ---- contactos ----
function addContact(u) {
  if (u && u !== username && !isGroup(u) && !contacts.has(u)) { contacts.add(u); persistKv(); }
}
function removeContact(u) { contacts.delete(u); persistKv(); renderContacts(); }
function openContacts() { renderContacts(); $("contactsPanel").classList.add("open"); }
function renderContacts() {
  const list = $("contactsList");
  if (!contacts.size) { list.innerHTML = '<div class="contacts-empty">Sem contactos. Adiciona acima.</div>'; return; }
  list.innerHTML = "";
  for (const u of contacts) {
    list.insertAdjacentHTML("beforeend",
      `<div class="contact" data-u="${esc(u)}">${avatarOf(u, 34)}<div class="info"><div class="n">${esc(displayOf(u))}</div><div class="h">@${esc(u)}</div></div><button class="rm" data-rm="${esc(u)}" title="remover">×</button></div>`);
  }
  list.querySelectorAll(".rm").forEach(el => el.onclick = e => { e.stopPropagation(); removeContact(el.dataset.rm); });
  list.querySelectorAll(".contact").forEach(el => el.onclick = () => { openPeer(el.dataset.u); $("contactsPanel").classList.remove("open"); });
}

// ---- opções da conversa (limpar / apagar) ----
function openConvMenu() {
  if (!activePeer) return;
  $("cmTitle").textContent = displayOf(activePeer);
  $("cmDelete").style.display = isGroup(activePeer) ? "none" : "block";
  $("convMenu").classList.add("open");
}
function clearChatLocal(peer, remote) {
  threads.set(peer, []);
  persistThread(peer);
  if (remote) pushSys(peer, "as mensagens foram limpas dos dois lados.");
  if (peer === activePeer) renderStream();
  renderSidebar();
}
async function clearChatEveryone(peer) {
  if (isGroup(peer)) { const gid = gidOf(peer); for (const m of gm.members(gid)) if (m !== username) await sendControl(m, { grpClear: { gid } }); }
  else { await sendControl(peer, { clearChat: 1 }); }
  clearChatLocal(peer);
  toast("conversa limpa para todos");
}
function deleteConvo(peer) {
  pendingMsgs.delete(peer);
  convos.delete(peer); threads.delete(peer); dmTimer.delete(peer); dmAt.delete(peer); verified.delete(peer);
  store.deleteThread(peer); store.delSession(peer); persistKv();
  if (peer === activePeer) {
    activePeer = null;
    $("stream").innerHTML = "";
    $("chatHeader").style.display = "none"; $("composer").style.display = "none"; $("chatEmpty").style.display = "grid";
    $("app").classList.remove("chat-open");
  }
  renderSidebar();
}

async function restoreState() {
  const meta = await store.getKv("appmeta");
  if (meta) {
    for (const [k, v] of Object.entries(meta.peerNames || {})) peerNames.set(k, v);
    for (const [k, v] of Object.entries(meta.dmTimer || {})) dmTimer.set(k, Number(v));
    for (const [k, v] of Object.entries(meta.dmAt || {})) dmAt.set(k, Number(v));
    for (const [k, v] of Object.entries(meta.verified || {})) verified.set(k, v);
    for (const u of (meta.contacts || [])) contacts.add(u);
    for (const [k, v] of Object.entries(meta.photos || {})) peerPhotos.set(k, v);
  }
  gm.restore(await store.getGroups());
  for (const g of gm.list()) ensureConvo("#" + g.gid);
  const now = Date.now();
  for (const { key, msgs } of await store.getThreads()) {
    const kept = msgs.filter(m => !(m.expireAt && now >= m.expireAt));
    threads.set(key, kept);
    ensureConvo(key);
    const lastMsg = [...kept].reverse().find(m => m.time);
    if (lastMsg) convos.get(key).ts = lastMsg.time;
    for (const m of kept) if (m.expireAt) scheduleExpiry(key, m, Math.max(0, m.expireAt - now));
  }
  renderSidebar();
}

// ---- arranque / autenticação ----
let authMode = "login";
function setAuthMode(m) {
  authMode = m;
  $("enter").textContent = m === "login" ? "Entrar" : "Criar conta";
  $("loginSub").textContent = m === "login" ? "Entra na tua conta." : "Cria uma conta nova.";
  $("toggleMode").textContent = m === "login" ? "Criar conta" : "Já tenho conta";
  $("password").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
  $("loginErr").textContent = "";
}
// WebCrypto só existe em contexto seguro (HTTPS ou localhost). Em HTTP simples
// (ex.: abrir pelo IP local do PC no telemóvel) `crypto.subtle` é undefined.
function cryptoOK() { return typeof crypto !== "undefined" && !!crypto.subtle; }
function warnNoCrypto() {
  const msg = "Encriptação indisponível aqui. Abre a app por HTTPS (o link do Render) — por HTTP só funciona em localhost, não pelo IP do PC.";
  const e = $("loginErr"); if (e) e.textContent = msg;
  const s = $("loginSub"); if (s) s.textContent = "Precisas de uma ligação segura (HTTPS).";
  const b = $("enter"); if (b) b.disabled = true;
}
async function submitAuth() {
  if (!cryptoOK()) { warnNoCrypto(); return; }
  const u = ($("username").value || "").trim().toLowerCase();
  const pw = $("password").value || "";
  if (!/^[a-z0-9_]{2,20}$/.test(u)) { $("loginErr").textContent = "username inválido (2-20: minúsculas, números, _)"; return; }
  if (pw.length < 6) { $("loginErr").textContent = "palavra-passe com pelo menos 6 caracteres"; return; }
  $("enter").disabled = true; $("loginErr").textContent = "";
  try {
    const res = await fetch(API_BASE + "/api/" + authMode, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: u, pass: pw }) });
    const data = await res.json();
    if (!res.ok) {
      $("enter").disabled = false;
      if (authMode === "signup" && res.status === 409) {
        setAuthMode("login");
        $("username").value = u;
        $("loginErr").textContent = "Esse username já existe — entra com a tua palavra-passe.";
        $("password").value = ""; softFocus($("password"));
      } else {
        $("loginErr").textContent = data.error || "erro";
      }
      return;
    }
    localStorage.setItem("aegis-auth", JSON.stringify({ user: data.user, token: data.token }));
    $("password").value = "";
    pendingFirstTime = authMode === "signup" || !localStorage.getItem("aegis-dn-" + data.user);
    authToken = data.token;
    connect(); // autentica e entra quando o servidor confirmar
  } catch { $("loginErr").textContent = "servidor indisponível"; $("enter").disabled = false; }
}
async function unlockVault(user) {
  const meta = await store.getVaultMeta();
  const cacheKey = "aegis-vault-" + user;
  if (meta) {
    // opção B: a chave fica na sessão do separador (limpa ao fechar) — sem voltar a pedir em reloads
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try { const raw = vunb64(cached); if (await checkVerifier(raw, meta.verifier)) { store.unlock(raw); return; } } catch {}
      sessionStorage.removeItem(cacheKey);
    }
    await promptVault("unlock", async (p, fail) => {
      const raw = await deriveVaultKey(p, vunb64(meta.salt));
      if (!await checkVerifier(raw, meta.verifier)) { fail("passphrase incorreta"); return false; }
      store.unlock(raw); sessionStorage.setItem(cacheKey, vb64(raw)); return true;
    });
  } else {
    // primeira vez neste dispositivo: criar o cofre e cifrar o que já exista
    await promptVault("create", async (p) => {
      const salt = newSalt();
      const raw = await deriveVaultKey(p, salt);
      store.unlock(raw);
      await store.setVaultMeta({ salt: vb64(salt), verifier: await makeVerifier(raw) });
      await store.reencryptAll();
      sessionStorage.setItem(cacheKey, vb64(raw)); return true;
    });
  }
}
// mostra o ecrã de passphrase e chama handler(p, fail) até este devolver true
function promptVault(mode, handler) {
  return new Promise(resolve => {
    const gate = $("vaultGate"), pass = $("vaultPass"), pass2 = $("vaultPass2"), go = $("vaultGo"), err = $("vaultErr");
    const create = mode === "create";
    $("vaultTitle").textContent = create ? "Cifrar este dispositivo" : "Desbloquear";
    $("vaultDesc").textContent = create
      ? "Define uma passphrase. Cifra a identidade, as sessões e o histórico guardados neste browser."
      : "Introduz a passphrase deste dispositivo.";
    go.textContent = create ? "Criar cofre" : "Desbloquear";
    pass2.style.display = create ? "" : "none";
    pass.value = ""; pass2.value = ""; err.textContent = "";
    gate.style.display = "block";
    setTimeout(() => softFocus(pass), 50);
    const reset = () => { go.disabled = false; go.textContent = create ? "Criar cofre" : "Desbloquear"; };
    const fail = msg => { err.textContent = msg; reset(); softFocus(pass); };
    const submit = async () => {
      const p = pass.value;
      if (p.length < 8) return fail("mínimo 8 caracteres");
      if (create && p !== pass2.value) return fail("as passphrases não coincidem");
      go.disabled = true; go.textContent = "a derivar…"; err.textContent = "";
      let ok = false;
      try { ok = await handler(p, fail); } catch (e) { console.error(e); fail("erro ao derivar a chave"); return; }
      if (ok) { go.onclick = null; pass.onkeydown = null; pass2.onkeydown = null; gate.style.display = "none"; resolve(); }
    };
    const onKey = e => { if (e.key === "Enter") submit(); };
    go.onclick = submit; pass.onkeydown = onKey; pass2.onkeydown = onKey;
  });
}
async function enterApp(user) {
  entered = true;
  username = user;
  const saved = localStorage.getItem("aegis-dn-" + username);
  displayName = saved || username;
  localStorage.setItem("aegis-dn-" + username, displayName);
  peerNames.set(username, displayName);
  store = await createStore(username);
  await unlockVault(username);
  gm = createGroupManager({
    me: username,
    sendPairwise: (to, obj) => sendControl(to, obj),
    sendGroup: (to, grp) => ws.send(JSON.stringify({ type: "send", to, envelope: { grp } })),
    myDn: () => displayName,
    onMessage: onGroupMessage,
    onSystem: (gid, text) => pushSys("#" + gid, text),
    saveGroup: (gid, g) => store.saveGroup(gid, g),
    deleteGroup: gid => store.deleteGroupRec(gid),
  });
  await restoreState();
  $("login").style.display = "none";
  $("app").classList.add("ready");
  $("enter").disabled = false;
  $("meName").textContent = displayName;
  $("meHandle").textContent = "@" + username;
  setAvatarEl($("meAvatar"), username);
  register();
  if (pendingFirstTime) { pendingFirstTime = false; setTimeout(openProfile, 300); }
}
function logout() {
  const a = JSON.parse(localStorage.getItem("aegis-auth") || "null");
  if (a && a.token) fetch(API_BASE + "/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: a.token }) }).catch(() => {});
  if (a && a.user) sessionStorage.removeItem("aegis-vault-" + a.user);
  localStorage.removeItem("aegis-auth");
  location.reload();
}
// PWA: regista o service worker. Na app nativa (Capacitor) não — os assets já
// correm localmente e um SW só iria atrapalhar.
if (!PACKAGED && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
function autoLogin() {
  if (!cryptoOK()) { warnNoCrypto(); return; }
  const a = JSON.parse(localStorage.getItem("aegis-auth") || "null");
  if (a && a.user && a.token) { pendingFirstTime = false; authToken = a.token; connect(); }
}

// ---- eventos ----
$("enter").onclick = submitAuth;
$("toggleMode").onclick = () => setAuthMode(authMode === "login" ? "signup" : "login");
$("username").addEventListener("keydown", e => { if (e.key === "Enter") $("password").focus(); });
$("password").addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
(() => { const a = JSON.parse(localStorage.getItem("aegis-auth") || "null"); if (a && a.user) $("username").value = a.user; })();
$("fab").onclick = () => { $("newConvPanel").classList.add("open"); setTimeout(() => softFocus($("newPeer")), 50); };
$("closeNewConv").onclick = () => $("newConvPanel").classList.remove("open");
const goNewPeer = () => { const v = $("newPeer").value; $("newPeer").value = ""; $("newConvPanel").classList.remove("open"); openPeer(v); };
$("addPeer").onclick = goNewPeer;
$("newPeer").addEventListener("keydown", e => { if (e.key === "Enter") goNewPeer(); });
const submit = () => { const v = $("msg").value.trim(); if (!v) return; if (isGroup(activePeer)) gm.send(gidOf(activePeer), v); else sendMessage(v); $("msg").value = ""; };
$("send").onclick = submit;
$("msg").addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
let lastTypingSent = 0;
$("msg").addEventListener("input", async () => {
  const peer = activePeer;
  if (!peer || isGroup(peer)) return;
  const now = Date.now();
  if (now - lastTypingSent < 3000) return;
  if (now - (lastResync.get(peer) || 0) < 8000) return;   // não mexer durante recuperação
  if (!await store.getSession(peer)) return;               // não iniciar sessão só por causa do "a escrever…"
  lastTypingSent = now;
  sendControl(peer, { typing: 1 }).catch(() => {});
});
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ""; };
$("camBtn").onclick = () => $("camInput").click();
$("camInput").onchange = e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ""; };
$("camFab").onclick = () => $("camFabInput").click();
$("camFabInput").onchange = e => { const f = e.target.files[0]; if (f) captureForPick(f); e.target.value = ""; };
$("closeSendTo").onclick = () => { $("sendToPanel").classList.remove("open"); pendingSendMedia = null; };
$("micBtn").onclick = toggleRecord;
$("stream").addEventListener("click", e => { const img = e.target.closest && e.target.closest("img.media-img"); if (img) { $("lightboxImg").src = img.src; $("lightbox").classList.add("open"); } });
$("lightbox").onclick = () => { $("lightbox").classList.remove("open"); $("lightboxImg").src = ""; };
$("backBtn").onclick = () => $("app").classList.remove("chat-open");
$("verifyBtn").onclick = showSafetyNumber;
$("convMenuBtn").onclick = openConvMenu;
$("cmCancel").onclick = () => $("convMenu").classList.remove("open");
$("cmClearMine").onclick = () => { clearChatLocal(activePeer); $("convMenu").classList.remove("open"); toast("conversa limpa só para ti"); };
$("cmClearAll").onclick = async () => { const p = activePeer; $("convMenu").classList.remove("open"); await clearChatEveryone(p); };
$("cmDelete").onclick = () => { const p = activePeer; $("convMenu").classList.remove("open"); deleteConvo(p); toast("conversa apagada"); };
$("markVerified").onclick = () => { verified.set(activePeer, true); persistKv(); updateHeader(); $("verifyPanel").classList.remove("open"); toast("identidade verificada"); };
$("closeVerify").onclick = () => $("verifyPanel").classList.remove("open");
$("dmBtn").onclick = openDm;
$("closeDm").onclick = () => $("dmPanel").classList.remove("open");
$("dmOpts").querySelectorAll("button").forEach(b => b.onclick = () => { setDisappearing(Number(b.dataset.secs)); $("dmPanel").classList.remove("open"); });
$("settingsBtn").onclick = openSettings;
$("closeSettings").onclick = () => $("settingsPanel").classList.remove("open");
$("closeProfile").onclick = () => $("profilePanel").classList.remove("open");
$("setSound").onclick = () => { settings.sound = !settings.sound; $("setSound").classList.toggle("on", settings.sound); saveSettings(); if (settings.sound) beep(); };
$("setNotify").onclick = async () => {
  if (!settings.notify) {
    const ok = await enablePush();          // pede permissão + subscreve push em segundo plano
    if (!ok) return;
    settings.notify = true;
  } else {
    settings.notify = false;
    await disablePush();
  }
  $("setNotify").classList.toggle("on", settings.notify); saveSettings();
};
$("acSaveName").onclick = () => setDisplayName($("acName").value);
$("acName").addEventListener("keydown", e => { if (e.key === "Enter") setDisplayName($("acName").value); });
$("acLogout").onclick = logout;
$("acWipe").onclick = onWipeClick;
$("acPhotoBtn").onclick = () => $("acPhotoInput").click();
$("acPhotoInput").onchange = e => { const f = e.target.files[0]; if (f) resizePhoto(f, d => setOwnPhoto(d)); e.target.value = ""; };
$("acPhotoRm").onclick = () => setOwnPhoto(null);
$("meProfile").onclick = openProfile;
$("contactsFab").onclick = openContacts;
$("closeContacts").onclick = () => $("contactsPanel").classList.remove("open");
$("contactAddBtn").onclick = () => { const u = $("contactAdd").value.trim().toLowerCase(); if (u && u !== username) { contacts.add(u); persistKv(); $("contactAdd").value = ""; renderContacts(); } };
$("contactAdd").addEventListener("keydown", e => { if (e.key === "Enter") $("contactAddBtn").click(); });
$("newGroup").onclick = () => { $("newConvPanel").classList.remove("open"); createGroupFlow(); };
$("ngCreate").onclick = doCreateGroup;
$("ngCancel").onclick = () => $("newGroupPanel").classList.remove("open");
$("ngMembers").addEventListener("keydown", e => { if (e.key === "Enter") doCreateGroup(); });
$("groupBtn").onclick = openGroupPanel;
$("grpVerifyBtn").onclick = async () => {
  const gid = gidOf(activePeer);
  const id = await store.getIdentity();
  const parts = []; const missing = [];
  for (const m of gm.members(gid)) {
    if (m === username) { parts.push({ id: m, ik: id.IK.pub }); continue; }
    const sess = await store.getSession(m);
    if (sess && sess.peerIK) parts.push({ id: m, ik: unb64(sess.peerIK) });
    else missing.push(m);
  }
  const num = await groupSafetyNumber(parts);
  $("grpVerifyNum").textContent = formatSafety(num);
  $("grpVerifyNote").textContent = missing.length
    ? `Ainda não tenho as chaves de: ${missing.map(displayOf).join(", ")}. O número só coincide depois de trocar mensagens com toda a gente.`
    : "Comparem estes 60 dígitos fora da app. Se forem iguais para todos os membros, ninguém no grupo tem a identidade trocada.";
  $("grpVerifyBox").style.display = "block";
};
$("closeGroup").onclick = () => $("groupPanel").classList.remove("open");
$("grpAddBtn").onclick = async () => { const u = $("grpAddUser").value.trim().toLowerCase(); if (!u) return; await gm.addMember(gidOf(activePeer), u); $("grpAddUser").value = ""; openGroupPanel(); updateHeader(); };
$("grpLeave").onclick = async () => {
  const key = activePeer, gid = gidOf(key);
  await gm.leave(gid);
  convos.delete(key); threads.delete(key); dmTimer.delete(key); dmAt.delete(key);
  store.deleteThread(key);
  $("groupPanel").classList.remove("open");
  activePeer = null;
  $("stream").innerHTML = "";
  $("chatHeader").style.display = "none"; $("composer").style.display = "none"; $("chatEmpty").style.display = "grid";
  $("app").classList.remove("chat-open");
  renderSidebar(); toast("saíste do grupo");
};

// tenta entrar logo se já houver uma sessão guardada (senão fica no ecrã de login)
autoLogin();

// rede de segurança: re-tenta entregar mensagens em espera de tempos a tempos
setInterval(() => { flushAllPending(); }, 12000);
// ao voltar ao separador com uma conversa aberta, conta-se como "visto"
document.addEventListener("visibilitychange", () => { if (!document.hidden) startTtlCountdowns(activePeer); });
