import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GeminiCliRuntime } from "../packages/adapters/src/runtime.ts";
import { SqliteStore } from "../packages/adapters/src/sqlite.ts";
import { Coordinator } from "../packages/core/src/coordinator.ts";
import { hash } from "../packages/adapters/src/files.ts";
import { fixtureRoot, config } from "./helpers.ts";

test(
  "opt-in installed Gemini planning smoke test",
  { skip: !process.env.ENG_LIVE_RUNTIME, timeout: 400000 },
  async () => {
    const root = fixtureRoot();
    const store = new SqliteStore(root);
    try {
      const runtime = new GeminiCliRuntime(
        root,
        JSON.parse(readFileSync(process.env.ENG_LIVE_RUNTIME!, "utf8")),
      );
      const c = await config(root);
      c.runtime = await runtime.describe();
      const run = store.create(c);
      const result = await new Coordinator(store, runtime, hash).resume(run.id);
      assert.equal(result.status, "COMPLETED", result.error ?? "");
    } finally {
      store.close();
    }
  },
);
