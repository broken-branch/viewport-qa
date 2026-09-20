import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DecisionsFile,
  PortableReviewBundle,
  Report,
  ReviewState,
  ReviewManifest,
} from "@vqa/contract";
import { PRODUCT_VERSION } from "@vqa/contract";
import {
  createPortableBundle,
  EXPORT_POLICY_ID,
  reviewStateSha256,
  validateReviewManifest,
} from "../src/export-bundle.js";
import {
  assertBuilt,
  assertPortClosed,
  BIN,
  captureBrowserLaunch,
  waitForExit,
} from "./helpers.js";
import { extractChromiumPdfText } from "./pdf-inspection.js";

/**
 * Gate-integrity canary for the `vqa serve` entry point: start the real
 * binary, fetch the report GUI, POST decisions, and assert decisions.json.
 */

const minimalReport: Report = {
  formatVersion: "2",
  tool: "viewport-qa",
  toolVersion: PRODUCT_VERSION,
  schemaVersions: { report: "2", manifest: 1, reviewState: 1 },
  url: "http://example.test/",
  createdAt: new Date().toISOString(),
  adapter: { impl: "stub", wired: false },
  viewports: [
    {
      viewport: {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        label: "390x844@1",
      },
      page: {
        scrollWidth: 390,
        scrollHeight: 1200,
        viewportWidth: 390,
        viewportHeight: 844,
      },
      screenshot: "screenshots/390x844@1/full.png",
      issueCount: 1,
      rawIssueCount: 1,
    },
  ],
  issues: [
    {
      id: "overlap-390x844@1-01",
      instanceCount: 1,
      type: "overlap",
      severity: "high",
      selector: "div#a",
      otherSelector: "div#b",
      description: "boxes collide",
      rect: { x: 0, y: 0, width: 100, height: 50 },
      viewport: "390x844@1",
      screenshots: { viewport: "screenshots/390x844@1/full.png" },
      heuristicSuggestion: { kind: "heuristic", text: "give them room" },
      aiRecommendation: {
        status: "unavailable",
        reason: "no model adapter wired (impl: stub)",
      },
    },
  ],
};

let reportDir: string;
let child: ChildProcess | undefined;
let baseUrl: string;
let browserLaunch: ReturnType<typeof captureBrowserLaunch> | undefined;
const nativeFetch = globalThis.fetch;

