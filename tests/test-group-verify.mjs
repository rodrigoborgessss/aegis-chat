// Número de segurança de grupo: igual para todos independentemente da ordem dos
// membros, e diferente se a identidade de um membro mudar (intruso).
import { groupSafetyNumber } from "../public/ratchet.js";

const ik = s => new Uint8Array([...s].map(c => c.charCodeAt(0) % 256).concat(Array(32).fill(0)).slice(0, 32));
const A = { id: "alice", ik: ik("alice-key") };
const B = { id: "bob", ik: ik("bob-key") };
const C = { id: "carol", ik: ik("carol-key") };

let fails = 0;
const check = (cond, lbl) => { if (!cond) fails++; console.log(`  ${cond ? "OK " : "ERRO"}  ${lbl}`); };

const n1 = await groupSafetyNumber([A, B, C]);
const n2 = await groupSafetyNumber([C, A, B]);   // ordem diferente
const n3 = await groupSafetyNumber([B, C, A]);
check(n1.length === 60, "60 dígitos");
check(n1 === n2 && n2 === n3, "mesmo número independentemente da ordem dos membros");

// se a chave da carol for trocada (MITM), o número muda para quem a tiver trocada
const Cbad = { id: "carol", ik: ik("intruso!!") };
const nBad = await groupSafetyNumber([A, B, Cbad]);
check(nBad !== n1, "identidade trocada de um membro muda o número");

// membro a mais/a menos também muda
check((await groupSafetyNumber([A, B])) !== n1, "conjunto de membros diferente muda o número");

console.log(fails === 0 ? "\n\u2705 VERIFICAÇÃO DE GRUPO OK" : `\n\u274c ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
