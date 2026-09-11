import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../packages/core/src/coordinator.ts";
import { SqliteStore } from "../packages/adapters/src/sqlite.ts";
import { hash } from "../packages/adapters/src/files.ts";
import { config, fixtureRoot, runtime } from "./helpers.ts";

test("CLI status, logs and artifact queries share durable state without advancing it", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../apps/cli/bin/eng.mjs", import.meta.url)),
        ...args,
        "--data",
        root,
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    const run = store.create(await config(root));
    await new Coordinator(store, runtime(root), hash).resume(run.id);
    const count = store.events(run.id).length;
    const status = JSON.parse(cli("status", run.display_id));
    assert.equal(status.status, "COMPLETED");
    const events = cli("logs", run.display_id, "--after", String(count - 1))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "RUN_COMPLETED");
    const plan = JSON.parse(
      cli(
        "artifact",
        run.display_id,
        "--artifact",
        store.selected(run.id, "plan").id,
      ),
    );
    assert.equal(plan.ticketKey, "JIRA-428");
    assert.equal(store.events(run.id).length, count);
  } finally {
    store.close();
  }
});
