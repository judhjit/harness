import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fixtureRoot } from "./helpers.ts";
import {
  terminalArguments,
  TerminalGeminiRuntime,
} from "../packages/adapters/src/terminal-runtime.ts";
import { InstalledGeminiRuntime } from "../packages/adapters/src/runtime.ts";
import { Waiting } from "../packages/core/src/contracts.ts";

const pty = fileURLToPath(
  new URL("./fixtures/terminal-pty.py", import.meta.url),
);
const driver = fileURLToPath(
  new URL("./fixtures/terminal-driver.ts", import.meta.url),
);
const run = (root: string, id: string, mode = "success") =>
  execFileSync(
    "python3",
    [pty, mode, process.execPath, driver, root, id, mode],
    { encoding: "utf8", timeout: 30000 },
  );
test("both runtimes inherit managed approvals and terminal mode never forces headless flags", () => {
  const args = terminalArguments(["--model", "fixture"], "/tmp/prompt.txt");
  assert.ok(args.includes("--prompt-interactive"));
  assert.ok(!args.includes("--approval-mode"));
  assert.ok(!args.includes("--output-format"));
  assert.throws(
    () => terminalArguments(["--approval-mode=auto_edit"], "prompt"),
    /managed/,
  );
  assert.throws(() => terminalArguments(["--yolo"], "prompt"), /managed/);
  assert.throws(() => terminalArguments(["-p", "task"], "prompt"), /manages/);
  const runtime = new InstalledGeminiRuntime(fixtureRoot(), fixtureRoot(), {
    executable: "gemini",
    args: [],
    environmentNames: [],
  });
  assert.ok(!runtime.launch("").args.includes("--approval-mode"));
});
test("unattached runtime requests a durable handoff without launching Gemini", async () => {
  const root = fixtureRoot(),
    id = randomUUID();
  const runtime = new TerminalGeminiRuntime(root, root, {
    executable: "not-installed",
    args: [],
    environmentNames: [],
  });
  let state: any;
  runtime.onState = (value) => (state = value);
  await assert.rejects(async () => {
    for await (const _ of runtime.run(
      { invocationId: id, prompt: "task", timeoutMs: 5000 },
      new AbortController().signal,
    )) {
    }
  }, Waiting);
  assert.equal(state.status, "WAITING");
  assert.equal(readFileSync(state.promptPath, "utf8"), "task");
});
test(
  "real TTY delivers tool approvals and operator result back to harness",
  { skip: process.platform === "win32" },
  () => {
    const root = fixtureRoot(),
      id = randomUUID(),
      output = run(root, id);
    assert.match(output, /TTY_CONFIRMED/);
    assert.match(output, /HARNESS_RESULT=\{"summary":"fixture result"\}/);
    const result = JSON.parse(
      readFileSync(join(root, "terminal-sessions", id, "result.json"), "utf8"),
    );
    assert.equal(result.origin, "operator-paste");
    assert.equal(result.toolTraceCaptured, false);
  },
);
test(
  "terminal result entry can pause and resume without rerunning Gemini",
  { skip: process.platform === "win32" },
  () => {
    const root = fixtureRoot(),
      id = randomUUID();
    assert.match(run(root, id, "pause"), /HANDOFF_WAITING/);
    const resumed = run(root, id);
    assert.doesNotMatch(resumed, /TTY_CONFIRMED/);
    assert.match(resumed, /HARNESS_RESULT=/);
  },
);
test(
  "terminal timeout stops interactive Gemini and cannot pass the phase",
  { skip: process.platform === "win32" },
  () => {
    const root = fixtureRoot(),
      id = randomUUID();
    const output = run(root, id, "timeout");
    assert.doesNotMatch(output, /HARNESS_RESULT=/);
    assert.match(output, /deadline exceeded/);
    const exit = JSON.parse(
      readFileSync(join(root, "terminal-sessions", id, "exit.json"), "utf8"),
    );
    assert.equal(exit.stopped, "TIMEOUT");
  },
);
