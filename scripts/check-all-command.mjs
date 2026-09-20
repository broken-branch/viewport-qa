import { win32 } from "node:path";

const FIXED_TOKEN = /^[A-Za-z0-9._/-]+$/u;

export function pnpmInvocation(platform, args, environment = process.env) {
  if (platform !== "win32") return { file: "pnpm", args };
  if (!args.every((token) => FIXED_TOKEN.test(token))) {
    throw new Error("Windows pnpm invocation accepts only fixed repository-owned argument tokens");
  }
  const commandProcessor = environment.ComSpec ?? environment.COMSPEC ?? (
    environment.SystemRoot ? win32.join(environment.SystemRoot, "System32", "cmd.exe") : undefined
  );
  if (!commandProcessor || !win32.isAbsolute(commandProcessor) || win32.basename(commandProcessor).toLowerCase() !== "cmd.exe") {
    throw new Error("Windows pnpm invocation requires an absolute cmd.exe command processor");
  }
  // Node 24 cannot spawn a .cmd shim directly on Windows. /d disables AutoRun,
  // /s gives deterministic /c quote handling, and every joined token is fixed
  // above so no target/user text can enter cmd parsing.
  return {
    file: commandProcessor,
    args: ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`],
  };
}
