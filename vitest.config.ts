import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    setupFiles: ["scripts/vitest-setup.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 180_000,
    coverage: { enabled: false },
  },
});
