import { lstat, realpath } from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";

/**
 * Confirms that an existing path has no symbolic-link/junction component.
 * POSIX retains strict canonical spelling. Windows deliberately uses component
 * inspection because realpath expands harmless 8.3 aliases such as RUNNER~1.
 */
export async function isLinkFreeExistingPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const absolute = resolve(path);
  if (platform !== "win32") {
    return realpath(absolute).then((canonical) => canonical === absolute, () => false);
  }
  const root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    let item;
    try { item = await lstat(current); }
    catch { return false; }
    // Node reports both file symlinks and directory junctions as symbolic links.
    if (item.isSymbolicLink()) return false;
  }
  return true;
}

export interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

export async function linkFreeDirectoryIdentity(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DirectoryIdentity | undefined> {
  if (!await isLinkFreeExistingPath(path, platform)) return undefined;
  const item = await lstat(path, { bigint: true }).catch(() => undefined);
  if (!item?.isDirectory() || item.isSymbolicLink()) return undefined;
  return { dev: item.dev, ino: item.ino };
}

export function sameDirectoryIdentity(
  left: DirectoryIdentity | undefined,
  right: DirectoryIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}
