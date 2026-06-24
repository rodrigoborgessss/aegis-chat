// O temporizador de mensagens temporárias tem de ficar IGUAL nos dois lados.
// Testa a regra "última alteração ganha" usada para o sincronizar, incluindo o
// caso de um controlo perdido que só chega na recuperação da sessão.
import { dmWinner } from "../public/dmsync.js";

let fails = 0;
const ok = (c, l) => { if (!c) fails++; console.log(`  ${c ? "\u2705" : "\u274c"}  ${l}`); };

// A ativa 10s (at=100); B ainda está a 0/0 -> B aceita 10s
let r = dmWinner(0, 0, 10, 100);
ok(r.secs === 10 && r.at === 100 && r.changed, "lado sem definição adota a alteração recebida");

// Controlo repetido (mesmo at, mesmo valor) -> sem mudança
r = dmWinner(10, 100, 10, 100);
ok(r.secs === 10 && !r.changed, "reenvio idêntico não conta como mudança");

// Chega um valor MAIS ANTIGO (ex.: resync de um lado desatualizado) -> ignora
r = dmWinner(10, 100, 0, 50);
ok(r.secs === 10 && r.at === 100 && !r.changed, "alteração mais antiga não sobrepõe a mais recente");

// Chega um valor MAIS RECENTE -> adota
r = dmWinner(10, 100, 30, 200);
ok(r.secs === 30 && r.at === 200 && r.changed, "alteração mais recente ganha");

// Convergência simétrica: aplicar o estado do outro lado dá o mesmo resultado dos dois lados
const A = { secs: 10, at: 100 }, B = { secs: 30, at: 200 };
const a2 = dmWinner(A.secs, A.at, B.secs, B.at);
const b2 = dmWinner(B.secs, B.at, A.secs, A.at);
ok(a2.secs === b2.secs && a2.at === b2.at && a2.secs === 30, "os dois lados convergem para o mesmo valor");

// Desligar (0) com carimbo mais recente vence um valor anterior
r = dmWinner(30, 200, 0, 300);
ok(r.secs === 0 && r.at === 300 && r.changed, "desligar mais recente vence");

// Resync de um lado que nunca definiu (0/0) não apaga a definição local
r = dmWinner(10, 100, 0, 0);
ok(r.secs === 10 && r.at === 100 && !r.changed, "resync sem definição não apaga o temporizador local");

console.log(fails === 0 ? "\u2705 SINCRONIZAÇÃO DO TEMPORIZADOR OK" : `\u274c ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
