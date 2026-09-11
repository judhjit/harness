import { fork, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessError } from "../../core/src/contracts.ts";
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  RuntimeDescriptor,
} from "../../core/src/contracts.ts";
import {
  atomicWrite,
  hash,
  privateDirectory,
  processIdentity,
  safeRead,
} from "./files.ts";

export interface Launch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface RuntimeConfig {
  executable: string;
  readOnlyPaths: string[];
  environment?: Record<string, string>;
  inheritEnvironment?: string[];
}

// Shared process plumbing, also exercised by the fixture runtime in tests.
export class ProcessRuntime implements AgentRuntime {
  allowTools = false;
  rawOutput = false;
  root: string;
  descriptor: RuntimeDescriptor;
  launch: (directory: string) => Launch;
  active = new Map<string, ReturnType<typeof fork>>();
  constructor(
    root: string,
    descriptor: RuntimeDescriptor,
    launch: (directory: string) => Launch,
  ) {
    this.root = root;
    this.descriptor = descriptor;
    this.launch = launch;
  }
  async describe() {
    return this.descriptor;
  }
  async cancel(id: string) {
    this.active.get(id)?.kill("SIGTERM");
  }
  evidence(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new HarnessError("INPUT", "Invalid invocation ID");
    const directory = join(this.root, "invocations", id);
    return [
      "stdout.jsonl",
      "stderr.jsonl",
      "exit.json",
      "process.json",
      "child.json",
    ]
      .filter((name) => existsSync(join(directory, name)))
      .map((name) => ({
        role: `runtime-${name}`,
        value: { sanitized: true, content: safeRead(join(directory, name)) },
      }));
  }
  async *run(
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (!/^[a-f0-9-]{36}$/.test(request.invocationId))
      throw new HarnessError("INPUT", "Invalid invocation ID");
    if (signal.aborted)
      throw new HarnessError("CANCELLED", "Invocation cancelled");
    const directory = privateDirectory(
      join(this.root, "invocations", request.invocationId),
    );
    if (existsSync(join(directory, "intent.json")))
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Invocation IDs cannot be replayed",
      );
    const launch = this.launch(directory);
    atomicWrite(
      join(directory, "intent.json"),
      JSON.stringify({
        invocationId: request.invocationId,
        descriptor: this.descriptor,
      }),
    );
    const supervisor = fork(
      fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
      [],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
      },
    );
    this.active.set(request.invocationId, supervisor);
    let supervisorError: Error | undefined;
    supervisor.on("error", (error) => {
      supervisorError = error;
    });
    const stop = () => {
      supervisor.kill("SIGTERM");
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (!supervisor.pid)
        throw new HarnessError("INFRASTRUCTURE", "Cannot launch supervisor");
      atomicWrite(
        join(directory, "process.json"),
        JSON.stringify({
          pid: supervisor.pid,
          identity: processIdentity(supervisor.pid),
        }),
      );
      await new Promise<void>((resolve, reject) =>
        supervisor.send(
          {
            type: "GO",
            directory,
            ...launch,
            prompt: request.prompt,
            timeoutMs: request.timeoutMs,
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      let consumed = 0;
      let response = "";
      let final: any;
      let init = false;
      while (true) {
        const outputPath = join(directory, "stdout.jsonl");
        const text = existsSync(outputPath) ? safeRead(outputPath) : "";
        const complete = text.lastIndexOf("\n") + 1;
        const lines = text
          .slice(consumed, complete)
          .split("\n")
          .filter(Boolean);
        consumed = complete;
        for (const line of lines) {
          if (this.rawOutput) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            throw new HarnessError("AGENT", "Malformed Gemini JSONL output");
          }
          if (final)
            throw new HarnessError(
              "AGENT",
              "Event received after final result",
            );
          switch (event.type) {
            case "init":
              init = true;
              yield { type: "SESSION_STARTED", payload: event };
              break;
            case "message":
              if (
                event.role === "assistant" &&
                typeof event.content === "string"
              )
                response += event.content;
              yield { type: "MESSAGE", payload: event };
              break;
            case "tool_use":
              yield { type: "TOOL_REQUESTED", payload: event };
              if (this.allowTools) break;
              throw new HarnessError(
                "POLICY",
                "Tool execution is outside the stdin-only planning profile",
              );
            case "tool_result":
              yield { type: "TOOL_RESULT", payload: event };
              break;
            case "error":
              yield { type: "AGENT_ERROR", payload: event };
              break;
            case "result":
              final = event;
              break;
            default:
              yield { type: "RAW", payload: event };
          }
        }
        if (existsSync(join(directory, "exit.json"))) {
          // Supervisor publishes exit only after all stdout has been flushed.
          const latest = existsSync(outputPath) ? safeRead(outputPath) : "";
          if (latest.length > consumed) continue;
          const exit = JSON.parse(safeRead(join(directory, "exit.json")));
          if (signal.aborted)
            throw new HarnessError("CANCELLED", "Invocation cancelled");
          if (exit.stopped === "TIMEOUT")
            throw new HarnessError("TIMEOUT", "Agent deadline exceeded");
          if (this.rawOutput) {
            yield {
              type: "COMPLETED",
              payload: {
                text: JSON.stringify({
                  stdout: latest,
                  stderr: existsSync(join(directory, "stderr.jsonl"))
                    ? safeRead(join(directory, "stderr.jsonl"))
                    : "",
                  ...exit,
                }),
                exitCode: exit.code ?? 1,
              },
            };
            return;
          }
          if (
            exit.code !== 0 ||
            exit.signal ||
            exit.stopped ||
            exit.spawnError ||
            !init ||
            !final ||
            final.status !== "success"
          )
            throw new HarnessError(
              "AGENT",
              `Unsuccessful invocation: ${JSON.stringify(exit)}; result=${final?.status ?? "missing"}`,
            );
          yield {
            type: "COMPLETED",
            payload: {
              text: response,
              exitCode: exit.code,
              usage: final.stats,
            },
          };
          return;
        }
        if (
          supervisorError ||
          supervisor.exitCode !== null ||
          supervisor.signalCode !== null
        )
          throw new HarnessError(
            "INFRASTRUCTURE",
            "Supervisor exited without durable completion",
          );
        await delay(25);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => supervisor.once("exit", resolve)),
          delay(3000),
        ]);
        if (supervisor.exitCode === null && supervisor.signalCode === null)
          throw new HarnessError(
            "INFRASTRUCTURE",
            "Supervisor has not stopped; automatic retry is blocked",
          );
      }
      this.active.delete(request.invocationId);
    }
  }
}

