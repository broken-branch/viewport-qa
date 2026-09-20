import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_SPECS,
  parseViewport,
  parseViewportList,
} from "../src/index.js";

describe("parseViewport", () => {
  it("parses WxH and WxH@DPR", () => {
    expect(parseViewport("390x844")).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      label: "390x844@1",
    });
    expect(parseViewport("390x844@3").deviceScaleFactor).toBe(3);
  });

  it("rejects malformed specs", () => {
    expect(() => parseViewport("390x")).toThrow(/Invalid viewport/);
    expect(() => parseViewport("10x10")).toThrow(/out of supported range/);
  });
});

describe("parseViewportList", () => {
  it("defaults to the common device matrix", () => {
    const list = parseViewportList(undefined);
    expect(list.map((viewport) => viewport.label)).toEqual(
      [...DEFAULT_VIEWPORT_SPECS].map((spec) =>
        spec.includes("@") ? spec : `${spec}@1`,
      ),
    );
  });

  it("parses a custom comma list", () => {
    expect(
      parseViewportList("360x800, 1920x1080@2").map(
        (viewport) => viewport.label,
      ),
    ).toEqual(["360x800@1", "1920x1080@2"]);
  });
});
