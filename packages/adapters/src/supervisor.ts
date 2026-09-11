// Separate process: owns invocation timeout and kills the group if its parent dies.
// The parent must persist this supervisor's identity before sending GO.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite, processIdentity, redact, sanitize } from "./files.ts";

process.on("message", (message: any) => {
  if (message.type !== "GO") return;
  process.removeAllListeners("message");
  const { directory, command, args, cwd, env, prompt, timeoutMs } = message;
  atomicWrite(
    join(directory, "launch.json"),
    JSON.stringify({ at: new Date().toISOString() }),
  );
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    shell: false,
  });
  if (child.pid)
    atomicWrite(
      join(directory, "child.json"),
      JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid) }),
    );
  let stopped: string | null = null;
  let bytes = 0;
  let stdout = "";
  let stderr = "";
  const sanitizedLine = (line: string) => {
    try {
      return JSON.stringify(sanitize(JSON.parse(line)));
    } catch {
      return redact(line);
    }
  };
  const stop = (reason: string) => {
    stopped ??= reason;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  };
  const timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
  const alive = setInterval(() => {
    if (!process.connected) stop("PARENT_EXIT");
  }, 100);
  process.on("disconnect", () => stop("PARENT_EXIT"));
  process.on("SIGTERM", () => stop("CANCELLED"));
  const consume = (stream: "stdout" | "stderr", chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2_000_000) {
      stop("OUTPUT_LIMIT");
      return;
    }
    let pending = (stream === "stdout" ? stdout : stderr) + chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      appendFileSync(
        join(directory, `${stream}.jsonl`),
        sanitizedLine(pending.slice(0, newline)) + "\n",
        { mode: 0o600 },
      );
      pending = pending.slice(newline + 1);
    }
    if (stream === "stdout") stdout = pending;
    else stderr = pending;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => consume("stdout", data));
  child.stderr.on("data", (data) => consume("stderr", data));
  let spawnError: string | undefined;
  child.on("error", (error) => {
    spawnError = redact(error.message);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    clearInterval(alive);
    // Kill any remaining members of the owned group before publishing completion.
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    if (stdout)
      appendFileSync(
        join(directory, "stdout.jsonl"),
        sanitizedLine(stdout) + "\n",
        { mode: 0o600 },
      );
    if (stderr)
      appendFileSync(
        join(directory, "stderr.jsonl"),
        sanitizedLine(stderr) + "\n",
        { mode: 0o600 },
      );
    for (const name of ["stdout.jsonl", "stderr.jsonl"]) {
      if (!existsSync(join(directory, name))) continue;
      const fd = openSync(join(directory, name), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    atomicWrite(
      join(directory, "exit.json"),
      JSON.stringify({
        code,
        signal,
        stopped,
        spawnError,
        endedAt: new Date().toISOString(),
      }),
    );
    process.exit(0);
  });
});
// No GO: no runtime process exists. Exit if coordinator dies during handshake.
process.on("disconnect", () => {
  if (process.listenerCount("message")) process.exit(0);
});
