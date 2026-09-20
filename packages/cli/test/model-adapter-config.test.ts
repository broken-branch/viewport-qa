import { describe, expect, it } from "vitest";
import { modelAdapterFromConfiguration } from "../src/index.js";

describe("model CLI configuration", () => {
  it("keeps the production adapter disabled by default", () => {
    expect(modelAdapterFromConfiguration({ environment: {} })).toBeUndefined();
  });

  it("constructs the wired adapter only after an explicit CLI flag opt-in", () => {
    expect(
      modelAdapterFromConfiguration({
        cliFlag: "codex",
        binaryFlag: "/explicit/fake-codex",
        timeoutFlag: "1234",
        environment: {},
      })?.describe(),
    ).toEqual({
      impl: "cli-subprocess:codex",
      wired: true,
      contractVersion: "1",
    });
  });

  it("constructs the wired adapter after an explicit environment opt-in", () => {
    expect(
      modelAdapterFromConfiguration({
        environment: { VQA_MODEL_CLI: "claude" },
      })?.describe().impl,
    ).toBe("cli-subprocess:claude");
  });

  it("rejects binary or timeout settings without an explicit provider opt-in", () => {
    expect(() =>
      modelAdapterFromConfiguration({
        environment: { VQA_MODEL_CLI_BIN: "/not-an-opt-in" },
      }),
    ).toThrow("requires explicit --model-cli or VQA_MODEL_CLI opt-in");
  });

  it("rejects unknown providers and invalid timeouts", () => {
    expect(() =>
      modelAdapterFromConfiguration({
        cliFlag: "other",
        environment: {},
      }),
    ).toThrow('must be "codex" or "claude"');
    expect(() =>
      modelAdapterFromConfiguration({
        cliFlag: "codex",
        timeoutFlag: "0",
        environment: {},
      }),
    ).toThrow("Invalid --model-cli-timeout");
    expect(() =>
      modelAdapterFromConfiguration({ cliFlag: "", environment: {} }),
    ).toThrow('must be "codex" or "claude"');
  });
});
