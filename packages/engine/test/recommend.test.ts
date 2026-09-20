import { describe, expect, it } from "vitest";
import type { DetectedIssue } from "@vqa/contract";
import {
  CliTimeoutError,
  MockModelAdapter,
  StubModelAdapter,
  type ModelAdapter,
} from "@vqa/model-adapter";
import { recommendFix } from "../src/index.js";

const issue: DetectedIssue = {
  type: "overlap",
  severity: "high",
  selector: "div#a",
  otherSelector: "div#b",
  description: "boxes collide",
  rect: { x: 0, y: 0, width: 100, height: 50 },
  heuristicSuggestion: { kind: "heuristic", text: "give them room" },
};

const context = { url: "http://example.test/", viewport: "390x844@1" };

describe("recommendFix", () => {
  it("is honestly unavailable when no adapter is wired (fail closed)", async () => {
    const result = await recommendFix(new StubModelAdapter(), issue, context);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable")
      expect(result.reason).toContain("no model adapter wired");
  });

  it("labels wired-adapter output as AI with its model name", async () => {
    const mock = new MockModelAdapter([
      { text: "Use flex with gap.", model: "mock-model" },
    ]);
    const result = await recommendFix(mock, issue, context);
    expect(result).toEqual({
      status: "ok",
      kind: "ai",
      text: "Use flex with gap.",
      model: "mock-model",
    });
    expect(mock.requests[0]!.prompt).toContain("div#a");
  });

  it("degrades to unavailable when the adapter errors mid-call", async () => {
    const failing = new MockModelAdapter([]);
    const result = await recommendFix(failing, issue, context);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable")
      expect(result.reason).toContain("model adapter failed");
  });

  it("surfaces a typed production-adapter failure as unavailable without fabricated text", async () => {
    const timedOut: ModelAdapter = {
      describe: () => ({
        impl: "cli-subprocess:codex",
        wired: true,
        contractVersion: "1",
      }),
      complete: () => Promise.reject(new CliTimeoutError(25)),
    };
    await expect(recommendFix(timedOut, issue, context)).resolves.toEqual({
      status: "unavailable",
      reason:
        "model adapter failed: CLI model adapter timed out after 25 ms; process-tree termination was requested. Increase the model CLI timeout only after checking the local CLI session.",
    });
  });
});
