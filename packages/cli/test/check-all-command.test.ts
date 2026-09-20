import { describe, expect, it } from "vitest";
import { pnpmInvocation } from "../../../scripts/check-all-command.mjs";

describe("check-all pnpm command invocation", () => {
  it("keeps POSIX execution direct and argument-preserving", () => {
    const args = ["exec", "vitest", "run"];
    expect(pnpmInvocation("linux", args)).toEqual({ file: "pnpm", args });
  });

  it("routes fixed Windows steps through an explicit inert cmd.exe", () => {
    expect(pnpmInvocation("win32", ["run", "build"], { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd run build"],
    });
  });

  it("rejects every relevant cmd expansion, metacharacter, quote, grouping, and control class", () => {
    const unsafe: Array<[string, string]> = [
      ["percent expansion", "%PATH%"],
      ["delayed expansion", "!PATH!"],
      ["escape", "vitest^run"],
      ["command separator", "vitest&calc"],
      ["pipe", "vitest|calc"],
      ["input redirect", "vitest<input"],
      ["output redirect", "vitest>output"],
      ["double quote", 'vitest"run'],
      ["single quote", "vitest'run"],
      ["open group", "vitest(run"],
      ["close group", "vitest)run"],
      ["space", "vitest run"],
      ["tab", "vitest\trun"],
      ["newline", "vitest\nrun"],
      ["carriage return", "vitest\rrun"],
      ["NUL control", "vitest\0run"],
      ["escape control", "vitest\u001brun"],
      ["empty token", ""],
    ];
    for (const [label, token] of unsafe) {
      expect(
        () => pnpmInvocation("win32", ["exec", token], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
        label,
      ).toThrow("fixed repository-owned");
    }
  });

  it("rejects every ASCII character outside the documented fixed-token alphabet", () => {
    const allowed = /^[A-Za-z0-9._/-]$/u;
    for (let code = 0; code <= 0x7f; code += 1) {
      const character = String.fromCharCode(code);
      if (allowed.test(character)) continue;
      expect(
        () => pnpmInvocation("win32", [`safe${character}token`], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
        `ASCII 0x${code.toString(16).padStart(2, "0")}`,
      ).toThrow("fixed repository-owned");
    }
  });

  it("rejects non-cmd command processors", () => {
    expect(() => pnpmInvocation("win32", ["run", "build"], { ComSpec: "C:\\tools\\wrapper.exe" })).toThrow("absolute cmd.exe");
  });
});
