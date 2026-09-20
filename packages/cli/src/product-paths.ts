import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ProductPaths {
  stateRoot: string;
  cacheRoot: string;
  browserCacheRoot: string;
  logRoot: string;
  reportsRoot: string;
}

export interface ProductPathEnvironment {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  localAppData?: string;
}

export function resolveProductPaths(options: ProductPathEnvironment = {}): ProductPaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const paths = platform === "win32" ? win32 : posix;
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA ?? paths.join(home, "AppData", "Local");
  if (platform === "win32") {
    return {
      stateRoot: paths.resolve(localAppData, "Viewport QA", "state"),
      cacheRoot: paths.resolve(localAppData, "Viewport QA", "cache"),
      browserCacheRoot: paths.resolve(localAppData, "Viewport QA", "browser-cache"),
      logRoot: paths.resolve(localAppData, "Viewport QA", "logs"),
      reportsRoot: paths.resolve(home, "Viewport QA Reports"),
    };
  }
  if (platform === "darwin") {
    return {
      stateRoot: paths.resolve(home, "Library", "Application Support", "Viewport QA"),
      cacheRoot: paths.resolve(home, "Library", "Caches", "Viewport QA"),
      browserCacheRoot: paths.resolve(home, "Library", "Caches", "Viewport QA", "browser-cache"),
      logRoot: paths.resolve(home, "Library", "Logs", "Viewport QA"),
      reportsRoot: paths.resolve(home, "Viewport QA Reports"),
    };
  }
  const stateBase = environment.XDG_STATE_HOME ?? paths.join(home, ".local", "state");
  const cacheBase = environment.XDG_CACHE_HOME ?? paths.join(home, ".cache");
  return {
    stateRoot: paths.resolve(stateBase, "viewport-qa"),
    cacheRoot: paths.resolve(cacheBase, "viewport-qa"),
    browserCacheRoot: paths.resolve(cacheBase, "viewport-qa", "browser-cache"),
    logRoot: paths.resolve(stateBase, "viewport-qa", "logs"),
    reportsRoot: paths.resolve(home, "Viewport QA Reports"),
  };
}
