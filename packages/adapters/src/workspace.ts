import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { HarnessError } from "../../core/src/contracts.ts";
import type { Candidate, RepositoryProfile } from "../../core/src/product.ts";
import { git } from "./commands.ts";
import { atomicWrite, hash, privateDirectory } from "./files.ts";

export class Workspaces {
  root: string;
  constructor(root: string) {
    this.root = privateDirectory(join(root, "workspaces"));
    privateDirectory(join(this.root, "metadata"));
  }
  path(runId: string) {
    if (!/^[\da-f-]{36}$/.test(runId))
      throw new HarnessError("INPUT", "Invalid run ID");
    return join(this.root, runId);
  }
  create(runId: string, profile: RepositoryProfile, base: string): string {
    const path = this.path(runId);
    const branch = `eng/${runId}`;
    if (existsSync(path)) {
      this.identity(runId);
      if (git(path, ["branch", "--show-current"]) !== branch)
        throw new HarnessError("POLICY", "Workspace branch changed");
      return path;
    }
    if (git(profile.path, ["branch", "--list", branch]))
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Workspace creation ambiguous: branch already exists",
      );
    git(profile.path, ["worktree", "add", "-b", branch, path, base]);
    atomicWrite(
      join(this.root, "metadata", `${runId}.json`),
      JSON.stringify({ gitFile: readFileSync(join(path, ".git"), "utf8") }),
    );
    return path;
  }
  identity(runId: string) {
    const path = this.path(runId);
    const manifest = join(this.root, "metadata", `${runId}.json`);
    if (
      !existsSync(manifest) ||
      lstatSync(join(path, ".git")).isSymbolicLink() ||
      readFileSync(join(path, ".git"), "utf8") !==
        JSON.parse(readFileSync(manifest, "utf8")).gitFile
    )
      throw new HarnessError(
        "POLICY",
        "Workspace Git identity changed or creation was interrupted",
      );
  }
  snapshot(runId: string, profile: RepositoryProfile, base: string): Candidate {
    const workspace = this.path(runId);
    this.identity(runId);
    const files = git(workspace, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]);
    // Reject symlinks throughout the source workspace, including untracked paths.
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          [
            ".git",
            "node_modules",
            ".venv",
            "venv",
            "target",
            "build",
            "dist",
            "__pycache__",
          ].includes(entry.name)
        )
          continue;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink())
          throw new HarnessError(
            "POLICY",
            `Symlink in candidate: ${relative(workspace, full)}`,
          );
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(workspace);
    git(workspace, ["add", "-A", "--", "."]);
    const changed = git(workspace, ["diff", "--cached", "--name-only", base])
      .split("\n")
      .filter(Boolean);
    for (const file of changed) {
      if (
        profile.forbiddenPaths.some(
          (p) => file === p || file.startsWith(p.replace(/\/$/, "") + "/"),
        ) ||
        (profile.allowedPaths.length &&
          !profile.allowedPaths.some(
            (p) => file === p || file.startsWith(p.replace(/\/$/, "") + "/"),
          ))
      )
        throw new HarnessError(
          "POLICY",
          `Changed file outside approved scope: ${file}`,
        );
    }
    if (git(workspace, ["diff", "--cached", "--name-only"]))
      git(workspace, [
        "-c",
        "user.name=Engineering Harness",
        "-c",
        "user.email=harness@localhost",
        "commit",
        "-m",
        `Harness candidate ${runId}`,
      ]);
    const revision = git(workspace, ["rev-parse", "HEAD"]);
    return {
      revision,
      base,
      tree: git(workspace, ["rev-parse", "HEAD^{tree}"]),
      diff: git(workspace, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        base,
        revision,
      ]),
      files: changed,
      workspace,
    };
  }
  verify(candidate: Candidate) {
    this.identity(candidate.workspace.split("/").at(-1)!);
    if (
      git(candidate.workspace, ["rev-parse", "HEAD"]) !== candidate.revision ||
      git(candidate.workspace, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    )
      throw new HarnessError(
        "POLICY",
        "Candidate changed; verification/approval must be renewed",
      );
  }
}
