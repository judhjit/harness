import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRuntime,
  AgentEvent,
  AgentRequest,
} from "../../core/src/contracts.ts";
import { HarnessError, Waiting } from "../../core/src/contracts.ts";
import {
  atomicWrite,
  hash,
  privateDirectory,
  processIdentity,
  safeRead,
} from "./files.ts";
import { InstalledGeminiRuntime } from "./runtime.ts";

export function assertManagedArguments(args: string[]) {
  if (
    args.some(
      (arg) =>
        /^(--approval-mode|--yolo|--skip-trust|--allowed-tools)(=|$)/.test(
          arg,
        ) || arg === "-y",
    )
  )
    throw new HarnessError(
      "POLICY",
      "Remove approval/auto-approval overrides from runtime.args; inherit the managed Gemini policy",
    );
}
export function terminalArguments(args: string[], promptPath: string) {
  assertManagedArguments(args);
  if (
    args.some(
      (arg) =>
        /^(--prompt|--prompt-interactive|--output-format|--resume)(=|$)/.test(
          arg,
        ) || ["-p", "-i", "-o", "-r"].includes(arg),
    )
  )
    throw new HarnessError(
      "INPUT",
      "Terminal runtime manages prompt/session arguments; remove prompt, output-format and resume flags from runtime.args",
    );
  return [
    ...args,
    "--prompt-interactive",
    `Read the phase instructions and context from this local UTF-8 file using your file-reading tool: ${JSON.stringify(promptPath)}. Perform only that phase. Ask the operator for any approvals required by the managed policy. Return the requested JSON in your final chat response; do NOT write the report to a file or use shell commands to serialize it. The operator will copy the JSON back to the harness and exit this session.`,
  ];
}
export async function readTerminalResult(signal: AbortSignal): Promise<string> {
  process.stdout.write(
    "\nGemini exited. Paste its final JSON response below, then enter .end on a separate line.\nEnter .pause to defer this handoff without passing the phase. No tests are trusted from this report.\n",
  );
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 0,
  });
  return new Promise((resolve, reject) => {
    let text = "",
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      reader.close();
      error ? reject(error) : resolve(text.trim());
    };
    const abort = () =>
      finish(new HarnessError("CANCELLED", "Terminal result entry cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    reader.on("SIGINT", abort);
    reader.on("close", () => {
      if (!done) finish(new Waiting());
    });
    reader.on("line", (line) => {
      if (line.trim() === ".pause") return finish(new Waiting());
      if (line.trim() === ".end") {
        try {
          JSON.parse(
            text
              .trim()
              .replace(/^```(?:json)?\s*/, "")
              .replace(/\s*```$/, ""),
          );
          finish();
        } catch {
          process.stdout.write(
            "Invalid JSON. Paste the entire response again, then .end.\n",
          );
          text = "";
        }
        return;
      }
      text += line + "\n";
      if (Buffer.byteLength(text) > 500000)
        finish(
          new HarnessError("VALIDATION", "Terminal response exceeds 500 KB"),
        );
    });
    if (signal.aborted) abort();
  });
}

