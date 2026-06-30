// Gera um par VAPID e imprime as variáveis de ambiente para o servidor.
// Correr UMA vez:  node tools/gen-vapid.mjs
// Depois colar as duas linhas nas Environment Variables do Render (ou no .env
// local) e fazer redeploy. A chave fica estável e as subscrições deixam de
// partir a cada deploy.
import { genVapidEnv } from "../push.js";
const e = genVapidEnv();
console.log("# cola isto nas variáveis de ambiente do servidor:");
console.log("VAPID_PUBLIC=" + e.VAPID_PUBLIC);
console.log("VAPID_PRIVATE=" + e.VAPID_PRIVATE);
