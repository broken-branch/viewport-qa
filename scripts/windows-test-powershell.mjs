import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WINDOWS_TEST_COMPILE_TIMEOUT_MS = 15_000;

export function runWindowsPowerShellScript(script, args = [], options = {}) {
  const root = mkdtempSync(join(tmpdir(), "vqa-windows-test-powershell-"));
  const path = join(root, "invoke.ps1");
  try {
    writeFileSync(path, `${script}\n`);
    return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args], options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runWindowsPowerShellScriptAsync(script, args = [], options = {}) {
  const root = mkdtempSync(join(tmpdir(), "vqa-windows-test-powershell-"));
  const path = join(root, "invoke.ps1");
  try {
    writeFileSync(path, `${script}\n`);
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, ...args],
        options,
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function compileWindowsTestExecutable(outputPath, source) {
  runWindowsPowerShellScript(
    "param([Parameter(Mandatory=$true)][string]$SourcePath, [Parameter(Mandatory=$true)][string]$OutputPath)\n$ErrorActionPreference = \"Stop\"\nAdd-Type -Path $SourcePath -OutputAssembly $OutputPath -OutputType ConsoleApplication",
    [source, outputPath],
    { timeout: WINDOWS_TEST_COMPILE_TIMEOUT_MS },
  );
}
