import { createRequire } from "node:module";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertNoPackageScripts, resolveInventoryCopy } from "./npm-package-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "dist", "npm");
const templatePath = join(root, "release", "npm", "package-template.json");
const contentPath = join(root, "release", "npm", "package-content.json");
const packageTemplate = JSON.parse(await readFile(templatePath, "utf8"));
const contentInventory = JSON.parse(await readFile(contentPath, "utf8"));
const sourceVersion = JSON.parse(await readFile(join(root, "version.json"), "utf8")).version;

if (packageTemplate.version !== sourceVersion) {
  throw new Error(`npm package version ${packageTemplate.version} does not match version.json ${sourceVersion}`);
}
if (packageTemplate.private === true) throw new Error("npm package template must be public");
if (Object.keys(packageTemplate.dependencies).sort().join(",") !== "playwright,pngjs") {
  throw new Error("npm runtime dependencies must be exactly playwright and pngjs");
}
assertNoPackageScripts(packageTemplate, "npm package template");
const generatedFiles = new Set(["dist/bin.js", "dist/index.js", "dist/index.d.ts", "THIRD-PARTY-NOTICES.txt", "PACKAGE-CONTENTS.json"]);
const copyDestinations = contentInventory.copies.map((entry) => entry.destination).sort();
const declaredCopies = packageTemplate.files.filter((path) => !generatedFiles.has(path)).sort();
if (new Set(copyDestinations).size !== copyDestinations.length || JSON.stringify(copyDestinations) !== JSON.stringify(declaredCopies)) {
  throw new Error("package content inventory must exactly match the non-generated files allowlist");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "dist"), { recursive: true });

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/npm/dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "bundle",
  alias: {
    "@vqa/contract": "./packages/contract/src/index.ts",
    "@vqa/detectors": "./packages/detectors/src/index.ts",
    "@vqa/engine": "./packages/engine/src/index.ts",
    "@vqa/model-adapter": "./packages/model-adapter/src/index.ts",
  },
  external: ["playwright", "playwright/*", "playwright-core", "playwright-core/*", "pngjs"],
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  logLevel: "silent",
});
const externalImports = [...new Set(Object.values(bundle.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !entry.path.startsWith("node:"))
  .map((entry) => entry.path.split("/").slice(0, entry.path.startsWith("@") ? 2 : 1).join("/")))].sort();
if (externalImports.join(",") !== "playwright,pngjs") {
  throw new Error(`unexpected external bundle imports: ${externalImports.join(", ") || "none"}`);
}

await writeFile(join(outputRoot, "dist", "bin.js"), `#!/usr/bin/env node\nimport { main } from "./index.js";\n\nmain(process.argv.slice(2)).then(\n  (code) => { process.exitCode = code; },\n  (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },\n);\n`);
await chmod(join(outputRoot, "dist", "bin.js"), 0o755);
await writeFile(join(outputRoot, "dist", "index.d.ts"), "export declare function main(argv: string[]): Promise<number>;\n");

for (const entry of contentInventory.copies) {
  const { source, destination } = await resolveInventoryCopy(root, outputRoot, entry);
  await copyFile(source, destination);
}

const requireFromRoot = createRequire(join(root, "package.json"));
const requireFromEngine = createRequire(join(root, "packages", "engine", "package.json"));
function packageRoot(name) {
  if (name === "playwright") return dirname(requireFromRoot.resolve("playwright/package.json"));
  if (name === "pngjs") return dirname(requireFromEngine.resolve("pngjs/package.json"));
  const requireFromPlaywright = createRequire(requireFromRoot.resolve("playwright/package.json"));
  return dirname(requireFromPlaywright.resolve("playwright-core/package.json"));
}
const noticePackages = [
  { name: "playwright", files: ["LICENSE", "NOTICE"] },
  { name: "playwright-core", files: ["LICENSE", "NOTICE", "ThirdPartyNotices.txt"] },
  { name: "pngjs", files: ["LICENSE"] },
];
const noticeSections = [];
for (const item of noticePackages) {
  const packageJson = JSON.parse(await readFile(join(packageRoot(item.name), "package.json"), "utf8"));
  if (packageJson.version !== (item.name === "pngjs" ? "7.0.0" : "1.61.0")) {
    throw new Error(`unexpected ${item.name} version ${packageJson.version}`);
  }
  for (const filename of item.files) {
    const text = await readFile(join(packageRoot(item.name), filename), "utf8");
    noticeSections.push(`--- ${item.name}@${packageJson.version} ${filename} ---\n${text.trim()}\n`);
  }
}
await writeFile(join(outputRoot, "THIRD-PARTY-NOTICES.txt"), `Viewport QA third-party notices\n\nGenerated from the exact external runtime dependencies. Internal @vqa workspaces are bundled into dist/index.js and are not separate packages.\n\n${noticeSections.join("\n")}`);

const packageContents = {
  schemaVersion: 1,
  package: `${packageTemplate.name}@${packageTemplate.version}`,
  bundledInternalWorkspaces: ["@vqa/cli", "@vqa/contract", "@vqa/detectors", "@vqa/engine", "@vqa/model-adapter"],
  externalRuntimePackages: ["playwright@1.61.0", "playwright-core@1.61.0 (exact dependency of playwright)", "pngjs@7.0.0"],
  documentedFiles: packageTemplate.files.filter((path) => path.startsWith("docs/")).sort(),
};
await writeFile(join(outputRoot, "PACKAGE-CONTENTS.json"), `${JSON.stringify(packageContents, null, 2)}\n`);
await writeFile(join(outputRoot, "package.json"), `${JSON.stringify(packageTemplate, null, 2)}\n`);

console.log(`built ${packageTemplate.name}@${packageTemplate.version} in ${outputRoot}`);
