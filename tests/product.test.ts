import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fork, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { parseWorkspaceJson } from "../packages/adapters/src/multi-repository.ts";

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

function multiFixture() {
  const fixture = productFixture();
  const second = fixtureRoot();
  git(fixture.repo, ["clone", "--no-hardlinks", fixture.repo, second]);
  fixture.app.register({
    ...fixture.app.data.repository("pilot"),
    id: "frontend",
    path: second,
  });
  const workspace = fixture.app.multi.register({
    id: "product",
    name: "Product workspace",
    repositories: [
      { repositoryId: "pilot", dependsOn: [], task: "Implement shared value" },
      {
        repositoryId: "frontend",
        dependsOn: ["pilot"],
        task: "Consume shared value",
      },
    ],
    checks: [
      {
        id: "contract",
        executable: process.execPath,
        args: [
          "-e",
          "const assert=require('node:assert/strict');assert.equal(require(process.argv[1]+'/value.cjs'),require(process.argv[2]+'/value.cjs'));assert.equal(require(process.argv[1]+'/value.cjs'),1)",
          "{workspace:pilot}",
          "{workspace:frontend}",
        ],
        cwdRepository: "frontend",
        required: true,
        timeoutMs: 5000,
      },
    ],
  });
  return { ...fixture, second, workspace };
}

test("workspace import supports JSONC relative folders without executing tasks or overwriting profiles", () => {
  const { app, repo, second, workspace } = multiFixture();
  try {
    const file = join(repo, "product.code-workspace");
    writeFileSync(
      file,
      `{ // workspace\n "folders":[{"path":"."},{"path":${JSON.stringify(second)}},], "tasks":{"command":"never-execute"},}`,
    );
    const before = app.data.repository("pilot");
    const imported = app.multi.importWorkspace("imported", file);
    assert.deepEqual(
      imported.workspace.repositories.map((r) => r.repositoryId),
      ["pilot", "frontend"],
    );
    assert.deepEqual(app.data.repository("pilot"), before);
    assert.equal(imported.workspace.checks.length, 0);
    assert.throws(
      () => app.multi.create("imported", { key: "ENG-7", description: "test" }),
      /required cross/,
    );
    assert.throws(
      () =>
        app.multi.register({
          ...workspace,
          repositories: [workspace.repositories[1], workspace.repositories[0]],
        }),
      /dependencies/,
    );
    assert.throws(
      () =>
        app.multi.register({
          ...workspace,
          checks: [{ ...workspace.checks[0], args: ["{workspace:missing}"] }],
        }),
      /Unknown workspace/,
    );
    assert.deepEqual(
      parseWorkspaceJson('{"value":"https://example.test/a,]",}'),
      { value: "https://example.test/a,]" },
    );
    assert.throws(() => parseWorkspaceJson("{/*bad"), /Unterminated/);
  } finally {
    app.close();
  }
});

test("multi-repository run freezes profiles, verifies candidates together and uses one linked approval", async () => {
  const { app, workspace, repo, second } = multiFixture();
  try {
    const run = app.multi.create(
      workspace.id,
      { key: "ENG-7", description: "Set shared exported values to one" },
      false,
      false,
    );
    app.multi.register({ ...workspace, name: "Edited for future runs" });
    const waiting = await app.execute(run.id);
    assert.equal(waiting.status, "WAITING", waiting.error ?? "");
    assert.equal(waiting.workspace.name, "Product workspace");
    assert.equal(waiting.children!.length, 2);
    assert.ok(
      waiting.children!.every(
        (c) => c.status === "COMPLETED" && !c.publication,
      ),
    );
    assert.equal(waiting.crossVerification.results[0].passed, true);
    assert.equal(app.data.approvals().length, 1);
    const [approval] = waiting.approvals;
    assert.equal(approval.subject.type, "linked-publication");
    assert.equal(approval.subject.candidates.length, 2);
    await assert.rejects(() => app.execute(waiting.children![0].id), /parent/);
    await assert.rejects(
      () => app.publish(waiting.children![0].id, app.data.repository("pilot")),
      /ownership|approval/,
    );
    const dependent = waiting.children!.find(
      (c) => c.repository === "frontend",
    )!;
    assert.equal(
      app.data.data(dependent.id, "coordination-context").dependencies.length,
      1,
    );
    app.approve(approval.id, approval.subject_hash, "APPROVED");
    const completed = await app.execute(run.id);
    assert.equal(completed.status, "COMPLETED", completed.error ?? "");
    assert.equal(completed.publication.complete, true);
    assert.equal(completed.publication.publications.length, 2);
    assert.equal((await app.execute(run.id)).children!.length, 2);
    for (const path of [repo, second])
      assert.equal(
        readFileSync(join(path, "value.cjs"), "utf8"),
        "module.exports = 0;\n",
      );
  } finally {
    app.close();
  }
});

