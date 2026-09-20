import { describe, expect, it } from "vitest";
import { crawlSameOrigin, normalizeCrawlLinks } from "../src/index.js";

describe("crawl link normalization", () => {
  it("resolves relative URLs, strips fragments, filters, and deduplicates", () => {
    expect(
      normalizeCrawlLinks(
        "https://example.test/docs/start",
        "https://example.test",
        [
          "../about#team",
          "https://example.test/about",
          "/docs/start#top",
          "https://other.test/page",
          "mailto:hello@example.test",
          "tel:+15551212",
          "javascript:void(0)",
          "data:text/plain,hello",
          "/brochure.pdf?download=1",
          "not a valid url %",
        ],
      ),
    ).toEqual([
      "https://example.test/about",
      "https://example.test/docs/start",
      "https://example.test/docs/not%20a%20valid%20url%20%",
    ]);
  });
});

describe("bounded same-origin crawl", () => {
  it("visits breadth-first and obeys the page cap strictly", async () => {
    const visited: string[] = [];
    const results = await crawlSameOrigin(
      "https://example.test/",
      { maxPages: 3, maxDepth: 2 },
      async (url) => {
        visited.push(url);
        const path = new URL(url).pathname;
        return {
          value: path,
          finalUrl: url,
          hrefs:
            path === "/"
              ? ["/a", "/b"]
              : path === "/a"
                ? ["/deep"]
                : [],
        };
      },
    );

    expect(visited).toEqual([
      "https://example.test/",
      "https://example.test/a",
      "https://example.test/b",
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((result) => result.depth)).toEqual([0, 1, 1]);
  });

  it("obeys the depth cap and continues after a page failure", async () => {
    const visited: string[] = [];
    const results = await crawlSameOrigin(
      "https://example.test/",
      { maxPages: 10, maxDepth: 1 },
      async (url) => {
        visited.push(url);
        const path = new URL(url).pathname;
        if (path === "/broken") throw new Error("navigation failed");
        return {
          value: path,
          finalUrl: url,
          hrefs: path === "/" ? ["/broken", "/ok"] : ["/too-deep"],
        };
      },
    );

    expect(visited).toEqual([
      "https://example.test/",
      "https://example.test/broken",
      "https://example.test/ok",
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "success",
      "failed",
      "success",
    ]);
    expect(results[1]).toMatchObject({ error: "navigation failed" });
  });

  it("re-keys a consistent on-origin client navigation across viewports", async () => {
    const startUrl = "https://example.test/start";
    const finalUrl = "https://example.test/app";
    const results = await crawlSameOrigin(
      startUrl,
      { maxPages: 1, maxDepth: 0 },
      async (url, _depth, _index, claimFinalUrl) => {
        expect(claimFinalUrl(url)).toBe(startUrl);
        expect(claimFinalUrl(finalUrl)).toBe(finalUrl);
        expect(claimFinalUrl(url)).toBe(startUrl);
        expect(claimFinalUrl(finalUrl)).toBe(finalUrl);
        return { value: "app", finalUrl, hrefs: [] };
      },
    );

    expect(results).toEqual([
      { url: finalUrl, depth: 0, status: "success", value: "app" },
    ]);
  });

  it("rolls back a speculative re-key when viewport final URLs disagree", async () => {
    const origin = "https://example.test";
    const visited: string[] = [];
    const results = await crawlSameOrigin(
      `${origin}/`,
      { maxPages: 3, maxDepth: 1 },
      async (url, _depth, _index, claimFinalUrl) => {
        visited.push(url);
        const path = new URL(url).pathname;
        if (path === "/flip") {
          expect(claimFinalUrl(url)).toBe(`${origin}/flip`);
          expect(claimFinalUrl(`${origin}/flip-a`)).toBe(`${origin}/flip-a`);
          claimFinalUrl(`${origin}/flip-b`);
        }
        return {
          value: path,
          finalUrl: url,
          hrefs: path === "/" ? ["/flip", "/flip-a"] : [],
        };
      },
    );

    expect(visited).toEqual([
      `${origin}/`,
      `${origin}/flip`,
      `${origin}/flip-a`,
    ]);
    expect(results).toEqual([
      { url: `${origin}/`, depth: 0, status: "success", value: "/" },
      {
        url: `${origin}/flip-b`,
        depth: 1,
        status: "failed",
        error: `Navigation final URL changed from ${origin}/flip-a to ${origin}/flip-b`,
      },
      {
        url: `${origin}/flip-a`,
        depth: 1,
        status: "success",
        value: "/flip-a",
      },
    ]);
  });
});
