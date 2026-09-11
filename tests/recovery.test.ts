import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../packages/core/src/coordinator.ts";
import { SqliteStore } from "../packages/adapters/src/sqlite.ts";
import { hash } from "../packages/adapters/src/files.ts";
import { fixtureRoot, runtime } from "./helpers.ts";

for (const mode of ["artifact", "phase", "agent"])
  test(`SIGKILL recovery at ${mode} boundary`, { timeout: 15000 }, async () => {
    const root = fixtureRoot();
    const child = fork(
      fileURLToPath(new URL("./fixtures/recovery-driver.ts", import.meta.url)),
      [root, mode],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
    );
    let errors = "";
    child.stderr?.on("data", (data) => (errors += data));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const runId = await new Promise<string>((resolve, reject) => {
      child.once("message", (message: any) => resolve(message.runId));
      child.once("exit", () =>
        reject(new Error(errors || "Driver ended before creating run")),
      );
    });
    const store = new SqliteStore(root);
    try {
      child.send("GO");
      if (mode === "agent") {
        let directory = "";
        for (let n = 0; n < 100; n++) {
          const attempt = store.db
            .prepare(
              "SELECT id FROM attempts WHERE run_id=? AND phase_id='requirements'",
            )
            .get(runId) as any;
          if (attempt) directory = join(root, "invocations", attempt.id);
          if (directory && existsSync(join(directory, "child.json"))) break;
          await delay(30);
        }
        assert.ok(
          directory && existsSync(join(directory, "child.json")),
          errors,
        );
        child.kill("SIGKILL");
        await exited;
        for (
          let n = 0;
          n < 100 && !existsSync(join(directory, "exit.json"));
          n++
        )
          await delay(30);
        assert.ok(
          existsSync(join(directory, "exit.json")),
          "Supervisor must stop the invocation after coordinator death",
        );
      } else await exited;
      const result = await new Coordinator(store, runtime(root), hash).resume(
        runId,
      );
      assert.equal(result.status, "COMPLETED", result.error ?? errors);
      assert.equal(
        store.phases(runId)[0].attempts,
        mode === "artifact" ? 2 : 1,
      );
      assert.equal(store.phases(runId)[1].attempts, mode === "agent" ? 2 : 1);
      assert.equal(
        store
          .events(runId)
          .filter((e) => e.type === "PHASE_PASSED" && e.phase_id === "intake")
          .length,
        1,
      );
    } finally {
      child.kill("SIGKILL");
      store.close();
    }
  });
