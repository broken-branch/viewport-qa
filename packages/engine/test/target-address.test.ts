import { describe, expect, it } from "vitest";
import { normalizeTargetAddress } from "../src/target-address.js";

describe("normalizeTargetAddress", () => {
  it("completes a bare public host with https", () => {
    expect(normalizeTargetAddress("example.com")).toBe("https://example.com/");
    expect(normalizeTargetAddress("  www.example.co.uk/pricing?plan=a#top ")).toBe("https://www.example.co.uk/pricing?plan=a#top");
    expect(normalizeTargetAddress("EXAMPLE.com:8443/app")).toBe("https://example.com:8443/app");
  });

  it("completes loopback hosts with http, as local dev servers expect", () => {
    expect(normalizeTargetAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeTargetAddress("127.0.0.1:8080/index.html")).toBe("http://127.0.0.1:8080/index.html");
  });

  it("leaves anything that already has a scheme alone", () => {
    expect(normalizeTargetAddress("http://example.com")).toBe("http://example.com");
    expect(normalizeTargetAddress("file:///tmp/page.html")).toBe("file:///tmp/page.html");
    expect(normalizeTargetAddress("ftp://example.com")).toBe("ftp://example.com");
  });

  it("returns null for text that is not a web address", () => {
    for (const text of ["", "   ", "fixtures/page.html", "just words", "no-dot", "-bad.example.com", "./page.html"]) {
      expect(normalizeTargetAddress(text), text).toBeNull();
    }
  });
});
