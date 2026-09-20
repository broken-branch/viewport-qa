import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNoPackageScripts, resolveInventoryCopy } from "./npm-package-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(readFileSync(join(root, "version.json"), "utf8")).version;
const temporaryRoot = mkdtempSync(join(tmpdir(), "viewport-qa-package-security-"));

function expectFailure(action, pattern) {
  try {
    action();
  } catch (error) {
    if (!pattern.test(error instanceof Error ? error.message : String(error))) throw error;
    return;
  }
  throw new Error(`expected failure matching ${pattern}`);
}

async function expectAsyncFailure(action, pattern) {
  try {
    await action();
  } catch (error) {
    if (!pattern.test(error instanceof Error ? error.message : String(error))) throw error;
    return;
  }
  throw new Error(`expected failure matching ${pattern}`);
}

try {
  expectFailure(() => assertNoPackageScripts({ scripts: { preinstall: "node harmless-sentinel.mjs" } }, "fixture manifest"), /must not contain scripts/u);

  const inventoryRoot = join(temporaryRoot, "inventory");
  const repository = join(inventoryRoot, "repo");
  const output = join(inventoryRoot, "output");
  const outsideFile = join(inventoryRoot, "outside.txt");
  mkdirSync(repository, { recursive: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(outsideFile, "external bytes\n");
  symlinkSync(outsideFile, join(repository, "README.md"), "file");
  await expectAsyncFailure(
    () => resolveInventoryCopy(repository, output, { source: "README.md", destination: "README.md" }),
    /regular non-symlink file/u,
  );
  await expectAsyncFailure(
    () => resolveInventoryCopy(repository, output, { source: "..\\outside.txt", destination: "README.md" }),
    /repository-relative POSIX path/u,
  );
  const outsideDirectory = join(inventoryRoot, "outside-directory");
  mkdirSync(outsideDirectory);
  symlinkSync(outsideDirectory, join(output, "docs"), "dir");
  writeFileSync(join(repository, "safe.txt"), "safe\n");
  await expectAsyncFailure(
    () => resolveInventoryCopy(repository, output, { source: "safe.txt", destination: "docs/safe.txt" }),
    /destination parent escapes its approved root/u,
  );

  const maliciousPackage = join(temporaryRoot, "malicious-package");
  const marker = join(temporaryRoot, "preinstall-marker");
  mkdirSync(maliciousPackage);
  writeFileSync(join(maliciousPackage, "README.md"), "fixture\n");
  writeFileSync(join(maliciousPackage, "package.json"), `${JSON.stringify({
    name: "viewport-qa",
    version: expectedVersion,
    files: ["README.md"],
    scripts: { preinstall: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`)}` },
  }, null, 2)}\n`);
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, maliciousPackage], { cwd: root, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`failed to create harmless malicious fixture: ${packed.stderr}`);
  const tarball = join(temporaryRoot, JSON.parse(packed.stdout)[0].filename);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const verifier = join(root, "scripts", "test-npm-package-browser.mjs");
  const cache = join(temporaryRoot, "browser-cache-must-not-exist");
  const scriptRejection = spawnSync(process.execPath, [verifier, tarball, digest, cache], { cwd: root, encoding: "utf8" });
  if (scriptRejection.status === 0 || !/must not contain scripts/u.test(`${scriptRejection.stdout}\n${scriptRejection.stderr}`)) {
    throw new Error(`browser verifier did not reject preinstall before installation: ${scriptRejection.stdout}\n${scriptRejection.stderr}`);
  }
  if (existsSync(marker)) throw new Error("browser verifier ran the rejected preinstall fixture");
  const digestRejection = spawnSync(process.execPath, [verifier, tarball, "0".repeat(64), cache], { cwd: root, encoding: "utf8" });
  if (digestRejection.status === 0 || !/SHA-256 mismatch/u.test(`${digestRejection.stdout}\n${digestRejection.stderr}`)) {
    throw new Error("browser verifier did not reject an unauthenticated tarball");
  }
  if (existsSync(marker)) throw new Error("browser verifier installed bytes before authenticating the tarball");

  console.log("npm package security negative fixtures passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
