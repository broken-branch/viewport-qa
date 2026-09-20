import { lookup } from "node:dns/promises";
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { isLinkFreeExistingPath } from "./path-safety.js";

export interface TargetPolicyOptions {
  targetUrl: string;
  allowedOrigins?: readonly string[];
}

export interface TargetPolicy {
  readonly targetUrl: string;
  readonly allowedOrigins: ReadonlySet<string>;
  /** Chromium resolver pins established before the browser process starts. */
  readonly chromiumArgs: readonly string[];
  /** Independent per-browser-context violation ledger. */
  fork(): TargetPolicy;
  assertUrl(rawUrl: string, kind: string): Promise<void>;
  recordViolation(message: string): void;
  waitForViolation(): Promise<void>;
  assertNoViolations(): void;
  install(context: BrowserContext): Promise<void>;
}

function normalizedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`invalid allowed origin: ${value}`); }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`allowed origin must be an exact HTTP(S) origin without credentials, path, query, or fragment: ${value}`);
  }
  return url.origin;
}

type Cidr = readonly [base: bigint, prefix: number];

const IPV4_NON_PUBLIC: readonly Cidr[] = [
  [0x00000000n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8],
  [0xa9fe0000n, 16], [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24],
  [0xc01fc400n, 24], [0xc034c100n, 24], [0xc0586300n, 24], [0xc0a80000n, 16],
  [0xc0af3000n, 24], [0xc6120000n, 15], [0xc6336400n, 24], [0xcb007100n, 24],
  [0xe0000000n, 4], [0xf0000000n, 4],
];

