import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../packages/core/src/coordinator.ts";
import { compileWorkflow } from "../packages/core/src/contracts.ts";
import { SqliteStore } from "../packages/adapters/src/sqlite.ts";
import { atomicWrite, hash, redact } from "../packages/adapters/src/files.ts";
import { fixtureRoot, config, runtime } from "./helpers.ts";

test("planning workflow produces durable selected outputs and provenance; terminal resume is read-only", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  try {
    const run = store.create(await config(root));
    const result = await new Coordinator(store, runtime(root), hash).resume(
      run.id,
    );
    assert.equal(result.status, "COMPLETED", result.error ?? "");
    assert.deepEqual(
      store.phases(run.id).map((p) => p.status),
      ["PASSED", "PASSED", "PASSED"],
    );
    const events = store.events(run.id);
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((_, i) => i + 1),
    );
    assert.ok(events.some((e) => e.type === "AGENT_SESSION_STARTED"));
    assert.equal(
      JSON.parse(store.read(store.selected(run.id, "plan"))).steps.length,
      2,
    );
    const contexts = store
      .artifacts(run.id)
      .filter((a) => a.role === "context")
      .map((a) => JSON.parse(store.read(a)));
    assert.equal(
      contexts[0].items.some((i: any) => i.source === "phase"),
      false,
    );
    assert.equal(
      contexts[1].items.filter((i: any) => i.source === "phase").length,
      1,
    );
    assert.deepEqual(contexts[1].omittedFiles, ["README.md"]);
    assert.equal(
      (await new Coordinator(store, runtime(root), hash).resume(run.display_id))
        .status,
      "COMPLETED",
    );
    assert.equal(store.events(run.id).length, events.length);
  } finally {
    store.close();
  }
});

for (const mode of ["claim", "bad-json", "no-result", "exit-error"])
  test(`${mode} cannot pass and exhausts a bounded retry budget`, async () => {
    const root = fixtureRoot();
    const store = new SqliteStore(root);
    try {
      const run = store.create(await config(root));
      const result = await new Coordinator(
        store,
        runtime(root, mode),
        hash,
      ).resume(run.id);
      assert.equal(result.status, "FAILED", result.error ?? "");
      assert.equal(store.phases(run.id)[1].attempts, 2);
      assert.equal(store.phases(run.id)[2].status, "PENDING");
      assert.throws(() => store.selected(run.id, "requirements"));
    } finally {
      store.close();
    }
  });

test("tool events cause a policy block, never a false success", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  try {
    const run = store.create(await config(root));
    assert.equal(
      (await new Coordinator(store, runtime(root, "tool"), hash).resume(run.id))
        .status,
      "BLOCKED",
    );
  } finally {
    store.close();
  }
});

test("another connection requests cancellation while invocation is running", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  const other = new SqliteStore(root);
  try {
    const run = store.create(await config(root));
    const timer = setInterval(() => {
      if (store.phases(run.id)[1].status === "RUNNING")
        other.requestCancel(run.id);
    }, 50);
    try {
      assert.equal(
        (
          await new Coordinator(store, runtime(root, "hang"), hash).resume(
            run.id,
          )
        ).status,
        "CANCELLED",
      );
    } finally {
      clearInterval(timer);
    }
    assert.equal(store.phases(run.id)[2].status, "CANCELLED");
  } finally {
    other.close();
    store.close();
  }
});

test("timeouts stop invocation and consume bounded attempts", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  try {
    const c = await config(root);
    c.workflow.phases[1].timeoutMs = 500;
    const run = store.create(c);
    assert.equal(
      (await new Coordinator(store, runtime(root, "hang"), hash).resume(run.id))
        .status,
      "FAILED",
    );
    assert.equal(store.phases(run.id)[1].attempts, 2);
  } finally {
    store.close();
  }
});

test("live ownership cannot be stolen and stale coordinator writes are fenced", async () => {
  const root = fixtureRoot();
  const a = new SqliteStore(root);
  const b = new SqliteStore(root);
  try {
    const run = a.create(await config(root));
    await a.acquire(run.id);
    await assert.rejects(b.acquire(run.id), /live coordinator/);
    a.release(run.id);
    await b.acquire(run.id);
    assert.throws(() => a.state(run.id, "COMPLETED"), /ownership lost/);
    b.release(run.id);
  } finally {
    a.close();
    b.close();
  }
});

test("interrupted attempt is preserved and retries do not reuse unselected artifacts", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  try {
    const c = await config(root);
    c.workflow.phases[0].maxAttempts = 2;
    const run = store.create(c);
    await store.acquire(run.id);
    const attempt = store.start(run.id, c.workflow.phases[0]);
    store.put(run.id, attempt.id, "ticket", { forged: true });
    store.release(run.id);
    assert.equal(
      (await new Coordinator(store, runtime(root), hash).resume(run.id)).status,
      "COMPLETED",
    );
    assert.equal(store.phases(run.id)[0].attempts, 2);
    assert.equal(
      store.events(run.id).filter((e) => e.type === "ATTEMPT_INTERRUPTED")
        .length,
      1,
    );
    assert.equal(
      JSON.parse(store.read(store.selected(run.id, "ticket"))).key,
      "JIRA-428",
    );
  } finally {
    store.close();
  }
});

test("artifact corruption blocks progress and can be repaired without resetting history", async () => {
  const root = fixtureRoot();
  const store = new SqliteStore(root);
  try {
    const c = await config(root);
    const run = store.create(c);
    await store.acquire(run.id);
    const a = store.start(run.id, c.workflow.phases[0]);
    const artifact = store.put(run.id, a.id, "ticket", c.ticket);
    store.pass(a, artifact);
    store.release(run.id);
    const path = join(root, "blobs", artifact.hash);
    const original = readFileSync(path, "utf8");
    atomicWrite(path, "broken");
    assert.equal(
      (await new Coordinator(store, runtime(root), hash).resume(run.id)).status,
      "BLOCKED",
    );
    assert.equal(store.phases(run.id)[1].attempts, 0);
    atomicWrite(path, original);
    assert.equal(
      (await new Coordinator(store, runtime(root), hash).resume(run.id)).status,
      "COMPLETED",
    );
  } finally {
    store.close();
  }
});

test("workflow compiler rejects cycles, unknown executors and excessive retries", async () => {
  const c = await config(fixtureRoot());
  for (const mutate of [
    (w: any) => w.phases[0].dependsOn.push("implementation-plan"),
    (w: any) => (w.phases[1].executor = "shell"),
    (w: any) => (w.phases[1].maxAttempts = 99),
  ]) {
    const workflow = structuredClone(c.workflow);
    mutate(workflow);
    assert.throws(() => compileWorkflow(workflow));
  }
});

test("known secrets are redacted", () => {
  assert.equal(
    redact("Authorization: Bearer abc.def\napi_key=secret-value"),
    "Authorization: Bearer [REDACTED]\napi_key=[REDACTED]",
  );
});
