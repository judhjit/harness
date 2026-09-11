import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWrite, processIdentity } from "./files.ts";

// Same foreground terminal process group: detaching Gemini here would make terminal
// reads fail with SIGTTIN. Cleanup therefore targets owned descendants, not our group.
let started = false;
process.on("disconnect", () => {
  if (!started) process.exit(1);
});
process.once("message", (message: any) => {
  started = true;
  const { directory, command, args, cwd, env, timeoutMs } = message;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  let stopped: string | undefined, spawnError: string | undefined;
  const descendants = new Map<number, string>();
  const sample = () => {
    try {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 2000000,
      })
        .trim()
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .filter(Boolean);
      const owned = new Set<number>(child.pid ? [child.pid] : []);
      for (const [pid, identity] of descendants)
        if (processIdentity(pid) === identity) owned.add(pid);
      for (let n = 0; n < rows.length; n++) {
        let added = false;
        for (const row of rows)
          if (owned.has(Number(row![2])) && !owned.has(Number(row![1]))) {
            owned.add(Number(row![1]));
            added = true;
          }
        if (!added) break;
      }
      for (const row of rows)
        if (owned.has(Number(row![1])))
          descendants.set(Number(row![1]), row![3].trim());
      atomicWrite(
        join(directory, "descendants.json"),
        JSON.stringify(
          [...descendants].map(([pid, identity]) => ({ pid, identity })),
        ),
      );
    } catch {
      /* Reconciliation checks every persisted identity; do not kill broad groups. */
    }
  };
  const cleanup = () => {
    sample();
    for (const [pid, identity] of [...descendants].reverse()) {
      try {
        if (processIdentity(pid) === identity) process.kill(pid, "SIGKILL");
      } catch {}
    }
    if (child.pid) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };
  const stop = (reason: string) => {
    stopped ??= reason;
    cleanup();
  };
  if (child.pid)
    atomicWrite(
      join(directory, "child.json"),
      JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid) }),
    );
  const timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
  const sampling = setInterval(sample, 1000);
  process.on("disconnect", () => stop("PARENT_DISCONNECTED"));
  process.on("message", (m: any) => {
    if (m?.type === "STOP") stop("CANCELLED");
  });
  process.on("SIGTERM", () => stop("CANCELLED"));
  process.on("SIGINT", () => stop("CANCELLED"));
  process.on("SIGHUP", () => stop("TERMINAL_CLOSED"));
  child.on("error", (error) => {
    spawnError = String(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    clearInterval(sampling);
    cleanup();
    atomicWrite(
      join(directory, "exit.json"),
      JSON.stringify({
        code,
        signal,
        stopped,
        spawnError,
        finishedAt: new Date().toISOString(),
      }),
    );
    process.disconnect?.();
  });
});
