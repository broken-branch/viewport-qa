import { chmod, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function preserveCliExecutableMode(path, platform = process.platform) {
  if (platform === "win32") return { path: resolve(path), changed: false };
  const target = resolve(path);
  const before = await stat(target);
  const nextMode = before.mode | 0o111;
  if (nextMode !== before.mode) await chmod(target, nextMode);
  return { path: target, changed: nextMode !== before.mode };
}

async function main(argv) {
  if (argv.length > 1) {
    throw new Error("Usage: node scripts/set-cli-executable.mjs [path]");
  }
  const result = await preserveCliExecutableMode(
    argv[0] ?? "packages/cli/dist/bin.js",
  );
  console.log(`${result.changed ? "updated" : "verified"}: ${result.path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