function ipv6Value(address: string): bigint {
  let value = address.toLowerCase().split("%")[0]!;
  if (value.includes(".")) {
    const match = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(value);
    if (!match) throw new Error(`invalid embedded IPv4 address: ${address}`);
    const bytes = match.slice(2).map(Number);
    value = `${match[1]}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) throw new Error(`invalid IPv6 address: ${address}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (parts.length !== 8) throw new Error(`invalid IPv6 address: ${address}`);
  return parts.reduce((result, part) => (result << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

const ipv6 = (address: string): bigint => ipv6Value(address);
const IPV6_NON_PUBLIC: readonly Cidr[] = [
  // IANA IPv6 Special-Purpose Address Space, updated 2025-10-09,
  // plus deprecated IPv4-compatible and protocol-defined multicast space.
  [ipv6("::"), 96], [ipv6("::ffff:0:0"), 96], [ipv6("::ffff:0:0:0"), 96],
  [ipv6("64:ff9b::"), 96], [ipv6("64:ff9b:1::"), 48],
  [ipv6("100::"), 64], [ipv6("100:0:0:1::"), 64], [ipv6("2001::"), 32],
  [ipv6("2001:1::1"), 128], [ipv6("2001:1::2"), 128], [ipv6("2001:1::3"), 128],
  [ipv6("2001:2::"), 48], [ipv6("2001:3::"), 32], [ipv6("2001:4:112::"), 48],
  [ipv6("2001:10::"), 28], [ipv6("2001:20::"), 28], [ipv6("2001:30::"), 28],
  [ipv6("2001:db8::"), 32], [ipv6("2002::"), 16], [ipv6("2620:4f:8000::"), 48],
  [ipv6("3fff::"), 20], [ipv6("5f00::"), 16], [ipv6("fc00::"), 7],
  [ipv6("fe80::"), 10], [ipv6("ff00::"), 8],
];

function inCidr(value: bigint, bits: number, [base, prefix]: Cidr): boolean {
  return prefix === 0 || value >> BigInt(bits - prefix) === base >> BigInt(bits - prefix);
}

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv4Private(address: string): boolean {
  const value = ipv4Value(address);
  return IPV4_NON_PUBLIC.some((range) => inCidr(value, 32, range));
}

function embeddedIpv4(address: string): string | undefined {
  const value = ipv6Value(address);
  const upper96 = value >> 32n;
  if (upper96 !== 0n && upper96 !== 0xffffn && upper96 !== 0xffff0000n) return undefined;
  const low = Number(value & 0xffffffffn);
  return `${low >>> 24}.${(low >>> 16) & 255}.${(low >>> 8) & 255}.${low & 255}`;
}

function ipv6Private(address: string): boolean {
  const value = ipv6Value(address);
  const embedded = embeddedIpv4(address);
  return (embedded !== undefined && ipv4Private(embedded)) || IPV6_NON_PUBLIC.some((range) => inCidr(value, 128, range));
}

export function isPrivateNetworkAddress(address: string): boolean {
  return isIP(address) === 4 ? ipv4Private(address) : isIP(address) === 6 ? ipv6Private(address) : true;
}

function isLoopbackAddress(address: string): boolean {
  const embedded = isIP(address) === 6 ? embeddedIpv4(address) : undefined;
  return address === "::1" || address.startsWith("127.") || embedded?.startsWith("127.") === true;
}

async function addresses(hostname: string): Promise<string[]> {
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (isIP(hostname)) return [hostname];
  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length) throw new Error(`target hostname did not resolve: ${hostname}`);
  return [...new Set(answers.map((answer) => answer.address))];
}

function socketOrigin(url: URL): string {
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

export async function createTargetPolicy(options: TargetPolicyOptions): Promise<TargetPolicy> {
  const target = new URL(options.targetUrl);
  const explicitOrigins = new Set((options.allowedOrigins ?? []).map(normalizedOrigin));
  const allowedOrigins = new Set(explicitOrigins);
  let fileRoot: string | undefined;
  let targetNetworkClass: "file" | "loopback" | "public" = "file";
  const admittedAddresses = new Map<string, string[]>();
  async function admitHostname(hostname: string): Promise<string[]> {
    const prior = admittedAddresses.get(hostname);
    if (prior) return prior;
    const resolved = await addresses(hostname);
    const local = resolved.every(isLoopbackAddress);
    if (!local && resolved.some(isPrivateNetworkAddress)) throw new Error(`public target resolves to a private or reserved address: ${hostname}`);
    admittedAddresses.set(hostname, resolved);
    return resolved;
  }
  if (target.protocol === "file:") {
    const targetPath = resolve(fileURLToPath(target));
    const targetItem = await lstat(targetPath);
    if (!targetItem.isFile() || targetItem.isSymbolicLink()) throw new Error("local target must be a regular non-symlink file");
    const requestedRoot = dirname(targetPath);
    fileRoot = requestedRoot;
    if (!await isLinkFreeExistingPath(requestedRoot) || !await isLinkFreeExistingPath(targetPath)) throw new Error("local target path must not resolve through a symlink");
  } else if (/^https?:$/u.test(target.protocol)) {
    const resolved = await admitHostname(target.hostname);
    const local = resolved.every(isLoopbackAddress);
    targetNetworkClass = local ? "loopback" : "public";
    // The target origin is admitted by the act of naming it; only redirect and
    // resource origins beyond it need an explicit --allow-origin.
    allowedOrigins.add(target.origin);
  } else {
    throw new Error(`restricted mode supports only HTTP(S) URLs and local files: ${target.protocol}`);
  }

  for (const origin of explicitOrigins) {
    const hostname = new URL(origin).hostname;
    const resolved = await admitHostname(hostname);
    if (targetNetworkClass === "public" && resolved.every(isLoopbackAddress)) {
      throw new Error(`public targets cannot admit a loopback/private origin: ${origin}`);
    }
  }
  const resolverRules = [...admittedAddresses.entries()]
    .filter(([hostname]) => isIP(hostname) === 0)
    .map(([hostname, resolved]) => {
      const selected = resolved.find((address) => isIP(address) === 4) ?? resolved[0]!;
      return `MAP ${hostname} ${isIP(selected) === 6 ? `[${selected}]` : selected}`;
    });
  const chromiumArgs = resolverRules.length ? [`--host-resolver-rules=${resolverRules.join(",")}`] : [];
  // DNS class is a scan-wide observation. A change across crawl pages must
  // still fail closed even though each browser context has its own violation
  // ledger.
  const observedClass = new Map<string, "loopback" | "public">();

  function makePolicy(): TargetPolicy {
    const violations: string[] = [];
    let signalViolation!: () => void;
    const violationSignal = new Promise<void>((resolvePromise) => { signalViolation = resolvePromise; });
    function recordViolation(message: string): void {
      violations.push(message);
      signalViolation();
    }
    async function assertNetwork(url: URL, kind: string): Promise<void> {
      const origin = /^wss?:$/u.test(url.protocol) ? socketOrigin(url) : url.origin;
      if (!allowedOrigins.has(origin)) throw new Error(`${kind} blocked outside the explicit origin allowlist: ${origin}`);
      const resolved = await addresses(url.hostname);
      const addressClass = resolved.every(isLoopbackAddress) ? "loopback" : "public";
      const prior = observedClass.get(url.hostname);
      if (prior && prior !== addressClass) throw new Error(`${kind} blocked after DNS address-class change: ${url.hostname}`);
      observedClass.set(url.hostname, addressClass);
      if (addressClass === "loopback" && !resolved.every(isLoopbackAddress)) throw new Error(`${kind} blocked mixed loopback DNS answers`);
      if (addressClass === "public" && resolved.some(isPrivateNetworkAddress)) throw new Error(`${kind} blocked private or reserved DNS answer`);
    }

    async function assertUrl(rawUrl: string, kind: string): Promise<void> {
      const url = new URL(rawUrl);
      if (["data:", "blob:", "about:"].includes(url.protocol)) return;
      if (url.protocol === "file:") {
        if (!fileRoot) throw new Error(`${kind} blocked local-file access from a network target`);
        const path = resolve(fileURLToPath(url));
        if (path !== fileRoot && !path.startsWith(fileRoot + sep)) throw new Error(`${kind} blocked outside the selected file directory`);
        const item = await lstat(path);
        if (!item.isFile() || item.isSymbolicLink() || !await isLinkFreeExistingPath(path)) throw new Error(`${kind} blocked a symlink or non-regular local file`);
        return;
      }
      if (!/^https?:$|^wss?:$/u.test(url.protocol)) throw new Error(`${kind} blocked unsupported protocol: ${url.protocol}`);
      await assertNetwork(url, kind);
    }

    return {
      targetUrl: target.href,
      allowedOrigins,
      chromiumArgs,
      fork: makePolicy,
      assertUrl,
      recordViolation,
      waitForViolation(): Promise<void> { return violationSignal; },
      assertNoViolations(): void {
        if (violations.length) {
          const distinct = [...new Set(violations)];
          throw new Error(`restricted target policy blocked the scan: ${distinct.join("; ")}`);
        }
      },
      async install(context: BrowserContext): Promise<void> {
        await context.route("**/*", async (route, request) => {
          try { await assertUrl(request.url(), `${request.resourceType()} request`); await route.continue(); }
          catch (error) { recordViolation(error instanceof Error ? error.message : String(error)); await route.abort("blockedbyclient"); }
        });
        await context.routeWebSocket("**/*", async (route) => {
          try { await assertUrl(route.url(), "WebSocket"); route.connectToServer(); }
          catch (error) { recordViolation(error instanceof Error ? error.message : String(error)); route.close({ code: 1008, reason: "Blocked by Viewport QA target policy" }); }
        });
      },
    };
  }
  return makePolicy();
}

export function denyDownloads(page: Page, policy: TargetPolicy): void {
  page.on("download", (download) => {
    policy.recordViolation(`download blocked by restricted target policy: ${download.suggestedFilename()}`);
    void download.cancel();
  });
}

/** Reject every secondary page and intercept its requests before network contact. */
export async function denyChildPages(
  context: BrowserContext,
  policy: TargetPolicy,
): Promise<void> {
  const binding = "__viewportQaBlockedChildPage__";
  let primaryPage: Page | undefined;
  await context.exposeBinding(binding, () => {
    policy.recordViolation("child page blocked by restricted target policy");
  });
  await context.addInitScript(({ bindingName }) => {
    const report = (globalThis as unknown as Record<string, () => Promise<void>>)[bindingName]!;
    const block = (): void => { void report(); };
    const opensNewContext = (target: string | null): boolean => {
      const normalized = target?.trim().toLowerCase() ?? "";
      return normalized !== "" && !["_self", "_top", "_parent"].includes(normalized);
    };
    Object.defineProperty(window, "open", {
      configurable: false,
      writable: false,
      value: () => { block(); return null; },
    });
    addEventListener("click", (event) => {
      const element = event.target instanceof Element ? event.target.closest("a, area") : null;
      if (element && opensNewContext(element.getAttribute("target"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        block();
      }
    }, true);
    addEventListener("submit", (event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (form && opensNewContext(form.getAttribute("target"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        block();
      }
    }, true);
    const nativeSubmit = HTMLFormElement.prototype.submit;
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      configurable: false,
      writable: false,
      value: function submit(this: HTMLFormElement): void {
        if (opensNewContext(this.getAttribute("target"))) { block(); return; }
        nativeSubmit.call(this);
      },
    });
  }, { bindingName: binding });
  context.on("page", (page) => {
    if (primaryPage === undefined) {
      primaryPage = page;
      return;
    }
    if (page === primaryPage) return;
    policy.recordViolation("child page blocked by restricted target policy");
    void page.close().catch(() => {});
  });
  await context.route("**/*", async (route, request) => {
    let page: Page;
    try {
      page = request.frame().page();
    } catch {
      await route.fallback();
      return;
    }
    if (primaryPage !== undefined && page !== primaryPage) {
      policy.recordViolation(`child page request blocked by restricted target policy: ${request.url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
}

/** Pause and close related page targets before Chromium can issue their first navigation request. */
export async function installChildPageTargetGuard(
  primaryPage: Page,
  policy: TargetPolicy,
): Promise<() => Promise<void>> {
  const browser = primaryPage.context().browser();
  if (!browser) throw new Error("restricted target policy requires an attached browser");
  const pageSession = await primaryPage.context().newCDPSession(primaryPage);
  const primaryTarget = (await pageSession.send("Target.getTargetInfo")).targetInfo;
  const session = await browser.newBrowserCDPSession();
  session.on("Target.attachedToTarget", (event) => {
    void (async () => {
      const sameContext = event.targetInfo.browserContextId === primaryTarget.browserContextId;
      if (
        event.targetInfo.type === "page" &&
        sameContext &&
        event.targetInfo.targetId !== primaryTarget.targetId
      ) {
        policy.recordViolation("child page blocked at the browser target boundary");
        await session.send("Target.closeTarget", { targetId: event.targetInfo.targetId });
      }
    })().catch((error) => {
      policy.recordViolation(`child page target guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  await session.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: "page", exclude: false },
      { exclude: true },
    ],
  });
  return async () => {
    await session.detach().catch(() => {});
  };
}

/** Stop a denied HTTP redirect at Chromium's response boundary, before it can issue the next request. */
export async function installRedirectGuard(
  page: Page,
  policy: TargetPolicy,
  options: { releaseTimeoutMs?: number } = {},
): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  await session.send("Fetch.enable", { patterns: [{ requestStage: "Response" }] });
  const releaseTimeoutMs = options.releaseTimeoutMs ?? 2_000;
  let teardown = false;
  const pending = new Set<Promise<void>>();
  const expectedTeardownError = (error: unknown): boolean =>
    error instanceof Error && /Target page, context or browser has been closed|Session closed|Target closed|Connection closed|browser has disconnected/iu.test(error.message);
  const recordGuardFailure = (prefix: string, error: unknown): void => {
    if (teardown && expectedTeardownError(error)) return;
    policy.recordViolation(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const onPaused = (event: {
    requestId: string;
    request: { url: string };
    responseStatusCode?: number;
    responseHeaders?: Array<{ name: string; value: string }>;
  }): void => {
    const task = (async () => {
      try {
        const status = event.responseStatusCode ?? 0;
        const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === "location")?.value;
        if (status >= 300 && status < 400 && location) {
          await policy.assertUrl(new URL(location, event.request.url).href, "redirect");
        }
        const disposition = event.responseHeaders?.find(
          (header) => header.name.toLowerCase() === "content-disposition",
        )?.value;
        if (disposition && /^\s*attachment(?:\s*;|$)/iu.test(disposition)) {
          policy.recordViolation(`download response blocked by restricted target policy: ${event.request.url}`);
          await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
          return;
        }
        await session.send("Fetch.continueResponse", { requestId: event.requestId });
      } catch (error) {
        recordGuardFailure("redirect guard failed closed", error);
        try {
          await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
        } catch (fallbackError) {
          recordGuardFailure("redirect guard fallback failed closed", fallbackError);
        }
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };
  session.on("Fetch.requestPaused", onPaused);
  const boundedReleaseStep = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolvePromise, rejectPromise) => {
          timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${releaseTimeoutMs}ms`)), releaseTimeoutMs);
        }),
      ]);
    } catch (error) {
      recordGuardFailure(`${label} failed closed`, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return async () => {
    session.off("Fetch.requestPaused", onPaused);
    await boundedReleaseStep("redirect guard drain", () => Promise.allSettled([...pending]));
    teardown = true;
    await boundedReleaseStep("redirect guard disable", () => session.send("Fetch.disable"));
    await boundedReleaseStep("redirect guard detach", () => session.detach());
  };
}