// Uses the already-installed CLI and its workstation authentication. This is
// cooperative workspace isolation, not a new OS security boundary.
export class InstalledGeminiRuntime extends ProcessRuntime {
  executable: string;
  constructor(
    root: string,
    workspace: string,
    config: { executable: string; args: string[]; environmentNames: string[] },
    _readOnly = false,
  ) {
    const env = Object.fromEntries(
      ["PATH", "HOME", "USER", "TMPDIR", ...config.environmentNames]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]!]),
    );
    const descriptor = {
      name: "gemini-cli",
      version: "installed",
      executableHash: hash(config.executable),
      configHash: hash(JSON.stringify(config)),
      isolation: "workstation",
    };
    super(root, descriptor, () => ({
      command: config.executable,
      args: [
        ...config.args,
        "--output-format",
        "stream-json",
        "--prompt",
        "Complete the task supplied on stdin. Return the requested JSON.",
      ],
      cwd: workspace,
      env,
    }));
    this.allowTools = true;
    this.executable = config.executable;
  }
  async describe() {
    try {
      return {
        ...this.descriptor,
        version: execFileSync(this.executable, ["--version"], {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 64000,
        }).trim(),
      };
    } catch {
      throw new HarnessError(
        "INFRASTRUCTURE",
        `Installed Gemini CLI unavailable: ${this.executable}. Run eng doctor in the VS Code terminal.`,
      );
    }
  }
}

