import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPackageScripts } from "./npm-package-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVersion = JSON.parse(readFileSync(join(root, "version.json"), "utf8")).version;
const packageRoot = join(root, "dist", "npm");
const temporaryRoot = mkdtempSync(join(tmpdir(), "viewport-qa-package-"));

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    cwd: options.cwd ?? root,
    timeout: options.timeout ?? 120_000,
  });
  if (options.exitCodes ? !options.exitCodes.includes(result.status) : result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function packedFiles(packJson) {
  if (!Array.isArray(packJson) || packJson.length !== 1) fail("npm pack JSON must contain exactly one package");
  return packJson[0].files.map((entry) => entry.path).sort();
}

function assertEqualInventory(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} inventory mismatch\nactual: ${JSON.stringify(actual, null, 2)}\nexpected: ${JSON.stringify(expected, null, 2)}`);
  }
}

try {
  run(process.execPath, [join(root, "scripts", "build-npm-package.mjs")]);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "viewport-qa" || manifest.version !== expectedVersion) fail("unexpected npm package identity");
  if (manifest.private !== undefined) fail("public package must not carry private metadata");
  if (Object.keys(manifest.dependencies).sort().join(",") !== "playwright,pngjs") fail("unexpected runtime dependencies");
  assertNoPackageScripts(manifest, "built npm package manifest");

  const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json", packageRoot]).stdout);
  const dryRunFiles = packedFiles(dryRun);
  const packResult = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temporaryRoot, packageRoot]).stdout);
  const actualPackFiles = packedFiles(packResult);
  assertEqualInventory("npm dry-run/pack", actualPackFiles, dryRunFiles);

  const tarballPath = join(temporaryRoot, packResult[0].filename);
  const tarFiles = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
    .trim().split("\n").filter((path) => path && !path.endsWith("/")).map((path) => path.replace(/^package\//u, "")).sort();
  assertEqualInventory("npm dry-run/tarball", tarFiles, dryRunFiles);
  assertEqualInventory("manifest files allowlist/tarball", tarFiles, [...manifest.files, "package.json"].sort());
  const packedManifest = JSON.parse(execFileSync("tar", ["-xOzf", tarballPath, "package/package.json"], { encoding: "utf8" }));
  if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version || packedManifest.private !== undefined) {
    fail("tarball package metadata does not preserve the public package identity");
  }
  if (packedManifest.bin?.vqa?.replace(/^\.\//u, "") !== "dist/bin.js" || packedManifest.exports?.["."]?.import !== "./dist/index.js") {
    fail("tarball package metadata has incorrect normalized bin or exports");
  }
  if (Object.keys(packedManifest.dependencies ?? {}).sort().join(",") !== "playwright,pngjs") {
    fail("tarball package metadata has unexpected runtime dependencies");
  }
  assertNoPackageScripts(packedManifest, "tarball npm package manifest");

  const forbidden = tarFiles.filter((path) =>
    /(^|\/)(test|tests|fixtures)(\/|$)|\.map$|\.tsbuildinfo$|(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$/u.test(path)
    || path !== "package.json" && /(^|\/)package\.json$/u.test(path)
    || path.startsWith("packages/") || path.startsWith("reports/"));
  if (forbidden.length > 0) fail(`forbidden tarball files: ${forbidden.join(", ")}`);
  const required = ["package.json", "README.md", "LICENSE", "SECURITY.md", "THIRD-PARTY-NOTICES.txt", "PACKAGE-CONTENTS.json", "dist/bin.js", "dist/index.js", "dist/index.d.ts", "docs/AI-CONSUMPTION.md"];
  for (const path of required) if (!tarFiles.includes(path)) fail(`required tarball file missing: ${path}`);
  for (const path of tarFiles) {
    const textCandidate = /\.(?:js|json|md|txt|d\.ts)$/u.test(path) || ["LICENSE", "README.md"].includes(path);
    if (!textCandidate) continue;
    const body = execFileSync("tar", ["-xOzf", tarballPath, `package/${path}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    if (/workspace:|\/home\/|\/Users\/|[A-Za-z]:\\Users\\/u.test(body) || body.includes(root)) fail(`repository-only or local path leaked in ${path}`);
  }

  const consumerRoot = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  const browserCache = join(temporaryRoot, "managed-browser-cache");
  const playwrightCache = join(temporaryRoot, "playwright-browser-cache");
  run(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(consumerRoot)},{recursive:true});require("node:fs").writeFileSync(${JSON.stringify(join(consumerRoot, "package.json"))},JSON.stringify({name:"clean-viewport-qa-consumer",private:true,version:"1.0.0"})+"\\n")`]);
  const consumerEnv = {
    ...process.env,
    npm_config_cache: npmCache,
    PLAYWRIGHT_BROWSERS_PATH: playwrightCache,
    VQA_BROWSER_CACHE: browserCache,
    VQA_BROWSER_OFFLINE: "1",
  };
  const install = run("npm", ["install", "--foreground-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: consumerRoot, env: consumerEnv, timeout: 180_000 });
  if (/download(?:ing)?\s+(?:chromium|chrome)|installing\s+(?:chromium|chrome)/iu.test(`${install.stdout}\n${install.stderr}`)) {
    fail("npm lifecycle output indicates a browser download");
  }
  if (existsSync(playwrightCache) && readdirSync(playwrightCache).length > 0) fail("npm install populated the Playwright browser cache");
  if (existsSync(browserCache) && readdirSync(browserCache).length > 0) fail("npm install populated the Viewport QA browser cache");

  const bin = join(consumerRoot, "node_modules", ".bin", process.platform === "win32" ? "vqa.cmd" : "vqa");
  const version = run(bin, ["--version"], { cwd: consumerRoot, env: consumerEnv });
  if (version.stdout.trim() !== expectedVersion) fail(`unexpected packaged version: ${version.stdout.trim()}`);
  const help = run(bin, ["--help"], { cwd: consumerRoot, env: consumerEnv });
  if (!help.stdout.includes("Usage:") || !help.stdout.includes("Viewport QA")) fail("packaged help output is incomplete");
  const usage = run(bin, [], { cwd: consumerRoot, env: consumerEnv, exitCodes: [2] });
  if (!usage.stderr.includes("Usage:")) fail("packaged usage failure is incomplete");
  const doctorJson = run(bin, ["doctor", "--json"], { cwd: consumerRoot, env: consumerEnv, exitCodes: [1] });
  const doctor = JSON.parse(doctorJson.stdout);
  if (doctor.ok !== false || doctor.product.version !== expectedVersion || doctor.browser.health !== "missing" || doctor.browser.recoveryCommand !== "vqa browser install") {
    fail("packaged missing-browser doctor JSON is invalid");
  }
  const doctorHuman = run(bin, ["doctor"], { cwd: consumerRoot, env: consumerEnv, exitCodes: [1] });
  if (!doctorHuman.stdout.includes(`Viewport QA ${expectedVersion} doctor`) || !doctorHuman.stdout.includes("Browser: missing")) fail("packaged missing-browser doctor text is invalid");
  const browserStatus = JSON.parse(run(bin, ["browser", "status", "--json"], { cwd: consumerRoot, env: consumerEnv, exitCodes: [1] }).stdout);
  if (browserStatus.ok !== false || browserStatus.browser.health !== "missing") fail("packaged browser status JSON is invalid");
  const npxVersion = run("npx", ["--offline", "--no-install", "vqa", "--version"], { cwd: consumerRoot, env: consumerEnv });
  if (npxVersion.stdout.trim() !== expectedVersion) fail("npx did not execute the installed packaged bytes");

  console.log(JSON.stringify({
    ok: true,
    package: `${manifest.name}@${manifest.version}`,
    tarball: tarballPath,
    files: tarFiles,
    dependencies: manifest.dependencies,
    cleanConsumer: ["local-bin", "npx", "version", "help", "usage", "doctor-json-missing", "doctor-human-missing", "browser-status-missing", "no-lifecycle-browser-download"],
  }, null, 2));
} finally {
  if (process.env.VQA_KEEP_PACKAGE_TEST_TEMP !== "1") rmSync(temporaryRoot, { recursive: true, force: true });
}
