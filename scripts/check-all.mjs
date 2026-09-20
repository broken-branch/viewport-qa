import { spawnSync } from "node:child_process";
import { pnpmInvocation } from "./check-all-command.mjs";

const steps = [
  // "build" (tsc -b + chmod +x on the bin) rather than bare typecheck: the gate
  // must produce dist/ before tests, and the e2e tests execute the real shipped
  // bin (shebang + exec bit) as a subprocess.
  ["build", ["run", "build"]],
  ["lint", ["exec", "eslint", "."]],
  ["boundaries", ["exec", "node", "scripts/check-boundaries.mjs"]],
  // Tests include real-binary execution of both entry points:
  //   - `vqa scan` against fixtures/seeded-defects.html (seeded defects MUST be
  //     detected with the right types, or the suite fails)
  //   - `vqa serve` smoke (start, fetch report, POST a decision, assert
  //     decisions.json)
  ["tests", ["exec", "vitest", "run"]],
];

for (const [name, args] of steps) {
  console.log(`\n==> ${name}`);
  const invocation = pnpmInvocation(process.platform, args);
  const result = spawnSync(invocation.file, invocation.args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`${name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\ncheck-all: all checks passed");
