import { describe, expect, it } from "vitest";
import { PRODUCT_CLI_COMMAND, PRODUCT_NAME, PROTOCOL_IDENTITY } from "@vqa/contract";
import { browserDownloadDisclosure } from "../src/browser-download.js";
import { resolveProductPaths } from "../src/product-paths.js";
import { renderLauncherApp } from "../src/launcher-ui.js";

describe("product foundation contract", () => {
  it("pins the product identity", () => {
    expect({ PRODUCT_NAME, PRODUCT_CLI_COMMAND, PROTOCOL_IDENTITY }).toEqual({
      PRODUCT_NAME: "Viewport QA",
      PRODUCT_CLI_COMMAND: "vqa",
      PROTOCOL_IDENTITY: "viewport-qa",
    });
  });

  it("resolves the reviewed no-move state, cache, log, and report paths", () => {
    expect(resolveProductPaths({ platform: "win32", homeDirectory: "C:\\Users\\Newcomer", localAppData: "C:\\Users\\Newcomer\\AppData\\Local", environment: {} })).toEqual({
      stateRoot: "C:\\Users\\Newcomer\\AppData\\Local\\Viewport QA\\state",
      cacheRoot: "C:\\Users\\Newcomer\\AppData\\Local\\Viewport QA\\cache",
      browserCacheRoot: "C:\\Users\\Newcomer\\AppData\\Local\\Viewport QA\\browser-cache",
      logRoot: "C:\\Users\\Newcomer\\AppData\\Local\\Viewport QA\\logs",
      reportsRoot: "C:\\Users\\Newcomer\\Viewport QA Reports",
    });
    expect(resolveProductPaths({ platform: "darwin", homeDirectory: "/Users/newcomer", environment: {} })).toEqual({
      stateRoot: "/Users/newcomer/Library/Application Support/Viewport QA",
      cacheRoot: "/Users/newcomer/Library/Caches/Viewport QA",
      browserCacheRoot: "/Users/newcomer/Library/Caches/Viewport QA/browser-cache",
      logRoot: "/Users/newcomer/Library/Logs/Viewport QA",
      reportsRoot: "/Users/newcomer/Viewport QA Reports",
    });
    expect(resolveProductPaths({ platform: "linux", homeDirectory: "/home/newcomer", environment: { XDG_STATE_HOME: "/state", XDG_CACHE_HOME: "/cache" } })).toEqual({
      stateRoot: "/state/viewport-qa",
      cacheRoot: "/cache/viewport-qa",
      browserCacheRoot: "/cache/viewport-qa/browser-cache",
      logRoot: "/state/viewport-qa/logs",
      reportsRoot: "/home/newcomer/Viewport QA Reports",
    });
  });

  it("discloses only the reviewed connected-browser platform matrix", () => {
    expect(browserDownloadDisclosure("win32", "x64")).toMatchObject({
      supported: true,
      bytes: 192_511_857,
      networkOrigin: "https://cdn.playwright.dev",
    });
    expect(browserDownloadDisclosure("darwin", "arm64")).toMatchObject({ supported: true, bytes: 179_277_110 });
    expect(browserDownloadDisclosure("linux", "x64")).toMatchObject({ supported: true, bytes: 185_646_494 });
    expect(browserDownloadDisclosure("linux", "x64", {
      VQA_BROWSER_MIRROR: "https://mirror.example.invalid/playwright",
    })).toMatchObject({
      supported: true,
      networkOrigin: "https://mirror.example.invalid",
    });
    expect(browserDownloadDisclosure("linux", "x64", {
      VQA_BROWSER_MIRROR: "http://mirror.example.invalid",
    })).not.toHaveProperty("networkOrigin");
    expect(browserDownloadDisclosure("darwin", "x64")).toEqual({ supported: false });
  });

  it("renders a syntactically valid first-run application script", () => {
    const html = renderLauncherApp();
    const script = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(() => Function(script!)).not.toThrow();
  });
});