export class GeminiCliRuntime extends ProcessRuntime {
  config: RuntimeConfig;
  executable: string;
  constructor(
    root: string,
    config: RuntimeConfig,
    protectedPaths: string[] = [],
  ) {
    if (!isAbsolute(config.executable) || !Array.isArray(config.readOnlyPaths))
      throw new HarnessError(
        "INPUT",
        "Runtime config needs an absolute executable and readOnlyPaths",
      );
    const executable = realpathSync(config.executable);
    const paths = config.readOnlyPaths.map((p) => realpathSync(p));
    const systemPaths =
      process.platform === "darwin"
        ? ["/usr", "/bin", "/System", "/Library", "/private/etc"]
        : ["/usr", "/bin", "/lib", "/lib64", "/etc"];
    for (const p of [...paths, ...systemPaths]) {
      if (
        !isAbsolute(p) ||
        p === "/" ||
        p === "/Users" ||
        p === "/home" ||
        [root, ...protectedPaths].some(
          (target) => target === p || !relative(p, target).startsWith(".."),
        )
      )
        throw new HarnessError(
          "POLICY",
          `Read mount exposes harness state or a broad home root: ${p}`,
        );
    }
    if (
      !paths.some(
        (p) => executable === p || !relative(p, executable).startsWith(".."),
      )
    )
      throw new HarnessError(
        "POLICY",
        "Gemini installation must be inside an explicit read-only mount",
      );
    const descriptor: RuntimeDescriptor = {
      name: "gemini-cli",
      version: "unprobed",
      executableHash: hash(readFileSync(executable)),
      configHash: hash(JSON.stringify(config)),
      isolation: process.platform === "darwin" ? "sandbox-exec" : "bubblewrap",
    };
    const launch = (directory: string): Launch => {
      const scratch = privateDirectory(join(directory, "scratch"));
      const gemini = privateDirectory(join(scratch, ".gemini"));
      const policies = privateDirectory(join(gemini, "policies"));
      atomicWrite(
        join(policies, "planning.toml"),
        '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
      );
      const inherited = Object.fromEntries(
        (config.inheritEnvironment ?? []).map((name) => {
          if (
            !/^[A-Z][A-Z0-9_]*$/.test(name) ||
            process.env[name] === undefined
          )
            throw new HarnessError(
              "INPUT",
              `Configured runtime environment variable is missing: ${name}`,
            );
          return [name, process.env[name]!];
        }),
      );
      const env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        ...config.environment,
        ...inherited,
        HOME: scratch,
        TMPDIR: scratch,
      };
      const args = [
        "--output-format",
        "stream-json",
        "--prompt",
        "Read the task and context from stdin. Return only the requested JSON.",
      ];
      if (process.platform === "darwin") {
        const quoted = (p: string) => JSON.stringify(p);
        const read = [
          ...new Set([
            "/usr",
            "/bin",
            "/System",
            "/Library",
            "/private/etc",
            ...paths,
            scratch,
          ]),
        ];
        const policy =
          `(version 1)\n(deny default)\n(allow process-exec process-fork sysctl-read mach-lookup network-outbound file-read-metadata)\n` +
          `(allow file-read* ${read.map((p) => `(subpath ${quoted(p)})`).join(" ")} (literal "/") (literal "/dev/null") (literal "/dev/urandom"))\n` +
          `(allow file-write* (subpath ${quoted(scratch)}) (literal "/dev/null"))\n` +
          `(deny file-write* (subpath ${quoted(policies)}))\n`;
        const profile = join(directory, "sandbox.sb");
        atomicWrite(profile, policy);
        return {
          command: "/usr/bin/sandbox-exec",
          args: ["-f", profile, executable, ...args],
          cwd: scratch,
          env,
        };
      }
      if (process.platform === "linux") {
        if (!existsSync("/usr/bin/bwrap"))
          throw new HarnessError(
            "POLICY",
            "Install approved bubblewrap at /usr/bin/bwrap; unrestricted fallback is disabled",
          );
        const mounts = [
          ...new Set(["/usr", "/bin", "/lib", "/lib64", "/etc", ...paths]),
        ].filter(existsSync);
        return {
          command: "/usr/bin/bwrap",
          args: [
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--share-net",
            ...mounts.flatMap((p) => ["--ro-bind", p, p]),
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--bind",
            scratch,
            scratch,
            "--ro-bind",
            policies,
            policies,
            "--chdir",
            scratch,
            "--",
            executable,
            ...args,
          ],
          cwd: scratch,
          env,
        };
      }
      throw new HarnessError(
        "POLICY",
        "No approved process containment adapter for this platform",
      );
    };
    super(root, descriptor, launch);
    this.config = config;
    this.executable = executable;
  }
  async describe() {
    // Probe the exact executable inside the same isolation profile; no unrestricted --version launch.
    const dir = privateDirectory(join(this.root, `probe-${randomUUID()}`));
    const launch = this.launch(dir);
    launch.args = launch.args
      .slice(0, launch.args.indexOf(this.executable) + 1)
      .concat("--version");
    try {
      const version = execFileSync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64000,
      }).trim();
      this.descriptor = {
        ...this.descriptor,
        version,
        executableHash: hash(readFileSync(this.executable)),
      };
      return this.descriptor;
    } catch (error) {
      throw new HarnessError(
        "POLICY",
        `Gemini isolation/version probe failed: ${String(error)}`,
      );
    }
  }
}
