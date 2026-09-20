import { randomBytes } from "node:crypto";
import type {
  BehaviourFinding,
  DetectedIssue,
  PageMetrics,
} from "@vqa/contract";
import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright";
import {
  BEHAVIOUR_LIMITS,
  BoundedRecords,
  boundedField,
  sanitizedBehaviourUrl,
  type CaptureOmissions,
} from "./behaviour-limits.js";
import {
  cookieHeaderFinding,
  type StorageFinding,
} from "./behaviour-cookie.js";

interface ConsoleRecord {
  level: "error" | "warning";
  text: string;
  sourceUrl: string;
  line: number;
}

interface RequestRecord {
  method: string;
  url: string;
  status?: number;
  failureReason?: string;
}

function pageRect(page: PageMetrics): DetectedIssue["rect"] {
  return { x: 0, y: 0, width: page.viewportWidth, height: page.viewportHeight };
}

function consoleIssue(
  record: ConsoleRecord,
  pageUrl: string,
  page: PageMetrics,
): DetectedIssue {
  const sourceUrl = sanitizedBehaviourUrl(record.sourceUrl || pageUrl, pageUrl);
  const behaviour: BehaviourFinding = {
    kind: "console-message",
    level: record.level,
    text: record.text,
    sourceUrl,
    line: record.line,
  };
  return {
    type: "console-message",
    severity: record.level === "error" ? "high" : "medium",
    selector: `${sourceUrl}:${record.line}`,
    semanticName: `${record.level === "error" ? "Console error" : "Console warning"}: ${record.text}`,
    elementFingerprint: `console-message:${encodeURIComponent(record.text)}`,
    technicalLocator: `${sourceUrl}:${record.line}`,
    confidence: record.level === "error" ? "high" : "needs-confirmation",
    confidenceReasons: ["The browser emitted this console message during capture."],
    observedOutcome: `${record.level === "error" ? "Error" : "Warning"} in the browser console at ${sourceUrl}:${record.line}: ${record.text}`,
    acceptanceCriterion: "The page emits no unexpected error or warning at this capture state.",
    description: `Console ${record.level} at ${sourceUrl}:${record.line}: ${record.text}`,
    rect: pageRect(page),
    heuristicSuggestion: {
      kind: "heuristic",
      text: "Check the emitting code and confirm whether this console message is expected.",
    },
    behaviour,
  };
}

function requestIssue(
  record: RequestRecord,
  pageUrl: string,
  page: PageMetrics,
): DetectedIssue {
  const url = sanitizedBehaviourUrl(record.url, pageUrl);
  const behaviour: BehaviourFinding = {
    kind: "failed-request",
    method: record.method,
    url,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
  };
  const outcome = record.status === undefined
    ? `failed: ${record.failureReason ?? "unknown failure"}`
    : `answered ${record.status}`;
  return {
    type: "failed-request",
    severity: record.status !== undefined && record.status < 500 ? "medium" : "high",
    selector: url,
    semanticName: `Request to ${url}`,
    elementFingerprint: `failed-request:${encodeURIComponent(url)}`,
    technicalLocator: `${record.method} ${url}`,
    confidence: "high",
    confidenceReasons: ["The browser observed a failed request or an HTTP error response during capture."],
    observedOutcome: `${record.method} ${url} ${outcome}.`,
    acceptanceCriterion: "Every page request either succeeds or has an explicitly accepted error outcome.",
    description: `Request ${record.method} ${url} ${outcome}.`,
    rect: pageRect(page),
    heuristicSuggestion: {
      kind: "heuristic",
      text: "Check the endpoint or asset and confirm whether this response is expected.",
    },
    behaviour,
  };
}

function storageIdentity(finding: StorageFinding): string {
  if (finding.storage !== "cookie") return `${finding.storage}:${finding.key}`;
  return [
    finding.storage,
    finding.name,
    finding.attributes.domain,
    finding.attributes.path,
    finding.attributes.partitionKey ?? "",
  ].join(":");
}

