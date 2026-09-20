#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliSubprocessModelAdapter } from "../../src/index.ts";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const marker = process.argv[2];
if (!marker) throw new Error("grandchild marker path is required");

const adapter = new CliSubprocessModelAdapter({
  provider: "codex",
  binary: join(fixtureDirectory, "fake-model-cli.mjs"),
  timeoutMs: 2_000,
});
const result = await adapter.complete({
  role: "fix-recommender",
  prompt: `__MODE_SURVIVING_GRANDCHILD__\n__GROUP_MARKER__${marker}`,
});
if (result.text !== "Use min-width: 0.") {
  throw new Error("probe did not receive valid adapter output");
}
