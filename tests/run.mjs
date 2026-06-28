// Corre os testes offline (sem rede). Uso: `npm test`.
// Os testes que precisam do relay a correr estão em tests/run-e2e.mjs.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tests = ["test-integration", "test-group", "test-group-ooo", "test-group-verify", "test-vault", "test-persist", "test-safety", "test-wipe", "test-crossing", "test-resync", "test-ooo", "test-media", "test-dmsync"];

let failed = 0;
for (const file of tests) {
  const r = spawnSync(process.execPath, [join(here, file + ".mjs")], { cwd: root, encoding: "utf8" });
  const last = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop() || "";
  if (r.status !== 0) failed++;
  console.log(`  ${r.status === 0 ? "\u2705" : "\u274c"} ${file.padEnd(18)} ${last}`);
}
console.log(failed === 0 ? "\nTudo verde \u2705" : `\n${failed} teste(s) com falha \u274c`);
process.exit(failed === 0 ? 0 : 1);
