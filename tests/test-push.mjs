// Web Push (VAPID): valida a parte que dá para testar em Node — a assinatura
// ES256 do JWT e a estabilidade do par de chaves em disco. (A entrega do push
// em si precisa de um serviço real de push + dispositivo, testa-se no telemóvel.)
import crypto from "crypto";
import { rmSync } from "fs";
import { initVapid, vapidJWT, vapidPublicKey } from "../push.js";

const F = "/tmp/aeg-vapid-test.json";
rmSync(F, { force: true });

let fails = 0;
const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };

const pub1 = initVapid(F);
check(typeof pub1 === "string" && pub1.length > 80, "gera chave pública VAPID (base64url)");
const raw = Buffer.from(pub1, "base64url");
check(raw.length === 65 && raw[0] === 4, "chave pública é ponto P-256 não comprimido (65 bytes, 0x04)");

// reconstruir a chave pública para verificar a assinatura
const x = raw.subarray(1, 33).toString("base64url"), y = raw.subarray(33, 65).toString("base64url");
const pubKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });

const aud = "https://fcm.googleapis.com";
const jwt = vapidJWT(aud);
const [h, p, s] = jwt.split(".");
const header = JSON.parse(Buffer.from(h, "base64url")), payload = JSON.parse(Buffer.from(p, "base64url"));
check(header.alg === "ES256" && header.typ === "JWT", "cabeçalho do JWT é ES256");
check(payload.aud === aud, "claim 'aud' é a origem do serviço de push");
check(payload.exp > Math.floor(Date.now() / 1000) && payload.exp <= Math.floor(Date.now() / 1000) + 12 * 3600 + 5, "exp dentro de ~12h");

const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
check(ok, "assinatura ES256 do JWT verifica com a chave pública VAPID");

// estabilidade: reabrir devolve a mesma chave (subscrições não partem)
const pub2 = initVapid(F);
check(pub2 === pub1, "o par persiste em disco (mesma chave ao reabrir)");

// caminho das variáveis de ambiente (produção, sobrevive a redeploys)
import { genVapidEnv } from "../push.js";
const env = genVapidEnv();
process.env.VAPID_PUBLIC = env.VAPID_PUBLIC;
process.env.VAPID_PRIVATE = env.VAPID_PRIVATE;
const pubEnv = initVapid("/tmp/aeg-nope.json"); // ficheiro inexistente: tem de usar a env
check(pubEnv === env.VAPID_PUBLIC, "initVapid usa a chave das variáveis de ambiente");
const rawE = Buffer.from(pubEnv, "base64url");
const pkE = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: rawE.subarray(1, 33).toString("base64url"), y: rawE.subarray(33, 65).toString("base64url") }, format: "jwk" });
const jwtE = vapidJWT("https://web.push.apple.com");
const [he, pe, se] = jwtE.split(".");
check(crypto.verify("sha256", Buffer.from(`${he}.${pe}`), { key: pkE, dsaEncoding: "ieee-p1363" }, Buffer.from(se, "base64url")), "JWT assinado com a chave da env verifica");
delete process.env.VAPID_PUBLIC; delete process.env.VAPID_PRIVATE;

rmSync(F, { force: true });
console.log(fails === 0 ? "\n\u2705 WEB PUSH (VAPID) OK" : `\n\u274c ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
