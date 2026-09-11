import { spawn, execFileSync } from "node:child_process";
import { HarnessError } from "../../core/src/contracts.ts";
import { redact } from "./files.ts";

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
}
export function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted)
      return reject(new HarnessError("CANCELLED", "Command cancelled"));
    const startedAt = new Date().toISOString();
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 60000);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 4_000_000) {
        overflow = true;
        kill();
        return;
      }
      stdout += data;
      options.onLine?.(redact(data));
    });
    child.stderr.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 4_000_000) {
        overflow = true;
        kill();
        return;
      }
      stderr += data;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      kill();
      if (overflow)
        return reject(
          new HarnessError("INFRASTRUCTURE", "Command output exceeded 4 MB"),
        );
      if (options.signal?.aborted)
        return reject(new HarnessError("CANCELLED", "Command cancelled"));
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: redact(stdout),
        stderr: redact(stderr),
        startedAt,
        endedAt: new Date().toISOString(),
      });
    });
  });
}
export function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fsmonitor=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8_000_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trimEnd();
}
