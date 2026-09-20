import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scan } from "../src/scan.js";

it("bounds hostile event ingestion and records omissions", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><script>
      for (let index = 0; index < 25; index += 1) console.error("repeated hostile error");
    </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-limits-"));
  try {
    const report = await scan({
      url: `http://127.0.0.1:${address.port}/`, outDir: join(root, "report"),
      maxCropsPerViewport: 0,
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
    });
    expect(report.viewports[0]?.behaviourCapture).toEqual(expect.objectContaining({
      truncated: true,
      omitted: expect.objectContaining({ consoleMessages: 5 }),
    }));
    const repeated = report.issues.find((issue) =>
      issue.behaviour?.kind === "console-message" &&
      issue.behaviour.text === "repeated hostile error");
    expect(repeated?.instanceCount).toBe(20);
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