export class TerminalGeminiRuntime implements AgentRuntime {
  resultDelivery = "operator-paste" as const;
  root: string;
  cwd: string;
  config: { executable: string; args: string[]; environmentNames: string[] };
  attached: boolean;
  onState: (value: unknown) => void = () => {};
  active = new Map<string, ReturnType<typeof fork>>();
  constructor(
    root: string,
    cwd: string,
    config: TerminalGeminiRuntime["config"],
    attached = false,
  ) {
    this.root = root;
    this.cwd = cwd;
    this.config = config;
    this.attached = attached;
    terminalArguments(config.args, "prompt");
  }
  async describe() {
    return {
      name: "gemini-cli-terminal",
      version: "probe-on-terminal-launch",
      executableHash: hash(this.config.executable),
      configHash: hash(JSON.stringify(this.config)),
      isolation: "workstation",
    };
  }
  async cancel(id: string) {
    const supervisor = this.active.get(id);
    if (supervisor?.connected) supervisor.send({ type: "STOP" });
  }
  directory(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new HarnessError("INPUT", "Invalid terminal invocation ID");
    return join(this.root, "terminal-sessions", id);
  }
  evidence(id: string) {
    const directory = this.directory(id);
    return ["exit.json", "result.json", "launch.json"]
      .filter((name) => existsSync(join(directory, name)))
      .map((name) => ({
        role: `terminal-${name}`,
        value: JSON.parse(safeRead(join(directory, name))),
      }));
  }
  async *run(
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (signal.aborted)
      throw new HarnessError("CANCELLED", "Terminal invocation cancelled");
    const directory = privateDirectory(this.directory(request.invocationId));
    const promptPath = join(directory, "prompt.txt");
    const promptHash = hash(request.prompt);
    if (existsSync(promptPath) && hash(safeRead(promptPath)) !== promptHash)
      throw new HarnessError(
        "POLICY",
        "Terminal handoff context changed; start a new attempt/run",
      );
    if (!existsSync(promptPath)) atomicWrite(promptPath, request.prompt);
    const state = {
      invocationId: request.invocationId,
      cwd: this.cwd,
      promptPath,
      promptHash,
      mode: "terminal",
      resultDelivery: "operator-paste",
    };
    if (!this.attached || !process.stdin.isTTY || !process.stdout.isTTY) {
      this.onState({ ...state, status: "WAITING" });
      throw new Waiting();
    }
    this.onState({ ...state, status: "ACTIVE" });
    if (existsSync(join(directory, "result.json"))) {
      const saved = JSON.parse(safeRead(join(directory, "result.json")));
      if (saved.promptHash !== promptHash)
        throw new HarnessError("POLICY", "Terminal result context mismatch");
      this.onState(null);
      yield { type: "COMPLETED", payload: { text: saved.text, exitCode: 0 } };
      return;
    }
    if (!existsSync(join(directory, "exit.json"))) {
      if (existsSync(join(directory, "launch.json")))
        throw new HarnessError(
          "INFRASTRUCTURE",
          "Interrupted terminal launch; reconcile the recorded session before retrying",
        );
      const descriptor = await new InstalledGeminiRuntime(
        this.root,
        this.cwd,
        this.config,
      ).describe();
      const args = terminalArguments(this.config.args, promptPath);
      atomicWrite(
        join(directory, "launch.json"),
        JSON.stringify({
          descriptor,
          command: this.config.executable,
          args,
          cwd: this.cwd,
          promptHash,
          transcriptCaptured: false,
        }),
      );
      process.stdout.write(
        `\nStarting interactive Gemini in ${this.cwd}. Approve tools inside Gemini.\nAfter the phase, copy the final JSON and exit Gemini (/quit), then paste it into the harness.\n`,
      );
      const supervisor = fork(
        fileURLToPath(new URL("./terminal-supervisor.ts", import.meta.url)),
        [],
        { stdio: ["inherit", "inherit", "inherit", "ipc"], execArgv: [] },
      );
      this.active.set(request.invocationId, supervisor);
      let error: Error | undefined;
      supervisor.on("error", (e) => {
        error = e;
      });
      atomicWrite(
        join(directory, "process.json"),
        JSON.stringify({
          pid: supervisor.pid,
          identity: processIdentity(supervisor.pid!),
        }),
      );
      const env = Object.fromEntries(
        [
          "PATH",
          "HOME",
          "USER",
          "TMPDIR",
          "TERM",
          "COLORTERM",
          "LANG",
          "LC_ALL",
          ...this.config.environmentNames,
        ]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]!]),
      );
      const abort = () => {
        if (supervisor.connected) supervisor.send({ type: "STOP" });
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await new Promise<void>((resolve, reject) =>
          supervisor.send(
            {
              directory,
              command: this.config.executable,
              args,
              cwd: this.cwd,
              env,
              timeoutMs: request.timeoutMs,
            },
            (e) => (e ? reject(e) : resolve()),
          ),
        );
        while (!existsSync(join(directory, "exit.json"))) {
          if (error) throw error;
          if (supervisor.exitCode !== null || supervisor.signalCode)
            throw new HarnessError(
              "INFRASTRUCTURE",
              "Terminal supervisor exited without a durable result",
            );
          await delay(100);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        this.active.delete(request.invocationId);
        if (!existsSync(join(directory, "exit.json")))
          supervisor.kill("SIGTERM");
      }
    }
    const exit = JSON.parse(safeRead(join(directory, "exit.json")));
    if (signal.aborted)
      throw new HarnessError("CANCELLED", "Terminal phase cancelled");
    if (exit.stopped === "TIMEOUT")
      throw new HarnessError("TIMEOUT", "Terminal Gemini deadline exceeded");
    if (exit.code !== 0 || exit.signal || exit.stopped || exit.spawnError)
      throw new HarnessError(
        "AGENT",
        "Interactive Gemini did not exit successfully; inspect terminal evidence",
      );
    this.onState({ ...state, status: "AWAITING_RESULT" });
    let text: string;
    try {
      text = await readTerminalResult(signal);
    } catch (error) {
      if (error instanceof Waiting)
        this.onState({ ...state, status: "WAITING_RESULT" });
      throw error;
    }
    atomicWrite(
      join(directory, "result.json"),
      JSON.stringify({
        text,
        promptHash,
        origin: "operator-paste",
        toolTraceCaptured: false,
        submittedAt: new Date().toISOString(),
      }),
    );
    this.onState(null);
    yield {
      type: "RAW",
      payload: { kind: "OPERATOR_RESULT_SUBMITTED", toolTraceCaptured: false },
    };
    yield { type: "COMPLETED", payload: { text, exitCode: 0 } };
  }
}
