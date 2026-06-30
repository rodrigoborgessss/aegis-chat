// push.js — Web Push (VAPID) sem dependências, usando o crypto do Node.
//
// Envia notificações SEM conteúdo ("tickle"): o payload vai vazio, por isso não
// é preciso cifrar nada e o serviço de push (Apple/Google/Mozilla) só transporta
// um aviso. O service worker mostra "Nova mensagem"; o conteúdo só se vê ao abrir.
//
// Guarda o par VAPID em disco para a chave pública ser estável (as subscrições
// dos clientes dependem dela).
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

let priv, pubB64url;

// Em produção a chave VAPID DEVE ser estável: se mudar, todas as subscrições já
// feitas passam a dar 400 (VapidPkHashMismatch). Como o disco do Render free tier
// é efémero (apaga data/ a cada deploy), lê-se a chave de variáveis de ambiente,
// que persistem. Sem env vars (dev local), usa/gera o ficheiro.
function importFromEnv() {
  const pub = process.env.VAPID_PUBLIC, prv = process.env.VAPID_PRIVATE;
  if (!pub || !prv) return false;
  priv = crypto.createPrivateKey({ key: Buffer.from(prv, "base64"), format: "der", type: "pkcs8" });
  pubB64url = pub;
  return true;
}
export function initVapid(file) {
  if (importFromEnv()) return pubB64url;     // produção: par estável via env (sobrevive a redeploys)
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8"));
    priv = crypto.createPrivateKey({ key: s.priv, format: "pem", type: "pkcs8" });
    pubB64url = s.pub;
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    pubB64url = raw.toString("base64url");
    priv = privateKey;
    writeFileSync(file, JSON.stringify({ priv: privateKey.export({ format: "pem", type: "pkcs8" }), pub: pubB64url }));
  }
  return pubB64url;
}

// Gera um par novo e devolve os valores para colar nas variáveis de ambiente.
// Correr UMA vez (node tools/gen-vapid.mjs), pôr no Render, e fica estável.
export function genVapidEnv() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return {
    VAPID_PUBLIC: raw.toString("base64url"),
    VAPID_PRIVATE: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64"),
  };
}

export const vapidPublicKey = () => pubB64url;

export function vapidJWT(aud) {
  const part = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = part({ typ: "JWT", alg: "ES256" });
  const body = part({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:admin@aegischat.app" });
  const input = `${head}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: priv, dsaEncoding: "ieee-p1363" }); // r||s cru (64 B), não DER
  return `${input}.${sig.toString("base64url")}`;
}

// envia um push vazio. devolve o status HTTP (201 ok; 404/410 = subscrição morta)
export async function sendPush(sub) {
  const url = new URL(sub.endpoint);
  const jwt = vapidJWT(`${url.protocol}//${url.host}`);
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${pubB64url}`,
        TTL: "2419200",
      },
    });
    let reason = "";
    if (res.status >= 400) { try { reason = (await res.text()).slice(0, 180).replace(/\s+/g, " ").trim(); } catch {} }
    return { status: res.status, reason };
  } catch (e) { return { status: 0, reason: String(e && e.message || e) }; }
}
