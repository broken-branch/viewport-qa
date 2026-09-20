import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoPackageScripts } from "./npm-package-policy.mjs";

const rawArguments = process.argv.slice(2);
const acceptanceArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const [tarballArgument, expectedDigestArgument, cacheArgument] = acceptanceArguments;
if (acceptanceArguments.length !== 3 || !tarballArgument || !expectedDigestArgument || !cacheArgument) {
  throw new Error("usage: pnpm package:test:browser -- <exact-package.tgz> <expected-sha256> <absolute-empty-vqa-browser-cache>");
}
const tarball = resolve(tarballArgument);
const expectedDigest = expectedDigestArgument.toLowerCase();
const browserCache = cacheArgument;
if (!existsSync(tarball) || !statSync(tarball).isFile()) throw new Error(`tarball not found: ${tarball}`);
if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error("expected SHA-256 must be 64 hexadecimal characters");
if (!isAbsolute(browserCache)) throw new Error("browser cache must be an absolute path");
if (existsSync(browserCache)) throw new Error("browser cache must not exist before lab acceptance");

const root = resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(readFileSync(join(root, "version.json"), "utf8")).version;
let temporaryRoot;
let consumerRoot = root;
let reportRoot;
let npmCache;
let playwrightCache;
const fixture = join(root, "fixtures", "seeded-defects.html");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? consumerRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function assertEqualInventory(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`tarball inventory does not match its manifest files allowlist\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

const actualDigest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (actualDigest !== expectedDigest) throw new Error(`tarball SHA-256 mismatch: expected ${expectedDigest}, observed ${actualDigest}`);
const tarEntries = run("tar", ["-tzf", tarball], { cwd: root }).stdout.trim().split("\n").filter(Boolean);
if (tarEntries.some((path) => !path.startsWith("package/") || path.includes("\\") || path.split("/").includes(".."))) {
  throw new Error("tarball contains a path outside its package root");
}
const tarTypes = run("tar", ["-tvzf", tarball], { cwd: root }).stdout.trim().split("\n").filter(Boolean).map((line) => line[0]);
if (tarTypes.length !== tarEntries.length || tarTypes.some((type) => type !== "-" && type !== "d")) {
  throw new Error("tarball contains a non-regular file or symlink entry");
}
const tarFiles = tarEntries.filter((path) => !path.endsWith("/")).map((path) => path.slice("package/".length)).sort();
if (new Set(tarFiles).size !== tarFiles.length) throw new Error("tarball contains duplicate file entries");
const packedManifest = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"], { cwd: root }).stdout);
if (packedManifest.name !== "viewport-qa" || packedManifest.version !== expectedVersion || packedManifest.private !== undefined) {
  throw new Error("tarball package identity is not the approved public candidate");
}
assertNoPackageScripts(packedManifest, "browser acceptance tarball manifest");
if (!Array.isArray(packedManifest.files) || packedManifest.files.some((path) => typeof path !== "string")) {
  throw new Error("tarball package manifest files allowlist is invalid");
}
assertEqualInventory(tarFiles, [...packedManifest.files, "package.json"].sort());

temporaryRoot = mkdtempSync(join(tmpdir(), "viewport-qa-browser-acceptance-"));
consumerRoot = join(temporaryRoot, "consumer");
reportRoot = join(temporaryRoot, "report");
npmCache = join(temporaryRoot, "npm-cache");
playwrightCache = join(temporaryRoot, "playwright-cache-must-stay-empty");

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = globalThis.setTimeout(() => rejectPromise(new Error("packaged review service did not stop")), timeoutMs);
    child.once("exit", (code, signal) => {
      globalThis.clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`packaged review service exited ${code ?? signal}`));
    });
  });
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((done) => globalThis.setTimeout(done, 25));
  }
  return readFileSync(path, "utf8");
}

async function post(url, capability, body) {
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: { authorization: `VQA ${capability}`, origin: new URL(url).origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${new URL(url).pathname} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

try {
  run(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(consumerRoot)},{recursive:true});require("node:fs").writeFileSync(${JSON.stringify(join(consumerRoot, "package.json"))},JSON.stringify({name:"viewport-qa-browser-acceptance",private:true,version:"1.0.0"})+"\\n")`], { cwd: root });
  const environment = {
    ...process.env,
    npm_config_cache: npmCache,
    PLAYWRIGHT_BROWSERS_PATH: playwrightCache,
    VQA_BROWSER_CACHE: browserCache,
  };
  delete environment.VQA_BROWSER_OFFLINE;
  run("npm", ["install", "--no-audit", "--no-fund", tarball], { env: environment });
  const bin = join(consumerRoot, "node_modules", ".bin", process.platform === "win32" ? "vqa.cmd" : "vqa");
  run(bin, ["browser", "install", "--json"], { env: environment, timeout: 300_000 });
  const browserStatus = JSON.parse(run(bin, ["browser", "status", "--json"], { env: environment }).stdout);
  if (!browserStatus.ok || browserStatus.browser.health !== "installed") throw new Error("managed browser is not healthy after explicit install");
  if (existsSync(playwrightCache)) throw new Error("explicit managed install wrote the global Playwright browser path");

  run(bin, ["scan", fixture, "--viewports", "390x844", "--out", reportRoot], { env: environment, timeout: 180_000 });
  const manifest = JSON.parse(readFileSync(join(reportRoot, "review-manifest.json"), "utf8"));
  const capture = manifest.captures.find((entry) => entry.issue_ids.length > 0);
  if (!capture) throw new Error("deterministic scan produced no issue-bearing capture");
  const issueId = capture.issue_ids[0];

  const openerRoot = join(temporaryRoot, "opener");
  const capturePath = join(openerRoot, "url");
  run(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(openerRoot)},{recursive:true})`], { cwd: root });
  const opener = join(openerRoot, "xdg-open");
  writeFileSync(opener, '#!/bin/sh\numask 077\nprintf "%s" "$1" > "$VQA_LAB_CAPTURE"\n');
  chmodSync(opener, 0o700);
  const serviceEnv = { ...environment, PATH: `${openerRoot}:${process.env.PATH ?? ""}`, VQA_LAB_CAPTURE: capturePath };
  const service = spawn(bin, ["open", reportRoot, "--idle-timeout", "0"], { cwd: consumerRoot, env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => { serviceOutput += chunk; });
  service.stderr.on("data", (chunk) => { serviceOutput += chunk; });
  const launchUrl = new URL(await waitForFile(capturePath));
  const capability = new globalThis.URLSearchParams(launchUrl.hash.slice(1)).get("cap");
  if (!capability) throw new Error("packaged open command did not provide a capability URL");
  const reviewHeaders = { authorization: `VQA ${capability}` };
  const app = await globalThis.fetch(new URL("app", launchUrl), { headers: reviewHeaders });
  if (!app.ok || !(await app.text()).includes("<title>Review screenshots</title>")) throw new Error("packaged review GUI did not load");

  await post(new URL("api/review", launchUrl), capability, {
    coordinateId: capture.coordinate_id,
    classification: "bad",
    requestedChange: "",
    affectedCoordinateIds: [capture.coordinate_id],
    selectedIssueIds: [issueId],
  });
  const persisted = await (await globalThis.fetch(new URL("api/review", launchUrl), { headers: reviewHeaders })).json();
  const request = persisted.captures[capture.coordinate_id]?.requested_change;
  if (request?.requested_change !== "" || request?.selected_issue_ids?.[0] !== issueId) throw new Error("issue-only review did not persist");

  const textPath = join(reportRoot, "package-acceptance-handoff.txt");
  const pdfPath = join(reportRoot, "package-acceptance-handoff.pdf");
  const jsonPath = join(reportRoot, "package-acceptance-handoff.json");
  await post(new URL("api/export", launchUrl), capability, { mode: "save", audience: "human", fileFormat: "txt", destinationPath: textPath });
  await post(new URL("api/export", launchUrl), capability, { mode: "save", audience: "human", fileFormat: "pdf", destinationPath: pdfPath });
  await post(new URL("api/export", launchUrl), capability, { mode: "save", audience: "ai", fileFormat: "json", destinationPath: jsonPath });
  if (!readFileSync(textPath, "utf8").includes("VISUAL QA HANDOFF")) throw new Error("human TXT handoff is invalid");
  if (readFileSync(pdfPath).subarray(0, 5).toString() !== "%PDF-") throw new Error("human PDF handoff is invalid");
  if (JSON.parse(readFileSync(jsonPath, "utf8")).artifact_type !== "viewport-qa-change-request-bundle") throw new Error("AI JSON handoff is invalid");
  const firstExit = waitForExit(service, 10_000);
  await post(new URL("api/stop", launchUrl), capability, {});
  await firstExit;
  if (!serviceOutput.includes("opened secure review")) throw new Error("packaged open command did not report readiness");

  rmSync(capturePath, { force: true });
  const readOnlyService = spawn(bin, ["serve", reportRoot, "--read-only", "--idle-timeout", "0"], { cwd: consumerRoot, env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] });
  const readOnlyUrl = new URL(await waitForFile(capturePath));
  const readOnlyCapability = new globalThis.URLSearchParams(readOnlyUrl.hash.slice(1)).get("cap");
  if (!readOnlyCapability) throw new Error("packaged serve command did not provide a capability URL");
  const rejectedWrite = await globalThis.fetch(new URL("api/review", readOnlyUrl), {
    method: "POST",
    headers: { authorization: `VQA ${readOnlyCapability}`, origin: readOnlyUrl.origin, "content-type": "application/json" },
    body: "{}",
  });
  if (rejectedWrite.status !== 409) throw new Error("packaged read-only serve did not reject review writes");
  const secondExit = waitForExit(readOnlyService, 10_000);
  readOnlyService.kill("SIGTERM");
  await secondExit;

  console.log(JSON.stringify({
    ok: true,
    tarball,
    sha256: actualDigest,
    browser: browserStatus.browser.compatibility,
    acceptance: ["explicit-browser-install", "browser-status", "scan", "open", "serve-read-only", "review-persistence", "issue-only-change-request", "human-txt", "human-pdf", "ai-json", "clean-shutdown"],
  }, null, 2));
} finally {
  if (temporaryRoot && process.env.VQA_KEEP_BROWSER_ACCEPTANCE_TEMP !== "1") rmSync(temporaryRoot, { recursive: true, force: true });
}
