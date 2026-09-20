import { chromium } from "playwright";
import type { Browser, LaunchOptions } from "playwright";

/** Launch the managed browser without Playwright's sandbox-disabling default. */
export function launchSandboxedChromium(
  options: Omit<LaunchOptions, "chromiumSandbox"> = {},
): Promise<Browser> {
  return chromium.launch({ ...options, chromiumSandbox: true });
}
