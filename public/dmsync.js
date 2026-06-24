// Regra de convergência do temporizador de mensagens temporárias.
// O temporizador é uma definição da conversa: tem de ficar igual nos dois lados.
// Usamos "última alteração ganha" por carimbo temporal — assim, mesmo que um
// controlo se perca e só chegue mais tarde (ex.: na recuperação de uma sessão),
// ambos os lados convergem para a alteração mais recente.
//
// Devolve { secs, at, changed }:
//   - secs/at: o estado a manter depois de considerar a alteração recebida
//   - changed: se o valor visível mudou (para decidir se se anuncia)
export function dmWinner(localSecs, localAt, incSecs, incAt) {
  localSecs = localSecs || 0; localAt = localAt || 0;
  incSecs = incSecs || 0; incAt = incAt || 0;
  if (incAt < localAt) return { secs: localSecs, at: localAt, changed: false };
  if (incAt === localAt && incSecs === localSecs) return { secs: localSecs, at: localAt, changed: false };
  return { secs: incSecs, at: incAt, changed: incSecs !== localSecs };
}
