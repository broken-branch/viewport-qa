import type { AiRecommendation, DetectedIssue } from "@vqa/contract";
import type { ModelAdapter } from "@vqa/model-adapter";

/**
 * Fail-closed AI recommendation. When the adapter is unwired or errors, the
 * result is honestly "unavailable" -- never fabricated text.
 */
export async function recommendFix(
  adapter: ModelAdapter,
  issue: DetectedIssue,
  context: { url: string; viewport: string },
): Promise<AiRecommendation> {
  const description = adapter.describe();
  if (!description.wired) {
    return {
      status: "unavailable",
      reason: `no model adapter wired (impl: ${description.impl})`,
    };
  }
  try {
    const result = await adapter.complete({
      role: "fix-recommender",
      system:
        "You are a senior front-end engineer reviewing automated visual QA findings. " +
        "Recommend a concrete, minimal CSS/HTML fix for the reported issue. Be specific and brief.",
      prompt: JSON.stringify(
        {
          url: context.url,
          viewport: context.viewport,
          type: issue.type,
          severity: issue.severity,
          selector: issue.selector,
          otherSelector: issue.otherSelector,
          description: issue.description,
          rect: issue.rect,
        },
        null,
        2,
      ),
    });
    return { status: "ok", kind: "ai", text: result.text, model: result.model };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: `model adapter failed: ${reason}` };
  }
}
