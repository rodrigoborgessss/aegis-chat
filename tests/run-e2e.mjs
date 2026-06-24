// Testes que precisam do relay a correr. Arranca primeiro o servidor noutro
// terminal (`npm start`) e depois corre `npm run test:e2e`.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tests = ["e2e-server", "test-available", "test-auth"];

let failed = 0;
for (const file of tests) {
  const r = spawnSync(process.execPath, [join(here, file + ".mjs")], { cwd: root, encoding: "utf8" });
  const last = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop() || "";
  if (r.status !== 0) failed++;
  console.log(`  ${r.status === 0 ? "\u2705" : "\u274c"} ${file.padEnd(14)} ${last}`);
}
if (failed) console.log(`\n${failed} com falha \u274c  (o relay está a correr? \`npm start\` noutro terminal)`);
else console.log("\nTudo verde \u2705");
process.exit(failed === 0 ? 0 : 1);
