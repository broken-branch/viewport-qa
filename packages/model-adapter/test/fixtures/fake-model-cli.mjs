#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers";

function main() {
  const args = process.argv.slice(2);
  const prompt = args.at(-1) ?? "";
  const reply = (text) => process.stdout.write(JSON.stringify({ text }));

  if (prompt.includes("__MODE_EXIT__")) {
    reply("this output must not be accepted");
    process.stderr.write("fake stderr: sensitive noise must stay private\n");
    process.exit(1);
  }

  if (prompt.includes("__MODE_HANG__")) {
    const marker = /__GROUP_MARKER__([^\n]+)/.exec(prompt)?.[1];
    if (marker) {
      spawn(
        process.execPath,
        [
          "-e",
          "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 250)",
          marker,
        ],
        { stdio: "ignore" },
      );
    }
    setTimeout(() => {
      reply("late output must not be accepted");
      process.exit(0);
    }, 450);
    return;
  }

  if (prompt.includes("__MODE_SURVIVING_GRANDCHILD__")) {
    const marker = /__GROUP_MARKER__([^\n]+)/.exec(prompt)?.[1];
    if (!marker) process.exit(2);
    const readyMarker = `${marker}.ready`;
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { writeFileSync } = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          "writeFileSync(`${process.argv[1]}.pid`, String(process.pid));",
          "writeFileSync(`${process.argv[1]}.ready`, 'ready');",
          "setTimeout(() => writeFileSync(process.argv[1], 'survived'), 400);",
        ].join(""),
        marker,
      ],
      { stdio: "ignore" },
    );
    grandchild.unref();
    const readyDeadline = Date.now() + 1_000;
    const waitForReady = () => {
      if (existsSync(readyMarker)) {
        reply("Use min-width: 0.");
        process.exit(0);
      }
      if (Date.now() >= readyDeadline) process.exit(3);
      setTimeout(waitForReady, 5);
    };
    waitForReady();
    return;
  }

  if (prompt.includes("__MODE_EMPTY__")) process.exit(0);

  if (prompt.includes("__MODE_GARBAGE__")) {
    process.stdout.write("not-json model chatter");
    process.exit(0);
  }

  if (prompt.includes("__MODE_DUPLICATE_KEY__")) {
    process.stdout.write('{"text":"a","text":"b"}');
    process.exit(0);
  }

  if (prompt.includes("__MODE_SINGLE_KEY__")) {
    process.stdout.write('{"text":"single key accepted"}');
    process.exit(0);
  }

  if (prompt.includes("__MODE_OVERSIZED__")) {
    reply("x".repeat(32_768));
    process.exit(0);
  }

  if (prompt.includes("__MODE_STDERR_SUCCESS__")) {
    process.stderr.write("fake stderr: sensitive noise must stay private\n");
    reply("Use min-width: 0.");
    process.exit(0);
  }

  if (prompt.includes("__MODE_ECHO_ARGV__")) {
    reply(JSON.stringify({ args, prompt }));
    process.exit(0);
  }

  if (prompt.includes("__MODE_ENV__")) {
    reply(
      JSON.stringify(
        Object.keys(process.env).filter((name) => name.endsWith("API_KEY")),
      ),
    );
    process.exit(0);
  }

  if (prompt.includes("__MODE_REDACTION__")) {
    process.stderr.write(prompt);
    process.exit(1);
  }

  reply("Use min-width: 0.");
}

main();