test("changing any member invalidates linked approval before publication", async () => {
  const { app, workspace } = multiFixture();
  try {
    const run = app.multi.create(
      workspace.id,
      { key: "ENG-8", description: "Set shared values" },
      false,
      false,
    );
    const waiting = await app.execute(run.id);
    assert.equal(waiting.status, "WAITING", waiting.error ?? "");
    const approval = waiting.approvals[0];
    app.approve(approval.id, approval.subject_hash, "APPROVED");
    writeFileSync(
      join(waiting.children![1].candidate.workspace, "value.cjs"),
      "module.exports = 2;\n",
    );
    const blocked = await app.execute(run.id);
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(app.data.approvals()[0].status, "INVALIDATED");
    assert.ok(
      waiting.children!.every((c) => !app.data.data(c.id, "publication")),
    );
  } finally {
    app.close();
  }
});

test("multi-repository child creation survives SIGKILL without orphaning or duplicating a run", async () => {
  const { app, root, workspace } = multiFixture();
  const factory = app.factory;
  const run = app.multi.create(
    workspace.id,
    { key: "ENG-11", description: "Set shared values" },
    false,
    false,
  );
  app.close();
  const driver = fork(
    fileURLToPath(
      new URL("./fixtures/multi-recovery-driver.ts", import.meta.url),
    ),
    [root, run.id],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
  );
  let stderr = "";
  driver.stderr?.on("data", (data) => (stderr += data));
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    driver.once("exit", (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.signal, "SIGKILL", stderr);
  const recovered = new Application(root, factory);
  try {
    const [existing] = recovered.data.children(run.id);
    assert.ok(existing);
    const resumed = await recovered.execute(run.id);
    assert.equal(resumed.status, "WAITING", resumed.error ?? "");
    assert.equal(resumed.children!.length, 2);
    assert.equal(resumed.children![0].id, existing.id);
    assert.equal(
      resumed.phases.find((p) => p.phase_id === "repository-a")!.attempts,
      2,
    );
  } finally {
    recovered.close();
  }
});

test("workspace CLI/API persist groups and create queued parent runs without executing Gemini", async () => {
  const { app, root, workspace } = multiFixture();
  const server = createApi(app, "workspace-token");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cli = fileURLToPath(
      new URL("../apps/cli/bin/eng.mjs", import.meta.url),
    );
    const listed = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "workspace", "list", "--data", root],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    assert.equal(listed[0].id, workspace.id);
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
    const headers = {
      Authorization: "Bearer workspace-token",
      "Content-Type": "application/json",
    };
    assert.equal((await fetch(`${url}/workspaces`)).status, 401);
    assert.equal(
      (
        (await (await fetch(`${url}/workspaces`, { headers })).json()) as any[]
      )[0].id,
      workspace.id,
    );
    const response = await fetch(`${url}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: workspace.id,
        ticket: { key: "ENG-12", description: "Shared values" },
      }),
    });
    assert.equal(response.status, 201);
    const run = (await response.json()) as any;
    assert.equal(run.status, "CREATED");
    const status = JSON.parse(
      execFileSync(process.execPath, [cli, "status", run.id, "--data", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(status.workspace.id, workspace.id);
    assert.deepEqual(status.children, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

test("failed cross-repository checks never produce a publication approval", async () => {
  const { app, workspace } = multiFixture();
  try {
    app.multi.register({
      ...workspace,
      checks: [{ ...workspace.checks[0], args: ["-e", "process.exit(1)"] }],
    });
    const run = app.multi.create(
      workspace.id,
      { key: "ENG-9", description: "Set shared values" },
      false,
      false,
    );
    const result = await app.execute(run.id);
    assert.equal(result.status, "FAILED", result.error ?? "");
    assert.equal(result.crossVerification.results[0].passed, false);
    assert.equal(result.approvals.length, 0);
    assert.ok(result.children!.every((c) => !c.publication));
  } finally {
    app.close();
  }
});

test("partial linked publication resumes without recreating children or repeating completed effects", async () => {
  const { app, workspace } = multiFixture();
  try {
    for (const id of ["pilot", "frontend"])
      app.register({
        ...app.data.repository(id),
        base: "main",
        integrations: { stash: "fixture", project: "TEST", slug: id },
      });
    const run = app.multi.create(
      workspace.id,
      { key: "ENG-10", description: "Set shared values" },
      false,
      false,
    );
    const waiting = await app.execute(run.id);
    assert.equal(waiting.status, "WAITING", waiting.error ?? "");
    const approval = waiting.approvals[0];
    app.approve(approval.id, approval.subject_hash, "APPROVED");
    let failSecond = true;
    const lookups: string[] = [];
    app.client = (() => ({
      async findPR(_project: string, slug: string) {
        lookups.push(slug);
        if (slug === "frontend" && failSecond)
          throw new Error("Temporary Stash outage");
        const child = waiting.children!.find((c) => c.repository === slug)!;
        return {
          id: slug === "pilot" ? 11 : 12,
          fromRef: { latestCommit: child.candidate.revision },
          links: { self: [{ href: `https://stash.invalid/pr/${slug}` }] },
        };
      },
    })) as any;
    const blocked = await app.execute(run.id);
    assert.equal(blocked.status, "BLOCKED", blocked.error ?? "");
    assert.equal(blocked.publication.complete, false);
    assert.equal(blocked.publication.publications.length, 1);
    failSecond = false;
    const complete = await app.execute(run.id);
    assert.equal(complete.status, "COMPLETED", complete.error ?? "");
    assert.equal(complete.children!.length, 2);
    assert.equal(complete.publication.publications.length, 2);
    assert.deepEqual(lookups, ["pilot", "frontend", "frontend"]);
  } finally {
    app.close();
  }
});

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
    app.register({
      ...profile,
      base: "main",
      integrations: { stash: "fixture", project: "P", slug: "repo" },
    });
    const run = await app.create("pilot", {
      key: "ENG-5",
      description: "Set value",
    });
    const waiting = await app.execute(run.id);
    let lookups = 0;
    app.client = () =>
      ({
        async findPR() {
          lookups++;
          return {
            id: 42,
            fromRef: { latestCommit: waiting.candidate.revision },
          };
        },
        async request() {
          throw new Error("Unexpected external write");
        },
      }) as any;
    app.approve(
      waiting.approvals[0].id,
      waiting.approvals[0].subject_hash,
      "APPROVED",
    );
    const completed = await app.execute(run.id);
    assert.equal(completed.status, "COMPLETED", completed.error ?? "");
    assert.equal(completed.publication.id, 42);
    await app.publish(run.id, app.data.repository("pilot"));
    assert.equal(lookups, 1);
  } finally {
    app.close();
  }
});

test("ambiguous publication without a remote match blocks instead of replaying", async () => {
  const { app } = productFixture();
  try {
    app.register({
      ...app.data.repository("pilot"),
      base: "main",
      integrations: { stash: "fixture", project: "P", slug: "repo" },
    });
    const run = await app.create("pilot", {
      key: "ENG-6",
      description: "Set value",
    });
    const waiting = await app.execute(run.id);
    app.approve(
      waiting.approvals[0].id,
      waiting.approvals[0].subject_hash,
      "APPROVED",
    );
    const subject = app.publicationSubject(
      run.id,
      app.data.repository("pilot"),
    );
    app.store.db
      .prepare("INSERT INTO external_actions VALUES(?,?,?,'STARTED',?,NULL)")
      .run(
        hash(JSON.stringify(subject)),
        run.id,
        "publication",
        JSON.stringify(subject),
      );
    app.client = () =>
      ({
        async findPR() {
          return null;
        },
        async request() {
          throw new Error("Must not publish");
        },
      }) as any;
    await assert.rejects(
      app.publish(run.id, app.data.repository("pilot")),
      /ambiguous/,
    );
  } finally {
    app.close();
  }
});