function storageIssue(finding: StorageFinding, page: PageMetrics): DetectedIssue {
  const identity = finding.storage === "cookie" ? finding.name : finding.key;
  const location = finding.storage === "cookie"
    ? `${finding.attributes.domain}${finding.attributes.path}`
    : "page origin";
  const description = finding.storage === "cookie"
    ? `Cookie ${JSON.stringify(finding.name)} was written for ${location} (SameSite=${finding.attributes.sameSite}, Secure=${finding.attributes.secure}, HttpOnly=${finding.attributes.httpOnly}, Expires=${finding.attributes.expires}).`
    : `${finding.storage} key ${JSON.stringify(finding.key)} was written for the page origin.`;
  return {
    type: "storage-change",
    severity: "low",
    selector: `${finding.storage}:${identity}`,
    semanticName: `${finding.storage} ${identity}`,
    elementFingerprint: `storage-change:${encodeURIComponent(storageIdentity(finding))}`,
    technicalLocator: `${finding.storage}:${identity}`,
    confidence: "needs-confirmation",
    confidenceReasons: ["The page wrote this storage key or cookie during capture."],
    observedOutcome: description,
    acceptanceCriterion: "The page writes only storage entries that are expected for this capture state.",
    description,
    rect: pageRect(page),
    heuristicSuggestion: {
      kind: "heuristic",
      text: "Confirm that this storage entry is necessary and uses the intended scope and attributes.",
    },
    behaviour: finding,
  };
}

function isStorageFinding(value: unknown): value is StorageFinding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "storage-change") return false;
  if (record.storage === "localStorage" || record.storage === "sessionStorage") {
    return typeof record.key === "string";
  }
  if (record.storage !== "cookie" || typeof record.name !== "string") return false;
  const attributes = record.attributes;
  if (typeof attributes !== "object" || attributes === null) return false;
  const item = attributes as Record<string, unknown>;
  return typeof item.domain === "string" && typeof item.path === "string" &&
    typeof item.expires === "number" && typeof item.httpOnly === "boolean" &&
    typeof item.secure === "boolean" &&
    (item.sameSite === "Strict" || item.sameSite === "Lax" || item.sameSite === "None") &&
    (item.partitionKey === undefined || typeof item.partitionKey === "string");
}

function boundedStorageFinding(value: StorageFinding): StorageFinding {
  if (value.storage !== "cookie") return { ...value, key: boundedField(value.key) };
  return {
    ...value,
    name: boundedField(value.name),
    attributes: {
      ...value.attributes,
      domain: boundedField(value.attributes.domain),
      path: boundedField(value.attributes.path),
      ...(value.attributes.partitionKey === undefined
        ? {}
        : { partitionKey: boundedField(value.attributes.partitionKey) }),
    },
  };
}

