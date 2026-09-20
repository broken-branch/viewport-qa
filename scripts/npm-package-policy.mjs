import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function assertNoPackageScripts(manifest, label = "npm package") {
  const scripts = manifest?.scripts;
  if (scripts !== undefined && (typeof scripts !== "object" || scripts === null || Array.isArray(scripts) || Object.keys(scripts).length > 0)) {
    throw new Error(`${label} must not contain scripts`);
  }
}

function assertPortableRelativePath(path, label) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.startsWith("//")) {
    throw new Error(`${label} must be a non-empty repository-relative POSIX path: ${String(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, current, or parent segments: ${path}`);
  }
}

function assertContained(root, candidate, label, allowRoot = false) {
  const path = relative(root, candidate);
  if ((!allowRoot && path === "") || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path)) {
    throw new Error(`${label} escapes its approved root`);
  }
}

export async function resolveInventoryCopy(repoRoot, outputRoot, entry) {
  assertPortableRelativePath(entry?.source, "package inventory source");
  assertPortableRelativePath(entry?.destination, "package inventory destination");
  const canonicalRepo = await realpath(repoRoot);
  const canonicalOutput = await realpath(outputRoot);
  const source = resolve(canonicalRepo, entry.source);
  assertContained(canonicalRepo, source, "package inventory source");
  const sourceItem = await lstat(source);
  if (sourceItem.isSymbolicLink() || !sourceItem.isFile()) throw new Error(`package inventory source must be a regular non-symlink file: ${entry.source}`);
  const canonicalSource = await realpath(source);
  assertContained(canonicalRepo, canonicalSource, "package inventory source realpath");

  const destination = resolve(canonicalOutput, entry.destination);
  assertContained(canonicalOutput, destination, "package inventory destination");
  await mkdir(resolve(destination, ".."), { recursive: true });
  const canonicalParent = await realpath(resolve(destination, ".."));
  assertContained(canonicalOutput, canonicalParent, "package inventory destination parent", true);
  const canonicalDestination = resolve(canonicalParent, entry.destination.split("/").at(-1));
  assertContained(canonicalOutput, canonicalDestination, "package inventory destination realpath");
  try {
    const destinationItem = await lstat(canonicalDestination);
    if (destinationItem.isSymbolicLink() || !destinationItem.isFile()) throw new Error(`package inventory destination must be a regular non-symlink file: ${entry.destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { source: canonicalSource, destination: canonicalDestination };
}
