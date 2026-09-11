import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Application } from "../packages/adapters/src/application.ts";
import { fixtureRoot } from "./helpers.ts";
import { git } from "../packages/adapters/src/commands.ts";
import {
  validateGraph,
  ExternalGraphProvider,
} from "../packages/adapters/src/graph.ts";
import { createApi } from "../apps/server/src/server.ts";
import type { AgentRuntime } from "../packages/core/src/contracts.ts";
import { Evaluations } from "../packages/adapters/src/evals.ts";
import { referenceWorkflow } from "../packages/core/src/product.ts";
import { hash } from "../packages/adapters/src/files.ts";

export function productFixture() {
  const root = fixtureRoot(),
    repo = fixtureRoot();
  writeFileSync(join(repo, "value.cjs"), "module.exports = 0;\n");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local",
    "commit",
    "-m",
    "base",
  ]);
  const factory = (
    _profile: any,
    workspace: string,
    provider: string,
  ): AgentRuntime => ({
    async describe() {
      return {
        name: "fixture",
        version: "1",
        executableHash: "fixture",
        configHash: "fixture",
        isolation: "test",
      };
    },
    async cancel() {},
    async *run() {
      if (provider === "implement" || provider === "repair")
        writeFileSync(join(workspace, "value.cjs"), "module.exports = 1;\n");
      const response =
        provider === "requirements"
          ? { criteria: [{ id: "AC1", description: "Value is one" }] }
          : provider === "plan"
            ? {
                steps: [
                  { description: "Set value to one", criterionIds: ["AC1"] },
                ],
                verification: ["Assert exported value"],
              }
            : provider === "review"
              ? {
                  summary: "Verified change",
                  criteria: [
                    {
                      id: "AC1",
                      status: "PASS",
                      evidence: "value.cjs exports one",
                    },
                  ],
                  findings: [],
                }
              : { summary: "Done", changedFiles: ["value.cjs"] };
      yield {
        type: "COMPLETED",
        payload: { text: JSON.stringify(response), exitCode: 0 },
      };
    },
  });
  const app = new Application(root, factory);
  app.register({
    id: "pilot",
    path: repo,
    checks: [
      {
        id: "test",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:assert/strict').equal(require('./value.cjs'), 1)",
        ],
        required: true,
        timeoutMs: 5000,
      },
    ],
  });
  return { root, repo, app };
}

test("engineering run produces candidate, independent evidence, waits for approval and resumes once", async () => {
  const { app, repo } = productFixture();
  try {
    const created = await app.create("pilot", {
      key: "ENG-1",
      description: "Set exported value to one",
    });
    const waiting = await app.execute(created.id);
    assert.equal(waiting.status, "WAITING", waiting.error ?? "");
    assert.equal(waiting.phases.length, 9);
    assert.equal(waiting.verification.results[0].passed, true);
    assert.equal(
      readFileSync(join(repo, "value.cjs"), "utf8"),
      "module.exports = 0;\n",
    );
    const approval = waiting.approvals[0];
    app.approve(approval.id, approval.subject_hash, "APPROVED");
    const completed = await app.execute(created.id);
    assert.equal(completed.status, "COMPLETED", completed.error ?? "");
    assert.equal(
      completed.phases.find((p) => p.phase_id === "approval")!.attempts,
      1,
    );
    assert.equal(completed.publication.mode, "local");
  } finally {
    app.close();
  }
});

test("custom skill phase uses declared context and JSON Schema without new executor code", async () => {
  const { app } = productFixture();
  try {
    const profile = app.data.repository("pilot");
    const workflow = structuredClone(referenceWorkflow);
    workflow.phases[1] = {
      ...workflow.phases[1],
      provider: "agent-task",
      skill: "team-investigation",
      inputs: [],
      access: "read",
      outputSchema: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    };
    app.register({
      ...profile,
      workflow,
      skills: {
        "team-investigation": "Return a JSON summary of the repository.",
      },
    });
    const created = await app.create("pilot", {
      key: "ENG-3",
      description: "Set value",
    });
    const result = await app.execute(created.id);
    assert.equal(result.status, "WAITING", result.error ?? "");
    assert.ok(
      result.artifacts.some((a) => a.role === "context:team-investigation"),
    );
  } finally {
    app.close();
  }
});

test("paired evals use independent scorers and never request publication", async () => {
  const { app } = productFixture();
  try {
    const evaluation = await new Evaluations(app).run({
      name: "behavior-fixture",
      repetitions: 1,
      cases: [
        {
          id: "one",
          repositoryId: "pilot",
          ticket: {
            key: "ENG-4",
            title: "One",
            description: "Set value",
            acceptanceCriteria: ["Value one"],
          },
          expectedFiles: ["value.cjs"],
          scorers: [
            {
              id: "behavior",
              executable: process.execPath,
              args: [
                "-e",
                "require('node:assert/strict').equal(require(process.argv[1]+'/value.cjs'),1)",
                "{workspace}",
              ],
              timeoutMs: 5000,
            },
          ],
        },
      ],
      variants: [
        { id: "control", graphContext: false },
        { id: "treatment", graphContext: true },
      ],
    });
    assert.equal(evaluation.results.length, 2);
    assert.ok(evaluation.results.every((r: any) => r.result.solved));
    assert.equal(app.data.approvals().length, 0);
    assert.equal(evaluation.variants[0].total, 1);
  } finally {
    app.close();
  }
});

