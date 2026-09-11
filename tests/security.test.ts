import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { GeminiCliRuntime } from "../packages/adapters/src/runtime.ts";
import {
  atomicWrite,
  privateDirectory,
} from "../packages/adapters/src/files.ts";
import { fixtureRoot } from "./helpers.ts";

test("runtime refuses broad read mounts exposing control state or the source checkout", () => {
  const root = fixtureRoot();
  assert.throws(
    () =>
      new GeminiCliRuntime(root, {
        executable: process.execPath,
        readOnlyPaths: ["/"],
      }),
    /Read mount/,
  );
  assert.throws(
    () =>
      new GeminiCliRuntime(root, {
        executable: process.execPath,
        readOnlyPaths: [root],
      }),
    /Read mount/,
  );
  assert.throws(
    () =>
      new GeminiCliRuntime(
        root,
        {
          executable: process.execPath,
          readOnlyPaths: [dirname(process.execPath)],
        },
        [process.execPath],
      ),
    /Read mount/,
  );
});

test("symlink data roots are rejected", () => {
  const root = fixtureRoot();
  const target = fixtureRoot();
  symlinkSync(target, join(root, "link"));
  assert.throws(() => privateDirectory(join(root, "link")), /symlink/);
});

test(
  "production sandbox allows scratch writes and denies control-state writes and source reads",
  {
    skip: process.platform !== "darwin" && !existsSync("/usr/bin/bwrap"),
  },
  () => {
    const root = fixtureRoot();
    const source = fixtureRoot();
    const protectedFile = join(source, "private.txt");
    atomicWrite(protectedFile, "source must stay inaccessible");
    const executable = realpathSync(process.execPath);
    const runtime = new GeminiCliRuntime(
      root,
      { executable, readOnlyPaths: [dirname(executable)] },
      [source],
    );
    const launch = runtime.launch(
      privateDirectory(join(root, "sandbox-check")),
    );
    const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(launch.cwd, "allowed"))},'ok');
    for (const [op,path] of [['write',${JSON.stringify(join(root, "forbidden"))}],['read',${JSON.stringify(protectedFile)}]]) {
      try { if(op==='write') fs.writeFileSync(path,'bad'); else fs.readFileSync(path); process.exit(9); } catch {}
    }`;
    const args = launch.args
      .slice(0, launch.args.indexOf(executable) + 1)
      .concat("-e", code);
    execFileSync(launch.command, args, {
      cwd: launch.cwd,
      env: launch.env,
      timeout: 5000,
    });
    assert.ok(existsSync(join(launch.cwd, "allowed")));
    assert.ok(!existsSync(join(root, "forbidden")));
  },
);
