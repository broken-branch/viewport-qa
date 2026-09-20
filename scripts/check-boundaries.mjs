// Enforces the package dependency DAG so layers stay honest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const allowed = new Map([
  ["contract", new Set()],
  ["model-adapter", new Set()],
  ["detectors", new Set(["contract"])],
  ["engine", new Set(["contract", "detectors", "model-adapter"])],
  ["cli", new Set(["contract", "engine", "model-adapter"])],
]);

const allowedExternal = new Map([
  // playwright drives captures; pngjs is the pure-JS codec the visual diff decodes captures with.
  ["engine", new Set(["playwright", "pngjs", "@types/pngjs"])],
]);

let failures = 0;

for (const [name, allowedDeps] of allowed) {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", name, "package.json"), "utf8"),
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep.startsWith("@vqa/")) {
        const target = dep.slice("@vqa/".length);
        if (!allowedDeps.has(target)) {
          console.error(
            `boundaries: ${name} must not depend on @vqa/${target}`,
          );
          failures += 1;
        }
      } else if (!(allowedExternal.get(name)?.has(dep) ?? false)) {
        console.error(
          `boundaries: ${name} has unexpected external dependency ${dep}`,
        );
        failures += 1;
      }
    }
  }
}

if (failures > 0) process.exit(1);
console.log("boundaries: ok");
