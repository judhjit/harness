import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessError } from "../../core/src/contracts.ts";
import type { SourceSnapshot } from "../../core/src/contracts.ts";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const encode = (value: unknown) => JSON.stringify(value);
export function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[\w.\-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|access[_-]?token|password|secret)$/i.test(key)
          ? "[REDACTED]"
          : sanitize(item),
      ]),
    );
  return value;
}
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw new HarnessError(
      "POLICY",
      `Data path must be canonical and not a symlink: ${path}`,
    );
  return path;
}
export function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function safeRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error.code === "ESRCH") return null;
    throw new HarnessError("INFRASTRUCTURE", `Cannot inspect process ${pid}`);
  }
  try {
    return (
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
      }).trim() || null
    );
  } catch {
    throw new HarnessError(
      "INFRASTRUCTURE",
      `Cannot establish identity of process ${pid}`,
    );
  }
}
export function sourceSnapshot(
  repository: string,
  paths: string[],
  maxBytes = 256_000,
): SourceSnapshot {
  const repo = realpathSync(repository);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
  const revision = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const tracked = git(["ls-tree", "-r", "--name-only", revision])
    .split("\n")
    .filter(Boolean);
  if (paths.length === 0)
    throw new HarnessError(
      "INPUT",
      "Select repository context with --files path1,path2 (committed files only)",
    );
  let size = 0;
  const files = paths.map((path) => {
    if (!tracked.includes(path) || /[\x00-\x1f]/.test(path))
      throw new HarnessError("INPUT", `Not a committed source path: ${path}`);
    const mode = git(["ls-tree", revision, "--", path]).split(" ")[0];
    if (mode !== "100644" && mode !== "100755")
      throw new HarnessError(
        "POLICY",
        `Only regular source files are allowed: ${path}`,
      );
    const content = git(["show", `${revision}:${path}`]);
    size += Buffer.byteLength(content);
    if (content.includes("\0") || size > maxBytes)
      throw new HarnessError(
        "INPUT",
        "Source context is binary or exceeds 256 KB",
      );
    if (redact(content) !== content)
      throw new HarnessError(
        "POLICY",
        `Potential secret in selected source: ${path}`,
      );
    return { path, content, hash: hash(content) };
  });
  return {
    repository: repo,
    revision,
    files,
    omitted: tracked.filter((p) => !paths.includes(p)),
  };
}