test("approval refuses a changed worktree", async () => {
  const { app } = productFixture();
  try {
    const created = await app.create("pilot", {
      key: "ENG-2",
      description: "Set value",
    });
    const run = await app.execute(created.id);
    assert.equal(run.status, "WAITING", run.error ?? "");
    writeFileSync(
      join(run.candidate.workspace, "value.cjs"),
      "module.exports=2",
    );
    assert.throws(
      () =>
        app.approve(
          run.approvals[0].id,
          run.approvals[0].subject_hash,
          "APPROVED",
        ),
      /Candidate changed/,
    );
  } finally {
    app.close();
  }
});

test("graph is optional and external results reject stale revisions and dangling edges", async () => {
  const request = {
    repository: "/repo",
    revision: "abc",
    operation: "search" as const,
    query: "Foo",
    limit: 10,
  };
  const result = {
    schemaVersion: 1,
    provider: "graphify-wrapper",
    providerVersion: "1",
    revision: "abc",
    nodes: [{ id: "a", name: "Foo", type: "Class" }],
    edges: [],
    diagnostics: [],
    complete: true,
  };
  assert.equal(validateGraph(result, request).provider, "graphify-wrapper");
  assert.throws(
    () => validateGraph({ ...result, revision: "old" }, request),
    /stale/,
  );
  assert.throws(
    () =>
      validateGraph(
        {
          ...result,
          edges: [{ source: "a", target: "missing", type: "CALLS" }],
        },
        request,
      ),
    /missing/,
  );
  const dir = fixtureRoot();
  writeFileSync(join(dir, "graph.json"), JSON.stringify(result));
  const provider = new ExternalGraphProvider({
    id: "graphify",
    type: "snapshot",
    path: join(dir, "graph.json"),
    capabilities: ["search"],
  });
  assert.equal((await provider.query(request)).nodes[0].name, "Foo");
  await assert.rejects(
    provider.query({ ...request, operation: "callers" }),
    /does not support/,
  );
});

test("API requires bearer auth and rejects cross-origin mutations", async () => {
  const { app } = productFixture();
  const server = createApi(app, "fixture-token");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as any;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + "/api/v1/runs")).status, 401);
    const response = await fetch(base + "/api/v1/repositories", {
      headers: { Authorization: "Bearer fixture-token" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].id, "pilot");
    assert.equal(
      (
        await fetch(base + "/api/v1/runs", {
          method: "POST",
          headers: {
            Authorization: "Bearer fixture-token",
            Origin: "https://attacker.invalid",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

test("publication reconciles an existing candidate PR without pushing or creating another", async () => {
  const { app } = productFixture();
  try {
    const profile = app.data.repository("pilot");
    app.register({ ...profile, base: "main", integrations: { stash: "fixture", project: "P", slug: "repo" } });
    const run = await app.create("pilot", { key: "ENG-5", description: "Set value" });
    const waiting = await app.execute(run.id);
    let lookups = 0;
    app.client = () => ({
      async findPR() { lookups++; return { id: 42, fromRef: { latestCommit: waiting.candidate.revision } }; },
      async request() { throw new Error("Unexpected external write"); },
    }) as any;
    app.approve(waiting.approvals[0].id, waiting.approvals[0].subject_hash, "APPROVED");
    const completed = await app.execute(run.id);
    assert.equal(completed.status, "COMPLETED", completed.error ?? "");
    assert.equal(completed.publication.id, 42);
    await app.publish(run.id, app.data.repository("pilot"));
    assert.equal(lookups, 1);
  } finally { app.close(); }
});

test("ambiguous publication without a remote match blocks instead of replaying", async () => {
  const { app } = productFixture();
  try {
    app.register({ ...app.data.repository("pilot"), base: "main", integrations: { stash: "fixture", project: "P", slug: "repo" } });
    const run = await app.create("pilot", { key: "ENG-6", description: "Set value" });
    const waiting = await app.execute(run.id);
    app.approve(waiting.approvals[0].id, waiting.approvals[0].subject_hash, "APPROVED");
    const subject = app.publicationSubject(run.id, app.data.repository("pilot"));
    app.store.db.prepare("INSERT INTO external_actions VALUES(?,?,?,'STARTED',?,NULL)").run(hash(JSON.stringify(subject)), run.id, "publication", JSON.stringify(subject));
    app.client = () => ({ async findPR() { return null; }, async request() { throw new Error("Must not publish"); } }) as any;
    await assert.rejects(app.publish(run.id, app.data.repository("pilot")), /ambiguous/);
  } finally { app.close(); }
});
