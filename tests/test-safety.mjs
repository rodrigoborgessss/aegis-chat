// Verifica que o safety number é igual dos dois lados e diverge num MITM.
import * as R from "../public/ratchet.js";

(async () => {
  const alice = await R.genX(), bob = await R.genX(), mallory = await R.genX();
  let fails = 0;
  const check = (c, lbl) => { if (!c) fails++; console.log(`  ${c ? "OK " : "ERRO"}  ${lbl}`); };

  // Os dois calculam, cada um com a sua chave + a do outro
  const aView = await R.safetyNumber(alice.pub, "alice", bob.pub, "bob");
  const bView = await R.safetyNumber(bob.pub, "bob", alice.pub, "alice");
  console.log("Alice vê:", R.formatSafety(aView));
  console.log("Bob vê:  ", R.formatSafety(bView));
  check(aView === bView, "ambos obtêm o mesmo número (sem MITM)");

  // MITM: a Alice julga falar com o Bob, mas tem a chave da Mallory
  const aMitm = await R.safetyNumber(alice.pub, "alice", mallory.pub, "bob");
  console.log("\nCom MITM, Alice vê:", R.formatSafety(aMitm));
  check(aMitm !== bView, "número da Alice deixa de bater com o do Bob (MITM apanhado)");

  console.log(fails === 0 ? "\n✅ SAFETY NUMBERS OK" : `\n❌ ${fails} falha(s)`);
  process.exit(fails === 0 ? 0 : 1);
})();