/** Capture value-free browser behaviour using the page/context APIs. */
export async function capturePageBehaviour(page: Page, context: BrowserContext): Promise<{
  finish(pageUrl: string, metrics: PageMetrics): Promise<{
    issues: DetectedIssue[];
    summary: {
      truncated: boolean;
      limits: typeof BEHAVIOUR_LIMITS;
      omitted: CaptureOmissions;
    };
  }>;
}> {
  const omitted: CaptureOmissions = { consoleMessages: 0, failedRequests: 0, storageChanges: 0 };
  const consoleCapture = new BoundedRecords<ConsoleRecord>(omitted, "consoleMessages");
  const requestCapture = new BoundedRecords<RequestRecord>(omitted, "failedRequests");
  const storageCapture = new BoundedRecords<StorageFinding>(omitted, "storageChanges");
  const consoleRecords = consoleCapture.records;
  const requestRecords = requestCapture.records;
  const storageRecords = storageCapture.records;
  const pendingResponses = new Set<Promise<void>>();
  const bindingName = `__vqaRecordStorage_${randomBytes(8).toString("hex")}`;

  await page.exposeBinding(bindingName, (_source, value: unknown) => {
    if (!isStorageFinding(value)) return;
    const finding = boundedStorageFinding(value);
    storageCapture.add(storageIdentity(finding), finding);
  });
  await page.addInitScript((recordStorageName) => {
    const record = (finding: unknown): void => {
      const binding = (globalThis as unknown as Record<string, unknown>)[recordStorageName];
      if (typeof binding === "function") void (binding as (value: unknown) => Promise<unknown>)(finding);
    };
    const storagePrototype = globalThis.Storage?.prototype;
    if (storagePrototype) {
      let nativeLocalStorage: Storage | undefined;
      let nativeSessionStorage: Storage | undefined;
      try {
        nativeLocalStorage = globalThis.localStorage;
        nativeSessionStorage = globalThis.sessionStorage;
      } catch {
        // Storage access can be forbidden for an opaque frame.
      }
      const originalSetItem = storagePrototype.setItem;
      const originalRemoveItem = storagePrototype.removeItem;
      const originalClear = storagePrototype.clear;
      const storageKind = (storage: Storage): "localStorage" | "sessionStorage" | undefined => {
        if (storage === nativeLocalStorage) return "localStorage";
        if (storage === nativeSessionStorage) return "sessionStorage";
        return undefined;
      };
      storagePrototype.setItem = function(key: string, value: string): void {
        originalSetItem.call(this, key, value);
        const storage = storageKind(this);
        if (storage) record({ kind: "storage-change", storage, key: String(key) });
      };
      storagePrototype.removeItem = function(key: string): void {
        const storage = storageKind(this);
        if (storage) record({ kind: "storage-change", storage, key: String(key) });
        originalRemoveItem.call(this, key);
      };
      storagePrototype.clear = function(): void {
        const storage = storageKind(this);
        if (storage) {
          for (let index = 0; index < this.length; index += 1) {
            const key = this.key(index);
            if (key !== null) record({ kind: "storage-change", storage, key });
          }
        }
        originalClear.call(this);
      };

      for (const storageName of ["localStorage", "sessionStorage"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, storageName);
        if (!descriptor?.get || !descriptor.configurable) continue;
        const proxies = new WeakMap<Storage, Storage>();
        Object.defineProperty(globalThis, storageName, {
          configurable: descriptor.configurable,
          enumerable: Boolean(descriptor.enumerable),
          get() {
            const target = descriptor.get!.call(this) as Storage;
            const cached = proxies.get(target);
            if (cached) return cached;
            const proxy = new Proxy(target, {
              get(storage, property) {
                const result = Reflect.get(storage, property, storage);
                return typeof result === "function" ? result.bind(storage) : result;
              },
              set(storage, property, value) {
                const success = Reflect.set(storage, property, value, storage);
                if (success && typeof property === "string") {
                  record({ kind: "storage-change", storage: storageName, key: property });
                }
                return success;
              },
              deleteProperty(storage, property) {
                const existed = Reflect.has(storage, property);
                const success = Reflect.deleteProperty(storage, property);
                if (success && existed && typeof property === "string") {
                  record({ kind: "storage-change", storage: storageName, key: property });
                }
                return success;
              },
            });
            proxies.set(target, proxy);
            return proxy;
          },
        });
      }
    }

    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.get && cookie.set) {
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: Boolean(cookie.configurable),
        enumerable: Boolean(cookie.enumerable),
        get: cookie.get,
        set(value: string) {
          const visibleCookieCount = (name: string): number => String(cookie.get!.call(this))
            .split(";")
            .map((part) => part.trim().split("=", 1)[0]?.trim())
            .filter((candidate) => candidate === name).length;
          const rawValue = String(value);
          const name = rawValue.split(";", 1)[0]?.split("=", 1)[0]?.trim() ?? "";
          const countBefore = name ? visibleCookieCount(name) : 0;
          cookie.set!.call(this, value);
          const parts = rawValue.split(";").map((part) => part.trim());
          parts.shift();
          if (!name) return;
          const attributes = new Map<string, string>();
          for (const part of parts) {
            const separator = part.indexOf("=");
            const key = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
            const attributeValue = separator < 0 ? "" : part.slice(separator + 1).trim();
            attributes.set(key, attributeValue);
          }
          const pathname = globalThis.location.pathname;
          const finalSlash = pathname.lastIndexOf("/");
          const defaultPath = finalSlash <= 0 ? "/" : pathname.slice(0, finalSlash);
          const maxAge = Number(attributes.get("max-age"));
          const expiresText = attributes.get("expires");
          const isRemoval = attributes.has("max-age") && Number.isFinite(maxAge) && maxAge <= 0 ||
            Boolean(expiresText && Number.isFinite(Date.parse(expiresText)) && Date.parse(expiresText) <= Date.now());
          const countAfter = visibleCookieCount(name);
          if (isRemoval ? countAfter >= countBefore : countAfter === 0) return;
          const expires = attributes.has("max-age") && Number.isFinite(maxAge)
            ? maxAge <= 0 ? 0 : Date.now() / 1_000 + maxAge
            : expiresText && Number.isFinite(Date.parse(expiresText))
              ? Date.parse(expiresText) / 1_000
              : -1;
          const rawSameSite = attributes.get("samesite")?.toLowerCase();
          const sameSite = rawSameSite === "strict" ? "Strict"
            : rawSameSite === "none" ? "None" : "Lax";
          record({
            kind: "storage-change",
            storage: "cookie",
            name,
            attributes: {
              domain: attributes.get("domain")?.toLowerCase() || globalThis.location.hostname,
              path: attributes.get("path") || defaultPath,
              expires,
              httpOnly: false,
              secure: attributes.has("secure"),
              sameSite,
            },
          });
        },
      });
    }
  }, bindingName);

  page.on("console", (message: ConsoleMessage) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const location = message.location();
    const text = boundedField(message.text());
    const sourceUrl = boundedField(location.url);
    consoleCapture.add(`${type}:${text}:${sourceUrl}:${location.lineNumber}`, {
      level: type,
      text,
      sourceUrl,
      line: location.lineNumber,
    });
  });
  page.on("response", (response: Response) => {
    const request = response.request();
    if (response.status() >= 400) {
      const record = {
        method: boundedField(request.method()),
        url: boundedField(request.url()),
        status: response.status(),
      };
      requestCapture.add(`${record.method}:${record.url}`, record);
    }
    const pending = response.headersArray().then((headers) => {
      for (const header of headers) {
        if (header.name.toLowerCase() !== "set-cookie") continue;
        const finding = cookieHeaderFinding(header.value, response.url());
        if (finding) storageCapture.add(storageIdentity(finding), finding);
      }
    }).finally(() => pendingResponses.delete(pending));
    pendingResponses.add(pending);
  });
  page.on("requestfailed", (request: Request) => {
    // The browser cancelling a request (navigation, unload beacons, the
    // scan's own policy block) says nothing about the page.
    const errorText = request.failure()?.errorText ?? "";
    if (/^net::ERR_(?:ABORTED|BLOCKED_BY_CLIENT)/u.test(errorText)) return;
    const record = {
      method: boundedField(request.method()),
      url: boundedField(request.url()),
      failureReason: boundedField(request.failure()?.errorText ?? "unknown failure"),
    };
    requestCapture.add(`${record.method}:${record.url}`, record);
  });

  return {
    async finish(pageUrl, metrics) {
      await Promise.all(pendingResponses);
      const cookies = await context.cookies();
      const observedStorage = new Set(storageRecords.map(storageIdentity));
      for (const cookie of cookies) {
        const finding = boundedStorageFinding({
          kind: "storage-change",
          storage: "cookie",
          name: cookie.name,
          attributes: {
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
            ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
          },
        });
        if (!observedStorage.has(storageIdentity(finding))) {
          storageCapture.add(storageIdentity(finding), finding);
        }
      }
      for (const frame of page.frames()) {
        const keys = await frame.evaluate(() => ({
          localStorage: Object.keys(localStorage),
          sessionStorage: Object.keys(sessionStorage),
        })).catch(() => ({ localStorage: [] as string[], sessionStorage: [] as string[] }));
        for (const storage of ["localStorage", "sessionStorage"] as const) {
          for (const key of keys[storage]) {
            const finding: StorageFinding = {
              kind: "storage-change", storage, key: boundedField(key),
            };
            if (!observedStorage.has(storageIdentity(finding))) {
              storageCapture.add(storageIdentity(finding), finding);
            }
          }
        }
      }
      const issues = [
        ...consoleRecords
          .sort((left, right) => left.text.localeCompare(right.text) ||
            left.sourceUrl.localeCompare(right.sourceUrl) || left.line - right.line)
          .map((record) => consoleIssue(record, pageUrl, metrics)),
        ...requestRecords
          .sort((left, right) => left.url.localeCompare(right.url) ||
            left.method.localeCompare(right.method) || (left.status ?? 0) - (right.status ?? 0))
          .map((record) => requestIssue(record, pageUrl, metrics)),
        ...storageRecords
          .sort((left, right) => storageIdentity(left).localeCompare(storageIdentity(right)))
          .map((finding) => storageIssue(finding, metrics)),
      ];
      return {
        issues,
        summary: {
          truncated: Object.values(omitted).some((count) => count > 0),
          limits: BEHAVIOUR_LIMITS,
          omitted: { ...omitted },
        },
      };
    },
  };
}
