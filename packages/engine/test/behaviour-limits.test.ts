import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_LIMITS,
  BoundedRecords,
  sanitizedBehaviourUrl,
  type CaptureOmissions,
} from "../src/behaviour-limits.js";

describe("behaviour capture limits", () => {
  it("resolves relative URLs and strips opaque, cross-origin, and malformed queries", () => {
    expect(sanitizedBehaviourUrl("asset.js?kept=yes", "https://page.test/a/"))
      .toBe("https://page.test/a/asset.js?kept=yes");
    expect(sanitizedBehaviourUrl("https://other.test/a?secret=x", "https://page.test/"))
      .toBe("https://other.test/a");
    expect(sanitizedBehaviourUrl("data:text/plain,hello?secret=x", "file:///tmp/page.html"))
      .not.toContain("secret");
    expect(sanitizedBehaviourUrl("http://[invalid]?secret=x", "https://page.test/"))
      .toBe("http://[invalid][unparseable-url]");
  });

  it("caps distinct identities and occurrences while counting every omission", () => {
    const omitted: CaptureOmissions = {
      consoleMessages: 0, failedRequests: 0, storageChanges: 0,
    };
    const capture = new BoundedRecords<number>(omitted, "consoleMessages");
    for (let index = 0; index <= BEHAVIOUR_LIMITS.occurrencesPerIdentity; index += 1) {
      capture.add("repeated", index);
    }
    for (let index = 0; index < BEHAVIOUR_LIMITS.distinctPerKind; index += 1) {
      capture.add(`distinct-${index}`, index);
    }

    expect(capture.records).toHaveLength(
      BEHAVIOUR_LIMITS.occurrencesPerIdentity + BEHAVIOUR_LIMITS.distinctPerKind - 1,
    );
    expect(omitted.consoleMessages).toBe(2);
  });
});