beforeAll(async () => {
  assertBuilt();
  reportDir = mkdtempSync(join(tmpdir(), "vqa-serve-"));
  mkdirSync(join(reportDir, "screenshots/390x844@1"), { recursive: true });
  writeFileSync(join(reportDir, "issues.json"), JSON.stringify(minimalReport));
  const fixtureDir = new URL(
    "../../engine/test/fixtures/review-journey/",
    import.meta.url,
  );
  cpSync(fixtureDir, reportDir, { recursive: true });
  writeFileSync(join(reportDir, "screenshots/390x844@1/full.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  browserLaunch = captureBrowserLaunch();
  child = spawn(process.platform === "win32" ? process.execPath : BIN, process.platform === "win32" ? [BIN, "serve", reportDir, "--port", "0"] : ["serve", reportDir, "--port", "0"], {
    env: browserLaunch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = await browserLaunch.waitForUrl(child);
  const launch = new URL(baseUrl);
  const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
  globalThis.fetch = (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    headers.set("authorization", `VQA ${capability}`);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!["GET", "HEAD"].includes(method)) headers.set("origin", launch.origin);
    return nativeFetch(input, { ...init, headers });
  };
}, 60_000);

afterAll(async () => {
  try {
    expect(child).toBeDefined();
    const exitPromise = waitForExit(child!, 5_000);
    expect((await fetch(new URL("/api/stop", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(202);
    await expect(exitPromise).resolves.toEqual({ code: 0, signal: null });
    await assertPortClosed(baseUrl);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    globalThis.fetch = nativeFetch;
    browserLaunch?.cleanup();
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
});

describe("vqa serve (real binary)", () => {
  it("serves a generic bootstrap at / and the private report GUI at /app", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const bootstrap = await response.text();
    expect(bootstrap).toContain("Opening Viewport QA");
    expect(bootstrap).not.toContain("review-manifest");
    const app = await fetch(new URL("app", baseUrl));
    expect(await app.text()).toContain("Review screenshots");
  });

  it("keeps internal report JSON private while serving manifest-approved screenshots", async () => {
    const issues = await fetch(new URL("issues.json", baseUrl));
    expect(issues.status).toBe(404);
    const shot = await fetch(
      new URL("page-home--state-default--390x844.png", baseUrl),
    );
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");
  });

  it("persists an approve decision to decisions.json", async () => {
    const response = await fetch(new URL("api/decisions", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issueId: "overlap-390x844@1-01",
        action: "approve",
      }),
    });
    expect(response.status).toBe(200);
    const onDisk = JSON.parse(
      readFileSync(join(reportDir, "decisions.json"), "utf8"),
    ) as DecisionsFile;
    expect(onDisk["overlap-390x844@1-01"]!.action).toBe("approve");
    expect(onDisk["overlap-390x844@1-01"]!.updatedAt).toBeTruthy();
  });

  it("persists a message decision with the user's instruction", async () => {
    const response = await fetch(new URL("api/decisions", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issueId: "overlap-390x844@1-01",
        action: "message",
        message: "Use grid instead of absolute positioning here.",
      }),
    });
    expect(response.status).toBe(200);
    const onDisk = JSON.parse(
      readFileSync(join(reportDir, "decisions.json"), "utf8"),
    ) as DecisionsFile;
    expect(onDisk["overlap-390x844@1-01"]!.action).toBe("message");
    expect(onDisk["overlap-390x844@1-01"]!.message).toBe(
      "Use grid instead of absolute positioning here.",
    );
    const viaApi = await fetch(new URL("api/decisions", baseUrl));
    expect(
      ((await viaApi.json()) as DecisionsFile)["overlap-390x844@1-01"]!.action,
    ).toBe("message");
  });

  it("rejects malformed decisions", async () => {
    const response = await fetch(new URL("api/decisions", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueId: "x", action: "nonsense" }),
    });
    expect(response.status).toBe(400);
  });

  it("blocks path traversal outside the report dir", async () => {
    const response = await fetch(`${new URL(baseUrl).origin}/..%2f..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(response.status);
  });

  it("persists capture classifications and preserves timestamps on a no-op save", async () => {
    const endpoint = new URL("api/review", baseUrl);
    const body = {
      coordinateId: "page-home--state-default--390x844",
      classification: "good",
    };
    const first = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstState = (await first.json()) as ReviewState;
    const firstTimestamp =
      firstState.captures[body.coordinateId]!.updated_at;
    const second = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const secondState = (await second.json()) as ReviewState;
    expect(secondState.captures[body.coordinateId]!.classification).toBe(
      "good",
    );
    expect(secondState.captures[body.coordinateId]!.updated_at).toBe(
      firstTimestamp,
    );
  });

  it("persists valid issue highlight adjustments and fails closed on invalid geometry", async () => {
    const endpoint = new URL("api/review", baseUrl);
    const coordinateId = "page-checkout--state-alternate--390x844";
    const issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
    const postHighlight = (highlightIssueId: string, highlightRect: unknown) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coordinateId, highlightIssueId, highlightRect }),
      });
    const adjusted = { x: 24, y: 528, width: 340, height: 80 };
    const saved = await postHighlight(issueId, adjusted);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ReviewState).captures[coordinateId]!.issue_highlights).toEqual({
      [issueId]: adjusted,
    });
    const removed = await postHighlight(issueId, null);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as ReviewState).captures[coordinateId]!.issue_highlights).toEqual({
      [issueId]: null,
    });
    expect((await postHighlight("UNKNOWN-ISSUE", adjusted)).status).toBe(400);
    expect(
      (await postHighlight(issueId, { x: 380, y: 530, width: 40, height: 40 })).status,
    ).toBe(400);
    expect(
      ((await (await fetch(endpoint)).json()) as ReviewState).captures[coordinateId]!
        .issue_highlights,
    ).toEqual({ [issueId]: null });
    const restored = await postHighlight(issueId, { x: 20, y: 532, width: 350, height: 70 });
    expect(restored.status).toBe(200);
  });

  it("refuses review when the displayed screenshot no longer matches the manifest", async () => {
    const coordinateId = "page-checkout--state-default--390x844";
    const assetPath = join(reportDir, `${coordinateId}.png`);
    chmodSync(assetPath, 0o600);
    const pristine = readFileSync(assetPath);
    writeFileSync(assetPath, Buffer.concat([pristine, Buffer.from([0])]));
    const response = await fetch(new URL("api/review", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coordinateId, classification: "good" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("hash or length mismatch");
    expect(JSON.parse(readFileSync(join(reportDir, "review-state.json"), "utf8")).captures[coordinateId].classification).toBe("unreviewed");
    writeFileSync(assetPath, pristine);
  });

  it("rejects cross-bound manifest asset references", () => {
    const manifest = JSON.parse(readFileSync(join(reportDir, "review-manifest.json"), "utf8")) as ReviewManifest;
    const invalid = structuredClone(manifest);
    invalid.captures[0]!.full_asset_id = invalid.captures[1]!.full_asset_id;
    expect(() => validateReviewManifest(invalid)).toThrow(/misbound full screenshot/u);
  });

  it("exports only the explicitly selected issue from a multi-issue screenshot", async () => {
    const manifest = JSON.parse(readFileSync(join(reportDir, "review-manifest.json"), "utf8")) as ReviewManifest;
    const candidate = structuredClone(manifest);
    const coordinateId = "page-home--state-alternate--390x844";
    const originalIssue = candidate.issues.find((issue) => issue.id === "VQ-ISSUE-HOME-LOW-CONTRAST-CTA")!;
    const secondIssue = structuredClone(originalIssue);
    secondIssue.id = "SECOND-ISSUE";
    secondIssue.title = "Second issue";
    secondIssue.capture_coordinate_ids = [coordinateId];
    delete secondIssue.crop_asset_id;
    candidate.issues.push(secondIssue);
    candidate.captures.find((capture) => capture.coordinate_id === coordinateId)!.issue_ids.push("SECOND-ISSUE");
    validateReviewManifest(candidate);
    const manifestSha256 = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
    const now = new Date().toISOString();
    const state: ReviewState = {
      artifact_type: "vq-review-state",
      schema_version: 1,
      manifest_id: candidate.manifest_id,
      manifest_sha256: manifestSha256,
      captures: Object.fromEntries(candidate.captures.map((capture) => [capture.coordinate_id, {
        coordinate_id: capture.coordinate_id,
        classification: capture.coordinate_id === coordinateId ? "bad" : "unreviewed",
        ...(capture.coordinate_id === coordinateId ? { requested_change: {
          request_id: `vqreq-v1-${coordinateId}`,
          requested_change: "Fix only the selected issue",
          authorship: "visual-reviewer",
          origin_coordinate_id: coordinateId,
          affected_coordinate_ids: [coordinateId],
          selected_issue_ids: [originalIssue.id],
          created_at: now,
          updated_at: now,
        } } : {}),
      }])),
    };
    const digest = reviewStateSha256(candidate, manifestSha256, state);
    const result = await createPortableBundle({
      reportRoot: reportDir,
      bundleParent: join(reportDir, "selection-handoffs"),
      manifest: candidate,
      manifestSha256,
      reviewState: state,
      identity: {
        export_id: `vqexp-v1-${digest}`,
        exported_at: now,
        policy_id: EXPORT_POLICY_ID,
        schema_version: 1,
        manifest_sha256: manifestSha256,
        review_state_sha256: digest,
      },
    });
    expect(result.bundle.requests[0]!.affected_coordinates[0]!.issues.map((issue) => issue.id)).toEqual([
      originalIssue.id,
    ]);
  });

  it("rejects unknown and duplicate affected coordinates without changing review data", async () => {
    const before = await (
      await fetch(new URL("api/review", baseUrl))
    ).text();
    const unknown = await fetch(new URL("api/review", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinateId: "outside-manifest",
        classification: "bad",
      }),
    });
    expect(unknown.status).toBe(400);
    const duplicate = await fetch(new URL("api/review", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinateId: "page-home--state-alternate--390x844",
        classification: "bad",
        requestedChange: "Increase contrast.",
        affectedCoordinateIds: [
          "page-home--state-alternate--390x844",
          "page-home--state-alternate--390x844",
        ],
      }),
    });
    expect(duplicate.status).toBe(400);
    expect(await (await fetch(new URL("api/review", baseUrl))).text()).toBe(
      before,
    );
  });

  it("accepts zero, one, or multiple applicable detected issues only with reviewer-authored outcomes", async () => {
    const endpoint = new URL("api/review", baseUrl);
    const coordinateId = "page-home--state-alternate--390x844";
    const checkoutId = "page-checkout--state-alternate--390x844";
    const postSelection = (affectedCoordinateIds: string[], selectedIssueIds: string[], requestedChange = "Increase contrast and leave enough room for the total.") =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coordinateId,
          classification: "bad",
          requestedChange,
          affectedCoordinateIds,
          selectedIssueIds,
        }),
      });

    const zero = await postSelection([coordinateId], []);
    expect(zero.status).toBe(200);
    expect(((await zero.json()) as ReviewState).captures[coordinateId]!.requested_change!.selected_issue_ids).toEqual([]);

    const neither = await postSelection([coordinateId], [], "");
    expect(neither.status).toBe(400);
    expect(await neither.text()).toContain("reviewer-approved outcome");

    const issueOnly = await postSelection([coordinateId], ["VQ-ISSUE-HOME-LOW-CONTRAST-CTA"], "");
    expect(issueOnly.status).toBe(400);
    expect(await issueOnly.text()).toContain("reviewer-approved outcome");

    const one = await postSelection([coordinateId], ["VQ-ISSUE-HOME-LOW-CONTRAST-CTA"]);
    expect(one.status).toBe(200);
    expect(((await one.json()) as ReviewState).captures[coordinateId]!.requested_change!.selected_issue_ids).toEqual([
      "VQ-ISSUE-HOME-LOW-CONTRAST-CTA",
    ]);

    const selected = [
      "VQ-ISSUE-HOME-LOW-CONTRAST-CTA",
      "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED",
    ];
    const multiple = await postSelection([coordinateId, checkoutId], selected);
    expect(multiple.status).toBe(200);
    const multipleState = (await multiple.json()) as ReviewState;
    expect(multipleState.captures[coordinateId]!.requested_change!.selected_issue_ids).toEqual([
      "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED",
      "VQ-ISSUE-HOME-LOW-CONTRAST-CTA",
    ]);

    const inapplicable = await postSelection([coordinateId], [
      "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED",
    ]);
    expect(inapplicable.status).toBe(400);
    expect(await inapplicable.text()).toContain("not part of an affected screenshot");
    const unknown = await postSelection([coordinateId], ["UNKNOWN-ISSUE"]);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("not part of an affected screenshot");
    expect((await (await fetch(endpoint)).json()).captures[coordinateId].requested_change.selected_issue_ids).toEqual(
      multipleState.captures[coordinateId]!.requested_change!.selected_issue_ids,
    );
  });

  it("fails closed when persisted review state contains an empty request with no attached issue", async () => {
    const statePath = join(reportDir, "review-state.json");
    const original = readFileSync(statePath);
    try {
      const malformed = JSON.parse(original.toString()) as ReviewState;
      const coordinateId = "page-home--state-alternate--390x844";
      malformed.captures[coordinateId] = {
        coordinate_id: coordinateId,
        classification: "bad",
        requested_change: {
          request_id: `vqreq-v1-${coordinateId}`,
          requested_change: "",
          authorship: "visual-reviewer",
          origin_coordinate_id: coordinateId,
          affected_coordinate_ids: [coordinateId],
          selected_issue_ids: [],
          created_at: "2026-08-23T12:00:00.000Z",
          updated_at: "2026-08-23T12:00:00.000Z",
        },
      };
      writeFileSync(statePath, `${JSON.stringify(malformed)}\n`);
      const response = await fetch(new URL("api/review", baseUrl));
      expect(response.status).toBe(500);
    } finally {
      writeFileSync(statePath, original);
    }
    expect((await fetch(new URL("api/review", baseUrl))).status).toBe(200);
  });

  it("generates and safely saves independent Human and AI handoff formats", async () => {
    const exportEndpoint = new URL("api/export", baseUrl);
    const issueOnly = await fetch(new URL("api/review", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinateId: "page-home--state-alternate--390x844",
        classification: "bad",
        requestedChange: "Increase the primary action contrast.",
        affectedCoordinateIds: ["page-home--state-alternate--390x844"],
        selectedIssueIds: ["VQ-ISSUE-HOME-LOW-CONTRAST-CTA"],
      }),
    });
    expect(issueOnly.status).toBe(200);
    const generate = async (audience: "human" | "ai") => {
      const response = await fetch(exportEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "generate", audience }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        audience: string;
        content: string;
        export_id?: string;
      };
    };
    const human = await generate("human");
    expect(human.audience).toBe("human");
    expect(human.export_id).toBeUndefined();
    expect(human.content).toContain("VISUAL QA HANDOFF");
    expect(human.content).toContain("REVIEWER-APPROVED WORK");
    expect(human.content).toContain("Requested outcome\nIncrease the primary action contrast.");
    expect(human.content).toContain("MACHINE SUGGESTIONS — NOT APPROVED WORK");
    expect(human.content).not.toMatch(/[#*_`]/u);
    expect(human.content).not.toMatch(/VQ-|audit|hash|policy|reason code|selector|schema|format|version/iu);

    const ai = await generate("ai");
    expect(ai.audience).toBe("ai");
    expect(JSON.parse(ai.content).export_id).toBe(ai.export_id);
    expect(JSON.parse(ai.content).requests[0].requested_change).toBe("Increase the primary action contrast.");
    const attached = JSON.parse(ai.content).requests
      .flatMap((request: { affected_coordinates: Array<{ issues: Array<{ id: string }> }> }) =>
        request.affected_coordinates.flatMap((coordinate) => coordinate.issues.map((issue) => issue.id)),
      );
    expect(new Set(attached)).toEqual(
      new Set(["VQ-ISSUE-HOME-LOW-CONTRAST-CTA"]),
    );

    const humanPath = join(reportDir, "human-handoff.txt");
    const pdfPath = join(reportDir, "human-handoff.pdf");
    const aiPath = join(reportDir, "ai-handoff.json");
    for (const [audience, fileFormat, destinationPath, expectedError] of [
      ["human", "txt", aiPath, ".txt"],
      ["human", "pdf", humanPath, ".pdf"],
      ["ai", "json", humanPath, ".json"],
    ] as const) {
      const response = await fetch(exportEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "save", audience, fileFormat, destinationPath }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(expectedError);
    }
    const save = async (
      audience: "human" | "ai",
      fileFormat: "txt" | "pdf" | "json",
      destinationPath: string,
    ) => {
      const response = await fetch(exportEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "save", audience, fileFormat, destinationPath }),
      });
      const payload = await response.text();
      expect(response.status, payload).toBe(200);
      expect((JSON.parse(payload) as { saved_path: string }).saved_path).toBe(destinationPath);
    };
    await save("human", "txt", humanPath);
    await save("human", "pdf", pdfPath);
    const firstPdf = readFileSync(pdfPath);
    await save("human", "pdf", pdfPath);
    expect(readFileSync(pdfPath)).toEqual(firstPdf);
    await save("ai", "json", aiPath);
    expect(readFileSync(humanPath, "utf8")).toBe(human.content);
    expect(readFileSync(aiPath, "utf8")).toBe(ai.content);
    const pdfBytes = readFileSync(pdfPath);
    const pdfStructure = pdfBytes.toString("latin1");
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfStructure).toMatch(/\/Type\s*\/Page\b/u);
    expect(pdfStructure).toMatch(/\/Subtype\s*\/Image\b/u);
    expect(pdfStructure).toMatch(/\/Width\s+390\b[\s\S]{0,160}\/Height\s+844\b/u);
    expect(pdfStructure).toContain("%%EOF");
    const searchablePdfText = extractChromiumPdfText(pdfBytes).replace(/[^\p{L}\p{N}]+/gu, " ");
    expect(searchablePdfText).toContain("VISUAL QA HANDOFF");
    expect(searchablePdfText).not.toMatch(/\bVQ\b|audit|hash|policy|reason code|selector|schema|format|version/iu);
  });

  it("reuses the reserved export identity after an asset failure and emits a byte-stable portable bundle", async () => {
    const coordinateId = "page-checkout--state-alternate--390x844";
    const reviewResponse = await fetch(new URL("api/review", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinateId,
        classification: "bad",
        requestedChange: "Give the total enough width to show the full amount.",
        affectedCoordinateIds: [
          coordinateId,
          "page-home--state-alternate--390x844",
        ],
        selectedIssueIds: [
          "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED",
          "VQ-ISSUE-HOME-LOW-CONTRAST-CTA",
        ],
      }),
    });
    expect(reviewResponse.status).toBe(200);

    const assetPath = join(
      reportDir,
      "page-checkout--state-alternate--390x844.png",
    );
    chmodSync(assetPath, 0o600);
    const pristine = readFileSync(assetPath);
    writeFileSync(assetPath, Buffer.concat([pristine, Buffer.from([0])]));
    const failed = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain("hash or length mismatch");
    writeFileSync(assetPath, pristine);

    const first = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);
    const firstReceipt = (await first.json()) as {
      export_id: string;
      exported_at: string;
      json_path: string;
    };
    const firstJson = readFileSync(firstReceipt.json_path);
    const bundle = JSON.parse(firstJson.toString("utf8")) as PortableReviewBundle;
    expect(bundle.export_policy_id).toBe("vq-export-identity-v1");
    expect(bundle.requests[0]!.affected_coordinates).toHaveLength(2);
    expect(bundle.assets).toHaveLength(3);
    for (const asset of bundle.assets) {
      expect(asset.path).toMatch(/^assets\/[0-9a-f]{64}\.(png|jpg)$/);
      expect(readFileSync(join(firstReceipt.json_path, "..", asset.path)))
        .toHaveLength(asset.byte_length);
    }

    const second = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const secondReceipt = (await second.json()) as typeof firstReceipt;
    expect(second.status).toBe(200);
    expect(secondReceipt.export_id).toBe(firstReceipt.export_id);
    expect(secondReceipt.exported_at).toBe(firstReceipt.exported_at);
    expect(readFileSync(secondReceipt.json_path)).toEqual(firstJson);
  });

  it("persists the default handoff path and distinguishes generate from explicit save", async () => {
    const settingsEndpoint = new URL("api/settings", baseUrl);
    const initial = (await (await fetch(settingsEndpoint)).json()) as {
      default_handoff_path: string;
    };
    expect(initial.default_handoff_path).toBe(
      join(reportDir, "change-request-export.json"),
    );
    const destination = join(reportDir, "manual-handoff.json");
    const textDestination = join(reportDir, "manual-handoff.txt");
    const textSettings = await fetch(settingsEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultHandoffPath: textDestination }),
    });
    expect(textSettings.status).toBe(200);
    expect(
      ((await textSettings.json()) as { default_handoff_path: string }).default_handoff_path,
    ).toBe(textDestination);
    const savedSettings = await fetch(settingsEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultHandoffPath: destination }),
    });
    expect(savedSettings.status).toBe(200);
    expect(
      ((await (await fetch(settingsEndpoint)).json()) as {
        default_handoff_path: string;
      }).default_handoff_path,
    ).toBe(destination);

    const generate = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "generate" }),
    });
    expect(generate.status).toBe(200);
    const generated = (await generate.json()) as {
      mode: string;
      export_id: string;
      content: string;
    };
    expect(generated.mode).toBe("generate");
    expect(JSON.parse(generated.content).export_id).toBe(generated.export_id);
    expect(existsSync(destination)).toBe(false);

    const invalidSave = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "save", destinationPath: "relative.json" }),
    });
    expect(invalidSave.status).toBe(400);
    expect(await invalidSave.text()).toContain("absolute path");
    expect(existsSync(destination)).toBe(false);

    const save = await fetch(new URL("api/export", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "save", destinationPath: destination }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { mode: string; saved_path: string };
    expect(saved).toMatchObject({ mode: "save", saved_path: destination });
    expect(readFileSync(destination, "utf8")).toBe(generated.content);
  });

  it("preserves a malformed identity store and rejects a symlinked handoff directory", async () => {
    const identitiesPath = join(reportDir, "review-export-identities.json");
    const identities = readFileSync(identitiesPath);
    writeFileSync(identitiesPath, '{"reserved-identity":');
    const malformed = await fetch(new URL("api/export", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(malformed.status).toBe(400);
    expect(readFileSync(identitiesPath, "utf8")).toBe('{"reserved-identity":');
    writeFileSync(identitiesPath, identities);

    const handoffs = join(reportDir, "handoffs");
    const preserved = join(reportDir, "handoffs-preserved");
    const outside = mkdtempSync(join(tmpdir(), "vqa-handoffs-outside-"));
    renameSync(handoffs, preserved);
    symlinkSync(outside, handoffs, "dir");
    try {
      const escaped = await fetch(new URL("api/export", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(escaped.status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(handoffs, { force: true });
      renameSync(preserved, handoffs);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
